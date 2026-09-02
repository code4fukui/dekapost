ALTER TABLE users ADD COLUMN total_file_count INTEGER NOT NULL DEFAULT 0 CHECK (total_file_count >= 0);

UPDATE users
SET total_file_count = (
  SELECT COUNT(*) FROM files WHERE files.owner_id = users.id
);
