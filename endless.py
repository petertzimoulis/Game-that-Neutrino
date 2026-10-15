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
    if not 1 <= total <= 10**12 or not 0 <= correct <= total or not 0 <= streak <= correct or not 10 - 2 * total <= coins <= 10 + 5 * total:
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
    for field, maximum in [("leaderboardBaseQuestions", total), ("leaderboardBaseCorrect", correct)]:
        value = payload.get(field, 0)
        if type(value) is not int or not 0 <= value <= maximum:
            raise EndlessError(400, "Invalid leaderboard reset totals.")
        record[field] = value
    if record["leaderboardBaseCorrect"] > record["leaderboardBaseQuestions"] or correct - record["leaderboardBaseCorrect"] > total - record["leaderboardBaseQuestions"]:
        raise EndlessError(400, "Invalid leaderboard reset accuracy.")
    stats = payload.get("videoStats", {})
    if not isinstance(stats, dict) or len(stats) > 100:
        raise EndlessError(400, "Invalid video vote totals.")
    counted = 0
    for video_id, counts in stats.items():
        if not isinstance(video_id, str) or not 1 <= len(video_id) <= 300 or not isinstance(counts, dict):
            raise EndlessError(400, "Invalid video vote totals.")
        values = [counts.get(field) for field in ["trackCount", "cascadeCount", "correctCount"]]
        if any(type(value) is not int or not 0 <= value <= total for value in values) or values[2] > values[0] + values[1]:
            raise EndlessError(400, "Invalid video vote totals.")
        counted += values[0] + values[1]
    if counted > total or sum(counts["correctCount"] for counts in stats.values()) > correct:
        raise EndlessError(400, "Video votes exceed answered questions.")
    record["videoStats"] = {video_id: {field: counts[field] for field in ["trackCount", "cascadeCount", "correctCount"]} for video_id, counts in stats.items()}
    if wallet_resets:
        if "leaderboardBaseQuestions" not in payload:
            record["leaderboardBaseQuestions"], record["leaderboardBaseCorrect"] = total, correct
        record["leaderboardResetAt"] = updated
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
            if not reset_delta:
                for field in ["leaderboardBaseQuestions", "leaderboardBaseCorrect"]:
                    if field not in payload:
                        record[field] = old.get(field, 0)
                if old.get("leaderboardResetAt"):
                    record["leaderboardResetAt"] = old["leaderboardResetAt"]
            if reset_delta < 0:
                if delta <= 0 and not record["isCompleted"]:
                    return old
                raise EndlessError(409, "The wallet was reset on another device. Resume the latest saved progress.")
            if reset_delta > 0:
                if (old["isCompleted"] or record["isCompleted"] or delta < 0 or
                    not 0 <= record["totalCorrect"] - old["totalCorrect"] <= delta or
                    record["bestStreak"] < old["bestStreak"] or
                    not 10 - 2 * (record["totalQuestions"] - record["leaderboardBaseQuestions"]) <= record["finalCoins"] <= 10 + 5 * (record["totalQuestions"] - record["leaderboardBaseQuestions"])):
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
                  not -2 * delta <= record["finalCoins"] - old["finalCoins"] <= 5 * delta or
                  record["bestStreak"] < old["bestStreak"]):
                raise EndlessError(409, "This update does not continue the saved run.")
            if reset_delta > 0:
                if (record["leaderboardBaseQuestions"] < old["totalQuestions"] or
                    record["leaderboardBaseCorrect"] < old["totalCorrect"]):
                    raise EndlessError(409, "A reset cannot restore an older leaderboard score.")
            elif any(record.get(field, 0) != old.get(field, 0) for field in ["leaderboardBaseQuestions", "leaderboardBaseCorrect"]):
                raise EndlessError(409, "Reset the wallet before clearing the leaderboard score.")
            for video_id, counts in old.get("videoStats", {}).items():
                if any(record["videoStats"].get(video_id, {}).get(field, 0) < value for field, value in counts.items()):
                    raise EndlessError(409, "Recorded votes cannot be removed.")
            old_count = sum(v["trackCount"] + v["cascadeCount"] for v in old.get("videoStats", {}).values())
            new_count = sum(v["trackCount"] + v["cascadeCount"] for v in record["videoStats"].values())
            if new_count - old_count > delta:
                raise EndlessError(409, "Votes must continue the answered questions.")
            store.query(conn, """UPDATE endless_runs SET total_correct = ?, total_questions = ?, total_accuracy = ?,
                coins = ?, updated_at = ?, record = ? WHERE run_id = ?""",
                (record["totalCorrect"], record["totalQuestions"], record["totalAccuracy"],
                 record["finalCoins"], time.time(), json.dumps(record), record["id"]))
        return record

    def leaderboard(self):
        with self.storage.connect() as conn:
            rows = self.storage.query(conn, "SELECT record FROM endless_runs").fetchall()
        records = [json.loads(row["record"]) for row in rows]
        resets = {}
        crowd = {}
        for record in records:
            if record.get("leaderboardResetAt", "") > resets.get(record["nameKey"], {}).get("leaderboardResetAt", ""):
                resets[record["nameKey"]] = record
            for video_id, counts in record.get("videoStats", {}).items():
                combined = crowd.setdefault(video_id, {"trackCount":0, "cascadeCount":0, "correctCount":0})
                for field in combined:
                    combined[field] += counts[field]
        best = {}
        def rank(record):
            questions = record["totalQuestions"] - record.get("leaderboardBaseQuestions", 0)
            correct = record["totalCorrect"] - record.get("leaderboardBaseCorrect", 0)
            return (-correct, -(correct / questions if questions else 0), -record["finalCoins"], record["nameKey"], record["id"])
        for record in records:
            reset = resets.get(record["nameKey"])
            if reset and record["id"] != reset["id"] and record["startedAt"] <= reset["leaderboardResetAt"]:
                continue
            if record["totalQuestions"] <= record.get("leaderboardBaseQuestions", 0):
                continue
            old = best.get(record["nameKey"])
            if not old or rank(record) < rank(old):
                best[record["nameKey"]] = record
        return {"players": sorted(best.values(), key=rank), "crowdStats":crowd, "history":records}

    def best_for_player(self, name_key):
        return next((record for record in self.leaderboard()["players"] if record["nameKey"] == name_key), None)
