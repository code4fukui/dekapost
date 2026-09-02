ALTER TABLE files ADD COLUMN expires_at TEXT;

UPDATE files
SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+7 days')
WHERE expires_at IS NULL;

CREATE INDEX files_expires_at ON files(expires_at);
