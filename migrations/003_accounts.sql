CREATE TABLE IF NOT EXISTS auth_accounts (
    id text PRIMARY KEY,
    username text NOT NULL,
    username_key text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    progress text NOT NULL DEFAULT '{}',
    revision integer NOT NULL DEFAULT 0,
    updated_at double precision NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash text PRIMARY KEY,
    account_id text NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
    expires_at double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
CREATE TABLE IF NOT EXISTS auth_limits (
    key text PRIMARY KEY,
    hits integer NOT NULL,
    until double precision NOT NULL
);
