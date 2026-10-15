CREATE TABLE IF NOT EXISTS weekly_lineups (
    cycle_start date PRIMARY KEY,
    video_ids jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
