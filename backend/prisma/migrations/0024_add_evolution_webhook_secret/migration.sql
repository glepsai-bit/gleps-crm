-- BUG-018: HMAC secret for Evolution webhook receiver
ALTER TABLE "accounts" ADD COLUMN "evolution_webhook_secret" VARCHAR(500);
