CREATE TABLE IF NOT EXISTS runs (
    mode text NOT NULL CHECK (mode IN ('demo', 'friday', 'quiz', 'quick')),
    run_id text NOT NULL,
    name_key text NOT NULL,
    completed_at timestamptz NOT NULL,
    cycle_start date,
    is_seed boolean NOT NULL DEFAULT false,
    record jsonb NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (mode, run_id)
);
CREATE INDEX IF NOT EXISTS runs_latest ON runs (mode, name_key, completed_at DESC, run_id DESC);
CREATE INDEX IF NOT EXISTS runs_weekly ON runs (mode, cycle_start, name_key, completed_at DESC);
CREATE INDEX IF NOT EXISTS runs_history ON runs (mode, completed_at, run_id);

CREATE TABLE IF NOT EXISTS achievement_profiles (
    name_key text PRIMARY KEY,
    name text NOT NULL,
    first_earned_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS achievements (
    name_key text NOT NULL REFERENCES achievement_profiles(name_key),
    achievement_id text NOT NULL,
    earned_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (name_key, achievement_id)
);
CREATE TABLE IF NOT EXISTS analytics_events (
    event_id text PRIMARY KEY,
    event_type text NOT NULL,
    mode text NOT NULL,
    session_id text,
    name_key text,
    occurred_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    event jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS events_recent ON analytics_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_retention ON analytics_events (received_at);
