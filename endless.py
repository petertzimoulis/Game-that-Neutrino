"""Compact, resumable Endless Mode checkpoints and its separate best-run leaderboard."""
import hashlib
import hmac
import re
import time
import json
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS endless_runs (
    run_id text PRIMARY KEY, name_key text NOT NULL, checkpoint_hash text NOT NULL,
    total_correct bigint NOT NULL, total_questions bigint NOT NULL,
    total_accuracy double precision NOT NULL, coins bigint NOT NULL,
    updated_at double precision NOT NULL, record text NOT NULL
);
CREATE INDEX IF NOT EXISTS endless_player_best
ON endless_runs(name_key, total_correct DESC, total_accuracy DESC, coins DESC);
"""


class EndlessError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def validate_checkpoint(payload):
    if not isinstance(payload, dict):
        raise EndlessError(400, "Expected an Endless Mode checkpoint.")
    for field, limit in [("id", 120), ("name", 40)]:
        if not isinstance(payload.get(field), str) or not 1 <= len(payload[field].strip()) <= limit:
            raise EndlessError(400, "Enter a valid player name and run ID.")
    key = payload.get("checkpointKey")
    if not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{64}", key):
        raise EndlessError(400, "Missing the private save key for this run.")
    total, correct, coins, streak = (payload.get(field) for field in ["totalQuestions", "totalCorrect", "finalCoins", "bestStreak"])
    wallet_resets = payload.get("walletResets", 0)
    if type(wallet_resets) is not int or not 0 <= wallet_resets <= 10**12:
        raise EndlessError(400, "Invalid wallet reset counter.")
    if any(type(value) is not int for value in [total, correct, coins, streak]):
        raise EndlessError(400, "Invalid Endless Mode score.")
    if not 1 <= total <= 10**12 or not 0 <= correct <= total or not 0 <= streak <= correct or not 10 - 2 * total <= coins <= 10 + 3 * total:
        raise EndlessError(400, "Invalid Endless Mode totals.")
    if type(payload.get("isCompleted")) is not bool:
        raise EndlessError(400, "Invalid checkpoint status.")
    try:
        started = datetime.fromisoformat(payload["startedAt"].replace("Z", "+00:00"))
        if started.utcoffset() is None:
            raise ValueError()
    except (ValueError, KeyError, TypeError, AttributeError):
        raise EndlessError(400, "Invalid run start time.")
    updated = datetime.now(timezone.utc).isoformat()
    record = {"id": payload["id"].strip(), "name": payload["name"].strip(),
              "nameKey": " ".join(payload["name"].lower().split()), "mode": "endless",
              "startedAt": started.astimezone(timezone.utc).isoformat(), "updatedAt": updated,
              "completedAt": updated if payload["isCompleted"] else None,
              "totalQuestions": total, "totalCorrect": correct, "totalAccuracy": correct / total,
              "finalCoins": coins, "bestStreak": streak, "walletResets": wallet_resets, "isCompleted": payload["isCompleted"]}
    return record, hashlib.sha256(key.encode()).hexdigest()


class EndlessStore:
    def __init__(self, storage):
        self.storage = storage

    def save(self, payload):
        record, key_hash = validate_checkpoint(payload)
        store = self.storage
        with store.connect() as conn:
            # The initial insert serializes same-run writers on both backends.
            store.query(conn, """INSERT INTO endless_runs
                (run_id, name_key, checkpoint_hash, total_correct, total_questions, total_accuracy, coins, updated_at, record)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (run_id) DO NOTHING""",
                (record["id"], record["nameKey"], key_hash, record["totalCorrect"], record["totalQuestions"],
                 record["totalAccuracy"], record["finalCoins"], time.time(), json.dumps(record)))
            row = store.query(conn, "SELECT checkpoint_hash, record FROM endless_runs WHERE run_id = ?" +
                              (" FOR UPDATE" if store.postgres else ""), (record["id"],)).fetchone()
            if not hmac.compare_digest(row["checkpoint_hash"], key_hash):
                raise EndlessError(403, "This checkpoint belongs to a different run.")
            old = json.loads(row["record"])
            if old["nameKey"] != record["nameKey"] or old["startedAt"] != record["startedAt"]:
                raise EndlessError(409, "The player and start time of a saved run cannot change.")
            delta = record["totalQuestions"] - old["totalQuestions"]
            reset_delta = record["walletResets"] - old.get("walletResets", 0)
            if reset_delta < 0:
                if delta <= 0 and not record["isCompleted"]:
                    return old
                raise EndlessError(409, "The wallet was reset on another device. Resume the latest saved progress.")
            if reset_delta > 0:
                if (old["isCompleted"] or record["isCompleted"] or delta < 0 or
                    not 0 <= record["totalCorrect"] - old["totalCorrect"] <= delta or
                    record["bestStreak"] < old["bestStreak"] or
                    not 10 - 2 * delta <= record["finalCoins"] <= 10 + 3 * delta):
                    raise EndlessError(409, "Reset the wallet to 10 coins without changing lifetime progress.")
            elif delta < 0:
                if record["isCompleted"]:
                    raise EndlessError(409, "A newer checkpoint exists. Resume the latest saved progress before finishing.")
                return old
            elif delta == 0:
                if any(record[field] != old[field] for field in ["totalCorrect", "finalCoins", "bestStreak"]):
                    raise EndlessError(409, "An answered checkpoint cannot be rewritten.")
                if old["isCompleted"] or not record["isCompleted"]:
                    return old
            elif (old["isCompleted"] or not 0 <= record["totalCorrect"] - old["totalCorrect"] <= delta or
                  not -2 * delta <= record["finalCoins"] - old["finalCoins"] <= 3 * delta or
                  record["bestStreak"] < old["bestStreak"]):
                raise EndlessError(409, "This update does not continue the saved run.")
            store.query(conn, """UPDATE endless_runs SET total_correct = ?, total_questions = ?, total_accuracy = ?,
                coins = ?, updated_at = ?, record = ? WHERE run_id = ?""",
                (record["totalCorrect"], record["totalQuestions"], record["totalAccuracy"],
                 record["finalCoins"], time.time(), json.dumps(record), record["id"]))
        return record

    def leaderboard(self):
        with self.storage.connect() as conn:
            rows = self.storage.query(conn, """SELECT record FROM (
                SELECT *, row_number() OVER (PARTITION BY name_key ORDER BY
                    total_correct DESC, total_accuracy DESC, coins DESC, updated_at, run_id) AS position
                FROM endless_runs) ranked WHERE position = 1
                ORDER BY total_correct DESC, total_accuracy DESC, coins DESC, name_key""").fetchall()
        return {"players": [json.loads(row["record"]) for row in rows]}

    def best_for_player(self, name_key):
        with self.storage.connect() as conn:
            row = self.storage.query(conn, """SELECT record FROM endless_runs WHERE name_key = ?
                ORDER BY total_correct DESC, total_accuracy DESC, coins DESC, updated_at, run_id LIMIT 1""", (name_key,)).fetchone()
        return json.loads(row["record"]) if row else None
