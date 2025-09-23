-- Add support for encrypted messages and explicit node references.
BEGIN;
ALTER TABLE messages ADD COLUMN from_node_id TEXT;
ALTER TABLE messages ADD COLUMN from_node_num INTEGER;
ALTER TABLE messages ADD COLUMN to_node_id TEXT;
ALTER TABLE messages ADD COLUMN to_node_num INTEGER;
ALTER TABLE messages ADD COLUMN encrypted TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_from_node_id ON messages(from_node_id);
CREATE INDEX IF NOT EXISTS idx_messages_from_node_num ON messages(from_node_num);
CREATE INDEX IF NOT EXISTS idx_messages_to_node_id ON messages(to_node_id);
CREATE INDEX IF NOT EXISTS idx_messages_to_node_num ON messages(to_node_num);
COMMIT;
