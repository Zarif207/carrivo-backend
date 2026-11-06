import { z } from "zod";
import { idParams } from "../../utils/commonValidation.js";
import { booleanQuery, optionalQuery, paginationQueryShape } from "../../utils/pagination.js";

const listMine = z.object({
  query: z.strictObject({
    page: paginationQueryShape.page,
    limit: paginationQueryShape.limit,
    sortOrder: paginationQueryShape.sortOrder,
    /** true = unread only, false = read only, omitted = all. */
    unread: optionalQuery(booleanQuery),
  }),
});

const byId = z.object({ params: idParams });

export const NotificationValidation = { listMine, byId };

export type MyNotificationsQuery = z.infer<typeof listMine>["query"];
