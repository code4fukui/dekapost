CREATE TABLE passkeys (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
) STRICT;

CREATE INDEX passkeys_user_id ON passkeys(user_id);

CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('registration', 'authentication')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX webauthn_challenges_expires_at ON webauthn_challenges(expires_at);

ALTER TABLE users ADD COLUMN passkey_pending INTEGER NOT NULL DEFAULT 0 CHECK (passkey_pending IN (0, 1));
