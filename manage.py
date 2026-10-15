"""Explicit schema upgrades, JSON import, and telemetry retention for independent hosting."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from database import Store
from production import timestamp, validate_events
import server as rules

ROOT = Path(__file__).resolve().parent


def migrate(url=None):
    with psycopg.connect(url or os.environ["DATABASE_URL"]) as conn:
        # Serialize deploy commands without adding locks to ordinary game requests.
        conn.execute("SELECT pg_advisory_xact_lock(704150015)")
        conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())")
        applied = dict(conn.execute("SELECT name, checksum FROM schema_migrations").fetchall())
        for path in sorted((ROOT / "migrations").glob("*.sql")):
            sql = path.read_text()
            checksum = hashlib.sha256(sql.encode()).hexdigest()
            if path.name in applied:
                if applied[path.name] != checksum:
                    raise RuntimeError(f"Previously applied migration was changed: {path.name}")
                continue
            conn.execute(sql)
            conn.execute("INSERT INTO schema_migrations (name, checksum) VALUES (%s, %s)", (path.name, checksum))
            print(f"Applied {path.name}")


def import_json(store, folder):
    counts = {"runs": 0, "profiles": 0, "events": 0}
    sources = {"demo": "collaborator_leaderboard.json", "friday": "shared_leaderboard.json",
               "quiz": "quiz_leaderboard.json", "quick": "quick_quiz_40.json"}
    for mode, name in sources.items():
        path = folder / name
        if not path.exists():
            continue
        data = json.loads(path.read_text())
        if mode == "friday" and data.get("activeCycleStart"):
            ids = data.get("activeVideoIds")
            if rules.is_valid_active_video_ids(ids, rules.load_catalog_video_ids()):
                with store.pool.connection() as conn:
                    conn.execute("INSERT INTO weekly_lineups (cycle_start, video_ids) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                                 (data["activeCycleStart"], Jsonb(ids)))
        records = {row["id"]: row for row in [*data.get("players", []), *data.get("history", [])]}
        for record in records.values():
            # Preserve older run lengths and historical cycles rather than applying
            # today's gameplay validation to a research archive.
            record = {**record, "mode": mode, "nameKey": " ".join(record["name"].lower().split()),
                      "completedAt": timestamp(record["completedAt"])}
            if mode == "friday" and not record.get("cycleStart"):
                record["cycleStart"] = data.get("activeCycleStart")
            if not isinstance(record.get("answers"), list):
                raise ValueError(f"Missing answers in {name}, record {record['id']}")
            store.save_run(mode, record)
            counts["runs"] += 1
    path = folder / "achievements.json"
    if path.exists():
        for profile in json.loads(path.read_text()).get("profiles", []):
            if profile.get("unlocked"):
                store.save_achievements(profile)
                if profile.get("firstEarnedAt"):
                    with store.pool.connection() as conn:
                        conn.execute(
                            "UPDATE achievement_profiles SET first_earned_at = least(first_earned_at, %s::timestamptz) WHERE name_key = %s",
                            (timestamp(profile["firstEarnedAt"]), " ".join(profile["name"].lower().split())),
                        )
                counts["profiles"] += 1
    path = folder / "analytics_events.json"
    if path.exists():
        events = json.loads(path.read_text()).get("events", [])
        for offset in range(0, len(events), 100):
            store.save_events(validate_events({"events": events[offset:offset + 100]}))
            counts["events"] += len(events[offset:offset + 100])
    # Unique keys make rerunning an interrupted import safe.
    print(json.dumps({"processed": counts, "duplicates": "kept once by database constraints"}))
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("migrate")
    importer = commands.add_parser("import-json")
    importer.add_argument("--directory", type=Path, default=ROOT / "data")
    prune = commands.add_parser("prune-events")
    prune.add_argument("--days", type=int, default=90)
    args = parser.parse_args()
    if args.command == "migrate":
        migrate()
        return
    store = Store()
    try:
        if args.command == "import-json":
            import_json(store, args.directory)
        elif args.command == "prune-events":
            if args.days < 1:
                parser.error("--days must be at least 1")
            with store.pool.connection() as conn:
                result = conn.execute("DELETE FROM analytics_events WHERE received_at < now() - make_interval(days => %s)", (args.days,))
                print(f"Pruned {result.rowcount} old events; scores and achievements are retained.")
    finally:
        store.close()


if __name__ == "__main__":
    main()
