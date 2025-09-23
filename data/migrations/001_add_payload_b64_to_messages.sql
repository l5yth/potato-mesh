-- Add encrypted payload storage for messages.
ALTER TABLE messages ADD COLUMN payload_b64 TEXT;
