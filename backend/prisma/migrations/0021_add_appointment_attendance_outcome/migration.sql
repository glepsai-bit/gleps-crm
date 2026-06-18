-- T-017: Human-in-the-loop attendance + outcome em calendar_events
-- Enums
DO $$ BEGIN
  CREATE TYPE "AttendanceStatus" AS ENUM ('PENDING', 'ATTENDED', 'NO_SHOW', 'RESCHEDULED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "AppointmentOutcome" AS ENUM ('PENDING', 'CLOSED', 'CONSIDERING', 'NOT_INTERESTED', 'RETURN_REQUESTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Colunas
ALTER TABLE "calendar_events"
  ADD COLUMN IF NOT EXISTS "attendance_status"    "AttendanceStatus"   DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "attendance_marked_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "attendance_marked_by" UUID,
  ADD COLUMN IF NOT EXISTS "outcome"              "AppointmentOutcome" DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "outcome_value"        DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "outcome_notes"        TEXT,
  ADD COLUMN IF NOT EXISTS "outcome_marked_at"    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "outcome_marked_by"    UUID;

-- Indexes p/ pending-status queries
CREATE INDEX IF NOT EXISTS "calendar_events_account_id_attendance_status_idx"
  ON "calendar_events" ("account_id", "attendance_status");

CREATE INDEX IF NOT EXISTS "calendar_events_account_id_outcome_idx"
  ON "calendar_events" ("account_id", "outcome");
