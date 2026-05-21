-- AlterTable: Add Google Calendar credentials to accounts table
ALTER TABLE "accounts" ADD COLUMN "google_client_id" VARCHAR(500);
ALTER TABLE "accounts" ADD COLUMN "google_client_secret" VARCHAR(500);
ALTER TABLE "accounts" ADD COLUMN "google_redirect_uri" VARCHAR(500);
