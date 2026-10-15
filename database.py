"""PostgreSQL persistence. Each run/event/trophy has its own unique record."""
from __future__ import annotations

import os
from threading import Lock

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

import server as rules


class Store:
    def __init__(self, url=None):
        self.url = url or os.environ.get("DATABASE_URL")
        if not self.url:
            raise RuntimeError("Set DATABASE_URL to the PostgreSQL database connection string")
        self._pool = None
        self._lock = Lock()

    @property
    def pool(self):
        # Gunicorn forks first. Never share an open connection across processes.
        with self._lock:
            if self._pool is None:
                self._pool = ConnectionPool(
                    self.url, min_size=1, max_size=int(os.environ.get("DB_POOL_SIZE", "8")),
                    timeout=5, max_waiting=64, kwargs={"row_factory": dict_row,
                        "options": "-c statement_timeout=10000 -c lock_timeout=5000"},
                    open=True,
                )
        return self._pool

    def close(self):
        if self._pool:
            self._pool.close()

    def ready(self):
        with self.pool.connection() as conn:
            conn.execute("SELECT 1 FROM runs LIMIT 1")

    def save_run(self, mode, record):
        with self.pool.connection() as conn:
            conn.execute(
                """INSERT INTO runs (mode, run_id, name_key, completed_at, cycle_start, is_seed, record)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (mode, run_id) DO NOTHING""",
                (mode, record["id"], record["nameKey"], record["completedAt"],
                 record.get("cycleStart") if mode == "friday" else None,
                 bool(record.get("isSeedData", False)), Jsonb(record)),
            )
            # Retries return the original accepted result, even if a client changes its body.
            saved = conn.execute("SELECT record FROM runs WHERE mode = %s AND run_id = %s",
                                 (mode, record["id"])).fetchone()["record"]
            # Return the latest result for this player, so importing an older run cannot
            # replace their newer leaderboard entry in the submitting browser either.
            latest = conn.execute(
                """SELECT record FROM runs WHERE mode = %s AND name_key = %s
                   AND (%s::date IS NULL OR cycle_start = %s::date)
                   ORDER BY completed_at DESC, run_id DESC LIMIT 1""",
                (mode, saved["nameKey"], saved.get("cycleStart") if mode == "friday" else None,
                 saved.get("cycleStart") if mode == "friday" else None),
            ).fetchone()["record"]
        return {"partial": True, "players": [latest], "history": [saved], "updatedAt": rules.now_iso()}

    def leaderboard(self, mode, full=False):
        cycle = rules.get_active_cycle_start().isoformat() if mode == "friday" else None
        with self.pool.connection() as conn:
            rows = conn.execute(
                """SELECT DISTINCT ON (name_key) record FROM runs
                   WHERE mode = %s AND (%s::date IS NULL OR cycle_start = %s::date)
                   ORDER BY name_key, completed_at DESC, run_id DESC""", (mode, cycle, cycle),
            ).fetchall()
            # Reports explicitly request history in separate, bounded pages.
            updated = conn.execute("SELECT max(received_at) AS updated FROM runs WHERE mode = %s", (mode,)).fetchone()["updated"]
            crowd = self.crowd_counts(conn, mode, cycle)
            schedule = self.schedule(conn) if mode == "friday" else None
        players = rules.sort_players([row["record"] for row in rows], mode)
        if not full:
            fields = {"id", "mode", "name", "nameKey", "completedAt", "finalCoins", "totalCorrect",
                      "totalQuestions", "totalAccuracy", "sectionStats", "isSeedData"}
            players = [{**{key: value for key, value in player.items() if key in fields}, "answers": []} for player in players]
        payload = {"players": players, "updatedAt": updated.isoformat() if updated else None,
                   "crowdStats": crowd, "catalogSize": len(rules.load_catalog_video_ids())}
        if mode == "friday":
            payload.update(schedule)
        return payload

    def schedule(self, conn=None):
        if conn is None:
            with self.pool.connection() as connection:
                return self.schedule(connection)
        start = rules.get_active_cycle_start()
        catalog = rules.load_catalog_video_ids()
        row = conn.execute("SELECT video_ids FROM weekly_lineups WHERE cycle_start = %s", (start,)).fetchone()
        if row is None:
            ids = rules.build_weekly_video_ids(start, catalog)
            conn.execute("INSERT INTO weekly_lineups (cycle_start, video_ids) VALUES (%s, %s) ON CONFLICT DO NOTHING", (start, Jsonb(ids)))
            row = conn.execute("SELECT video_ids FROM weekly_lineups WHERE cycle_start = %s", (start,)).fetchone()
        if not rules.is_valid_active_video_ids(row["video_ids"], catalog):
            # A catalog replacement can retire clips during an existing weekly cycle.
            ids = rules.build_weekly_video_ids(start, catalog)
            conn.execute("UPDATE weekly_lineups SET video_ids = %s WHERE cycle_start = %s AND video_ids = %s",
                         (Jsonb(ids), start, Jsonb(row["video_ids"])))
            row = conn.execute("SELECT video_ids FROM weekly_lineups WHERE cycle_start = %s", (start,)).fetchone()
        ids = row["video_ids"]
        return {"activeCycleStart": start.isoformat(), "activeCycleEnd": rules.get_active_cycle_end(start).isoformat(),
                "activeVideoIds": ids, "runVideoCount": len(ids)}

    @staticmethod
    def crowd_counts(conn, mode, cycle):
        if mode == "demo":
            # The collaborator game uses unique historical runs from every mode.
            source = "SELECT DISTINCT ON (run_id) record FROM runs WHERE NOT is_seed ORDER BY run_id, mode"
            params = ()
        else:
            source = """SELECT DISTINCT ON (name_key) record FROM runs
                        WHERE mode = %s AND (%s::date IS NULL OR cycle_start = %s::date)
                        ORDER BY name_key, completed_at DESC, run_id DESC"""
            params = (mode, cycle, cycle)
        rows = conn.execute(
            f"""WITH selected AS ({source})
                SELECT answer->>'videoId' AS video_id,
                    count(*) FILTER (WHERE answer->>'choice' = 'track') AS track,
                    count(*) FILTER (WHERE answer->>'choice' = 'cascade') AS cascade,
                    count(*) FILTER (WHERE answer->>'correct' = 'true') AS correct
                FROM selected CROSS JOIN LATERAL jsonb_array_elements(record->'answers') AS answer
                WHERE answer->>'choice' IN ('track', 'cascade') GROUP BY answer->>'videoId'""", params,
        ).fetchall()
        return {row["video_id"]: {"trackCount": row["track"], "cascadeCount": row["cascade"], "correctCount": row["correct"]} for row in rows}

    def history(self, mode, after=None, limit=500):
        params = [mode]
        condition = ""
        if after:
            condition = " AND (completed_at, run_id) > (%s::timestamptz, %s)"
            params.extend(after)
        params.append(limit + 1)
        with self.pool.connection() as conn:
            rows = conn.execute(
                "SELECT record, completed_at, run_id FROM runs WHERE mode = %s" + condition +
                " ORDER BY completed_at, run_id LIMIT %s", params,
            ).fetchall()
        more = len(rows) > limit
        rows = rows[:limit]
        return {"history": [row["record"] for row in rows], "nextCursor":
                [rows[-1]["completed_at"].isoformat(), rows[-1]["run_id"]] if more else None}

    def save_achievements(self, payload):
        validated = rules.merge_achievement_profile({"profiles": []}, payload)["profiles"][0]
        key = validated["nameKey"]
        with self.pool.connection() as conn:
            conn.execute(
                """INSERT INTO achievement_profiles (name_key, name) VALUES (%s, %s)
                   ON CONFLICT (name_key) DO UPDATE SET updated_at = now()""", (key, validated["name"]),
            )
            with conn.cursor() as cursor:
                cursor.executemany("INSERT INTO achievements (name_key, achievement_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                                   [(key, item) for item in validated["unlocked"]])
            profiles = self._profiles(conn, key)
        return {"partial": True, "profiles": profiles, "updatedAt": rules.now_iso()}

    @staticmethod
    def _profiles(conn, key=None):
        rows = conn.execute(
            """SELECT p.name_key, p.name, p.first_earned_at, array_agg(a.achievement_id ORDER BY a.achievement_id) AS unlocked
               FROM achievement_profiles p JOIN achievements a USING (name_key)""" +
            (" WHERE p.name_key = %s" if key else "") +
            " GROUP BY p.name_key, p.name, p.first_earned_at ORDER BY p.name_key", (key,) if key else (),
        ).fetchall()
        return [{"name": row["name"], "nameKey": row["name_key"], "unlocked": row["unlocked"],
                 "firstEarnedAt": row["first_earned_at"].isoformat()} for row in rows]

    def achievements(self):
        with self.pool.connection() as conn:
            return {"profiles": self._profiles(conn)}

    def save_events(self, events):
        with self.pool.connection() as conn:
            with conn.cursor() as cursor:
                cursor.executemany(
                    """INSERT INTO analytics_events (event_id, event_type, mode, session_id, name_key, occurred_at, event)
                       VALUES (%s, %s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING""",
                    [(event["id"], event["type"], event.get("mode") or "unknown", event.get("sessionId"),
                      event.get("nameKey"), event["timestamp"], Jsonb(event)) for event in events],
                )
        return {"accepted": len(events)}

    def analytics(self, full=False):
        with self.pool.connection() as conn:
            # Preserve the existing dashboard's rolling 5,000-event summary.
            rows = conn.execute("SELECT event FROM analytics_events ORDER BY occurred_at DESC, event_id DESC LIMIT 5000").fetchall()
        events = [row["event"] for row in reversed(rows)]
        return rules.serialize_analytics_payload({"events": events, "updatedAt": rules.now_iso()}, full=full)
