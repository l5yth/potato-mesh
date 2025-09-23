-- Add support for encrypted messages to the existing schema.
BEGIN;
ALTER TABLE messages ADD COLUMN encrypted TEXT;
COMMIT;
