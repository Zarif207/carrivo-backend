import { z } from "zod";
import type { PaginationMeta } from "../types/response.types.js";

export const DEFAULT_PAGE_LIMIT = 10;
export const MAX_PAGE_LIMIT = 100;

export type SortOrder = "asc" | "desc";

/** Treats `?key=` (empty string) as "not provided" so optional filters stay optional. */
export const optionalQuery = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

/** `?flag=true|false` as a real boolean (z.coerce.boolean would turn "false" into true). */
export const booleanQuery = z.enum(["true", "false"]).transform((value) => value === "true");

/**
 * Common list query keys. Each module spreads this into its own strict query
 * schema and adds `sortBy` as a z.enum of whitelisted fields plus its filters.
 */
export const paginationQueryShape = {
  page: optionalQuery(z.coerce.number().int().min(1)).transform((v) => v ?? 1),
  limit: optionalQuery(z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT)).transform(
    (v) => v ?? DEFAULT_PAGE_LIMIT,
  ),
  sortOrder: optionalQuery(z.enum(["asc", "desc"])).transform((v): SortOrder => v ?? "desc"),
  searchTerm: optionalQuery(z.string().trim().min(1).max(100)),
};

/** Whitelisted sortBy: a z.enum of allowed fields with a default. */
export const sortByQuery = <const T extends readonly [string, ...string[]]>(
  fields: T,
  fallback: T[number],
) => optionalQuery(z.enum(fields)).transform((v): T[number] => v ?? fallback);

export interface PaginationQuery {
  page: number;
  limit: number;
}

export const getSkipTake = ({ page, limit }: PaginationQuery): { skip: number; take: number } => ({
  skip: (page - 1) * limit,
  take: limit,
});

/**
 * `{ [sortBy]: sortOrder }` plus an `id` tiebreaker so pages stay stable when the
 * sort column has duplicates. `sortBy` is already whitelisted by the Zod enum.
 */
export const buildOrderBy = <K extends string>(
  sortBy: K,
  sortOrder: SortOrder,
): [Partial<Record<K, SortOrder>>, { id: SortOrder }] => {
  const primary: Partial<Record<K, SortOrder>> = {};
  primary[sortBy] = sortOrder;
  return [primary, { id: sortOrder }];
};

export const buildMeta = ({ page, limit }: PaginationQuery, total: number): PaginationMeta => ({
  page,
  limit,
  total,
  totalPages: Math.ceil(total / limit),
});

export interface Paginated<T> {
  data: T[];
  meta: PaginationMeta;
}
