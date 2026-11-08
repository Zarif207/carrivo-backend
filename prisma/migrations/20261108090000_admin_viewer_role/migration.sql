-- Read-only admin role. Only the seed creates ADMIN_VIEWER accounts; the API never grants it.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ADMIN_VIEWER';
