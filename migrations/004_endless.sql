CREATE TABLE IF NOT EXISTS endless_runs (
    run_id text PRIMARY KEY,
    name_key text NOT NULL,
    checkpoint_hash text NOT NULL,
    total_correct bigint NOT NULL,
    total_questions bigint NOT NULL,
    total_accuracy double precision NOT NULL,
    coins bigint NOT NULL,
    updated_at double precision NOT NULL,
    record text NOT NULL
);
CREATE INDEX IF NOT EXISTS endless_player_best
ON endless_runs(name_key, total_correct DESC, total_accuracy DESC, coins DESC);
