/*
  Warnings:

  - The values [ADMINISTRATOR] on the enum `UserType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "UserType_new" AS ENUM ('ADMINISTRADOR', 'FISCAL');
ALTER TABLE "users" ALTER COLUMN "user_type" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "user_type" TYPE "UserType_new" USING ("user_type"::text::"UserType_new");
ALTER TYPE "UserType" RENAME TO "UserType_old";
ALTER TYPE "UserType_new" RENAME TO "UserType";
DROP TYPE "UserType_old";
ALTER TABLE "users" ALTER COLUMN "user_type" SET DEFAULT 'FISCAL';
COMMIT;
