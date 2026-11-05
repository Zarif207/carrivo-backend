export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface SuccessResponse<T> {
  success: true;
  message: string;
  data: T;
  meta?: PaginationMeta;
}

export interface ErrorDetail {
  path: string;
  message: string;
}

export interface ErrorResponse {
  success: false;
  message: string;
  errors: ErrorDetail[];
  stack?: string;
}

/** Normalized error produced by each error mapper in src/app/errors. */
export interface NormalizedError {
  statusCode: number;
  message: string;
  errors: ErrorDetail[];
}
