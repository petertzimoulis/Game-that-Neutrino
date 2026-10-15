from __future__ import annotations

import csv
import json
import math
import os
import random
import sys
from datetime import date, datetime, timedelta, timezone
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo
from accounts import AccountStore, AccountError, ROUTES as ACCOUNT_ROUTES, MAX_BODY, session_cookie
from endless import EndlessStore, EndlessError


ROOT_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("NEUTRINO_DATA_DIR", str(ROOT_DIR / "data")))
GAME_STATE_EPOCH = os.environ.get("GAME_STATE_EPOCH", "")
GAME_WRITE_PATHS = {"/api/players", "/api/collaborator-players", "/api/quiz-players", "/api/quick-quiz-players", "/api/achievements", "/api/endless-players"}
FRIDAY_DB_PATH = DATA_DIR / "shared_leaderboard.json"
QUIZ_DB_PATH = DATA_DIR / "quiz_leaderboard.json"
QUICK_QUIZ_DB_PATH = DATA_DIR / "quick_quiz_40.json"
ANALYTICS_DB_PATH = DATA_DIR / "analytics_events.json"
ACHIEVEMENTS_DB_PATH = DATA_DIR / "achievements.json"
COLLABORATOR_DB_PATH = DATA_DIR / "collaborator_leaderboard.json"
ACHIEVEMENT_IDS = {
    "first-call", "hot-hand", "independent", "keen-eye", "sure-shot",
    "demo-complete", "perfect-demo", "finisher", "explorer",
    "endless-10", "endless-50", "endless-100", "endless-250",
    "endless-streak-10", "endless-correct-100",
}
DB_LOCK = Lock()
RUN_VIDEO_COUNT = 15
MAX_ANALYTICS_EVENTS = 5000
MAX_RECENT_ANALYTICS_EVENTS = 250
ROTATION_TIMEZONE = ZoneInfo("America/New_York")
FIRST_ROTATION_DATE = date(2026, 5, 1)
MANIFEST_SOURCES = [
    ("ntn_4.0_100_videos (1)", "manifest.csv"),
]
CATALOG_VIDEO_IDS: list[str] | None = None
ACCOUNT_STORES = {}


def account_store():
    path = Path(os.environ.get("ACCOUNT_DB_PATH", str(DATA_DIR / "accounts.sqlite3"))).resolve()
    with DB_LOCK:
        if path not in ACCOUNT_STORES:
            ACCOUNT_STORES[path] = AccountStore.sqlite(path)
        return ACCOUNT_STORES[path]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def local_today() -> date:
    return datetime.now(ROTATION_TIMEZONE).date()


def build_video_id(folder_name: str, file_name: str) -> str:
    return f"{folder_name}/{file_name.strip()}"


def load_catalog_video_ids() -> list[str]:
    global CATALOG_VIDEO_IDS

    if CATALOG_VIDEO_IDS is not None:
        return CATALOG_VIDEO_IDS

    video_ids: list[str] = []

    for folder_name, manifest_name in MANIFEST_SOURCES:
        manifest_path = ROOT_DIR / "videos" / folder_name / manifest_name

        with manifest_path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)

            for row in reader:
                file_name = str(row.get("video", "")).strip()

                if not file_name:
                    continue

                video_ids.append(build_video_id(folder_name, file_name))

    if not video_ids:
        raise RuntimeError("No manifest videos were found for the weekly rotation.")

    CATALOG_VIDEO_IDS = video_ids
    return CATALOG_VIDEO_IDS


def get_active_cycle_start(today: date | None = None) -> date:
    cycle_today = today or local_today()

    if cycle_today < FIRST_ROTATION_DATE:
        return FIRST_ROTATION_DATE

    days_since_friday = (cycle_today.weekday() - 4) % 7
    return cycle_today - timedelta(days=days_since_friday)


def get_active_cycle_end(cycle_start: date) -> date:
    return cycle_start + timedelta(days=6)


def build_weekly_video_ids(cycle_start: date, catalog_video_ids: list[str]) -> list[str]:
    rng = random.Random(f"game-that-neutrino-weekly-{cycle_start.isoformat()}")
    selection_size = min(RUN_VIDEO_COUNT, len(catalog_video_ids))
    return rng.sample(catalog_video_ids, selection_size)


def is_valid_active_video_ids(active_video_ids: object, catalog_video_ids: list[str]) -> bool:
    if not isinstance(active_video_ids, list):
        return False

    if len(active_video_ids) != min(RUN_VIDEO_COUNT, len(catalog_video_ids)):
        return False

    catalog_set = set(catalog_video_ids)
    return all(isinstance(video_id, str) and video_id in catalog_set for video_id in active_video_ids)


def default_db() -> dict:
    return {
        "players": [],
        "history": [],
        "updatedAt": None,
        "activeCycleStart": None,
        "activeCycleEnd": None,
        "activeVideoIds": [],
    }


def default_quiz_db() -> dict:
    return {
        "players": [],
        "history": [],
        "updatedAt": None,
    }


def default_analytics_db() -> dict:
    return {
        "events": [],
        "updatedAt": None,
    }


def load_db(path: Path, default_factory) -> dict:
    if not path.exists():
        return default_factory()

    try:
        with path.open("r", encoding="utf-8") as handle:
            loaded = json.load(handle)
    except (json.JSONDecodeError, OSError):
        return default_factory()

    if not isinstance(loaded, dict):
        return default_factory()

    return loaded


def load_friday_db() -> dict:
    loaded = load_db(FRIDAY_DB_PATH, default_db)

    players = loaded.get("players")
    history = loaded.get("history")
    updated_at = loaded.get("updatedAt")
    active_cycle_start = loaded.get("activeCycleStart")
    active_cycle_end = loaded.get("activeCycleEnd")
    active_video_ids = loaded.get("activeVideoIds")

    return {
        "players": players if isinstance(players, list) else [],
        "history": history if isinstance(history, list) else [],
        "updatedAt": updated_at if isinstance(updated_at, str) or updated_at is None else None,
        "activeCycleStart": active_cycle_start if isinstance(active_cycle_start, str) or active_cycle_start is None else None,
        "activeCycleEnd": active_cycle_end if isinstance(active_cycle_end, str) or active_cycle_end is None else None,
        "activeVideoIds": active_video_ids if isinstance(active_video_ids, list) else [],
    }


def load_quiz_db(path: Path = QUIZ_DB_PATH) -> dict:
    loaded = load_db(path, default_quiz_db)
    players = loaded.get("players")
    history = loaded.get("history")
    updated_at = loaded.get("updatedAt")

    return {
        "players": players if isinstance(players, list) else [],
        "history": history if isinstance(history, list) else [],
        "updatedAt": updated_at if isinstance(updated_at, str) or updated_at is None else None,
    }


def load_analytics_db() -> dict:
    loaded = load_db(ANALYTICS_DB_PATH, default_analytics_db)
    events = loaded.get("events")
    updated_at = loaded.get("updatedAt")

    return {
        "events": events if isinstance(events, list) else [],
        "updatedAt": updated_at if isinstance(updated_at, str) or updated_at is None else None,
    }


def normalize_db(db: dict) -> tuple[dict, bool]:
    catalog_video_ids = load_catalog_video_ids()
    cycle_start = get_active_cycle_start()
    cycle_end = get_active_cycle_end(cycle_start)
    cycle_start_iso = cycle_start.isoformat()
    cycle_end_iso = cycle_end.isoformat()

    normalized = {
        "players": db.get("players", []) if isinstance(db.get("players"), list) else [],
        "history": db.get("history", []) if isinstance(db.get("history"), list) else [],
        "updatedAt": db.get("updatedAt") if isinstance(db.get("updatedAt"), str) or db.get("updatedAt") is None else None,
        "activeCycleStart": db.get("activeCycleStart") if isinstance(db.get("activeCycleStart"), str) or db.get("activeCycleStart") is None else None,
        "activeCycleEnd": db.get("activeCycleEnd") if isinstance(db.get("activeCycleEnd"), str) or db.get("activeCycleEnd") is None else None,
        "activeVideoIds": db.get("activeVideoIds") if isinstance(db.get("activeVideoIds"), list) else [],
    }
    changed = normalized != db

    if not normalized["history"] and normalized["players"]:
        normalized["history"] = sort_history(normalized["players"])
        changed = True

    cycle_changed = normalized["activeCycleStart"] != cycle_start_iso

    if cycle_changed:
        normalized["players"] = []
        normalized["updatedAt"] = now_iso()
        normalized["activeCycleStart"] = cycle_start_iso
        normalized["activeCycleEnd"] = cycle_end_iso
        normalized["activeVideoIds"] = build_weekly_video_ids(cycle_start, catalog_video_ids)
        changed = True
    else:
        if normalized["activeCycleEnd"] != cycle_end_iso:
            normalized["activeCycleEnd"] = cycle_end_iso
            changed = True

        if not is_valid_active_video_ids(normalized["activeVideoIds"], catalog_video_ids):
            normalized["activeVideoIds"] = build_weekly_video_ids(cycle_start, catalog_video_ids)
            changed = True

    return normalized, changed


def load_current_db() -> dict:
    db = load_friday_db()
    normalized_db, changed = normalize_db(db)

    if changed:
        save_db(FRIDAY_DB_PATH, normalized_db)

    return normalized_db


def load_current_quiz_db(path: Path = QUIZ_DB_PATH) -> dict:
    db = load_quiz_db(path)
    normalized = {
        "players": db.get("players", []) if isinstance(db.get("players"), list) else [],
        "history": db.get("history", []) if isinstance(db.get("history"), list) else [],
        "updatedAt": db.get("updatedAt") if isinstance(db.get("updatedAt"), str) or db.get("updatedAt") is None else None,
    }

    if not normalized["history"] and normalized["players"]:
        normalized["history"] = sort_history(normalized["players"])

    if normalized != db:
        save_db(path, normalized)

    return normalized


def load_current_analytics_db() -> dict:
    db = load_analytics_db()
    normalized = {
        "events": db.get("events", []) if isinstance(db.get("events"), list) else [],
        "updatedAt": db.get("updatedAt") if isinstance(db.get("updatedAt"), str) or db.get("updatedAt") is None else None,
    }

    if normalized != db:
        save_db(ANALYTICS_DB_PATH, normalized)

    return normalized


def save_db(path: Path, db: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(".tmp")

    with temp_path.open("w", encoding="utf-8") as handle:
        json.dump(db, handle, indent=2)

    temp_path.replace(path)




def validate_collaborator_record(payload: dict) -> dict:
    name = payload.get("name")
    record_id = payload.get("id")
    answers = payload.get("answers")
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 40:
        raise ValueError("Enter a name of 1–40 characters")
    if not isinstance(record_id, str) or not record_id or len(record_id) > 120:
        raise ValueError("Missing run ID")
    if not isinstance(answers, list) or len(answers) != 5:
        raise ValueError("Only completed five-question collaborator runs can be submitted")
    seen = set()
    for answer in answers:
        if not isinstance(answer, dict) or not isinstance(answer.get("videoId"), str):
            raise ValueError("Invalid answer")
        if answer["videoId"] in seen or not isinstance(answer.get("choice"), str) or answer.get("choice") not in {"track", "cascade"} or not isinstance(answer.get("correct"), bool):
            raise ValueError("Each run needs five distinct answered clips")
        seen.add(answer["videoId"])
    coins = payload.get("finalCoins")
    if isinstance(coins, bool) or not isinstance(coins, (int, float)) or not math.isfinite(coins):
        raise ValueError("Invalid coin total")
    try:
        completed = datetime.fromisoformat(str(payload.get("completedAt", "")).replace("Z", "+00:00"))
        if completed.utcoffset() is None:
            raise ValueError("Completion time needs a timezone")
    except ValueError as error:
        raise ValueError("Invalid completion time") from error
    correct = sum(answer["correct"] for answer in answers)
    return {
        **payload,
        "mode": "demo",
        "name": name.strip(),
        "nameKey": " ".join(name.lower().split()),
        "completedAt": completed.astimezone(timezone.utc).isoformat(),
        "totalCorrect": correct,
        "totalQuestions": len(answers),
        "totalAccuracy": correct / len(answers),
    }


def merge_collaborator_record(db: dict, payload: dict) -> dict:
    record = validate_collaborator_record(payload)
    players = db.get("players", [])
    existing = next((player for player in players if player.get("nameKey") == record["nameKey"]), None)
    # Importing an old device score must not replace a newer shared result.
    if existing is None or existing.get("completedAt", "") <= record["completedAt"]:
        db["players"] = upsert_player(players, record, "demo")
    db["history"] = upsert_history_record(db.get("history", []), record)
    db["updatedAt"] = now_iso()
    return db


def serialize_collaborator_payload(db: dict) -> dict:
    return {
        "players": sort_players(db.get("players", []), "demo"),
        "history": sort_history(db.get("history", [])),
        "updatedAt": db.get("updatedAt"),
    }


def merge_achievement_profile(db: dict, payload: dict) -> dict:
    name = payload.get("name")
    unlocked = payload.get("unlocked")
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 80:
        raise ValueError("A player name of 1–80 characters is required")
    if not isinstance(unlocked, list) or not unlocked or len(unlocked) > len(ACHIEVEMENT_IDS):
        raise ValueError(f"Supply 1–{len(ACHIEVEMENT_IDS)} achievement IDs")
    if any(not isinstance(item, str) or item not in ACHIEVEMENT_IDS for item in unlocked):
        raise ValueError("Unknown achievement")
    key = " ".join(name.lower().split())
    profiles = db.setdefault("profiles", [])
    profile = next((item for item in profiles if item.get("nameKey") == key), None)
    if profile is None:
        profile = {"name": name.strip(), "nameKey": key, "unlocked": [], "firstEarnedAt": now_iso()}
        profiles.append(profile)
    profile["unlocked"] = sorted(set(profile["unlocked"]) | set(unlocked))
    db["updatedAt"] = now_iso()
    return db


def sort_players(players: list[dict], mode: str) -> list[dict]:
    if mode == "quiz":
        return sorted(
            players,
            key=lambda player: (
                -int(player.get("totalCorrect", 0)),
                -float(player.get("totalAccuracy", 0)),
                str(player.get("completedAt", "")),
                str(player.get("name", "")).lower(),
            ),
        )

    if mode == "quick":
        return sorted(
            players,
            key=lambda player: (
                -int(
                    player.get("finalCoins")
                    if isinstance(player.get("finalCoins"), (int, float))
                    else 10
                ),
                -float(player.get("totalAccuracy", 0)),
                str(player.get("completedAt", "")),
                str(player.get("name", "")).lower(),
            ),
        )

    return sorted(
        players,
        key=lambda player: (
            -int(player.get("finalCoins", 0)),
            -float(player.get("totalAccuracy", 0)),
            str(player.get("name", "")).lower(),
        ),
    )


def upsert_player(players: list[dict], player_record: dict, mode: str) -> list[dict]:
    name_key = str(player_record.get("nameKey", "")).strip()

    if not name_key:
        raise ValueError("Missing nameKey")

    next_players = list(players)

    for index, existing in enumerate(next_players):
        if str(existing.get("nameKey", "")).strip() == name_key:
            next_players[index] = player_record
            return sort_players(next_players, mode)

    next_players.append(player_record)
    return sort_players(next_players, mode)


def upsert_history_record(history: list[dict], player_record: dict) -> list[dict]:
    record_id = str(player_record.get("id", "")).strip()

    if not record_id:
        return list(history)

    next_history = list(history)

    for index, existing in enumerate(next_history):
        if str(existing.get("id", "")).strip() == record_id:
            next_history[index] = player_record
            return sort_history(next_history)

    next_history.append(player_record)
    return sort_history(next_history)


def sort_history(history: list[dict]) -> list[dict]:
    return sorted(
        history,
        key=lambda record: (
            str(record.get("completedAt", "")),
            str(record.get("startedAt", "")),
            str(record.get("id", "")),
        ),
    )


def append_analytics_events(existing_events: list[dict], incoming_events: list[dict]) -> list[dict]:
    next_events = list(existing_events)

    for event in incoming_events:
        if not isinstance(event, dict):
            continue

        event_type = str(event.get("type", "")).strip()
        timestamp = str(event.get("timestamp", "")).strip()

        if not event_type or not timestamp:
            continue

        next_events.append(event)

    if len(next_events) > MAX_ANALYTICS_EVENTS:
        next_events = next_events[-MAX_ANALYTICS_EVENTS:]

    return next_events


def serialize_db_payload(db: dict) -> dict:
    active_video_ids = db.get("activeVideoIds", [])

    return {
        "players": sort_players(db.get("players", []), "friday"),
        "history": sort_history(db.get("history", [])),
        "updatedAt": db.get("updatedAt"),
        "activeCycleStart": db.get("activeCycleStart"),
        "activeCycleEnd": db.get("activeCycleEnd"),
        "activeVideoIds": active_video_ids,
        "runVideoCount": len(active_video_ids),
        "catalogSize": len(load_catalog_video_ids()),
    }


def serialize_quiz_db_payload(db: dict, mode: str = "quiz") -> dict:
    return {
        "players": sort_players(db.get("players", []), mode),
        "history": sort_history(db.get("history", [])),
        "updatedAt": db.get("updatedAt"),
        "catalogSize": len(load_catalog_video_ids()),
    }


def build_analytics_summary(events: list[dict]) -> dict:
    event_counts: dict[str, int] = {}
    mode_counts: dict[str, int] = {}
    session_ids: set[str] = set()
    player_names: set[str] = set()

    for event in events:
        if not isinstance(event, dict):
            continue

        event_type = str(event.get("type", "")).strip() or "unknown"
        mode = str(event.get("mode", "")).strip() or "unknown"
        session_id = str(event.get("sessionId", "")).strip()
        player_name = str(event.get("nameKey", "")).strip()

        event_counts[event_type] = event_counts.get(event_type, 0) + 1
        mode_counts[mode] = mode_counts.get(mode, 0) + 1

        if session_id:
            session_ids.add(session_id)

        if player_name:
            player_names.add(player_name)

    sorted_counts = dict(
        sorted(event_counts.items(), key=lambda item: (-item[1], item[0])),
    )
    sorted_mode_counts = dict(
        sorted(mode_counts.items(), key=lambda item: (-item[1], item[0])),
    )

    return {
        "totalEvents": len(events),
        "uniqueSessions": len(session_ids),
        "uniquePlayers": len(player_names),
        "eventCounts": sorted_counts,
        "modeCounts": sorted_mode_counts,
    }


def serialize_analytics_payload(db: dict, full: bool = False) -> dict:
    events = db.get("events", [])

    return {
        "updatedAt": db.get("updatedAt"),
        "summary": build_analytics_summary(events),
        "recentEvents": events[-MAX_RECENT_ANALYTICS_EVENTS:],
        **({"events": events} if full else {}),
    }


class SharedLeaderboardHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        parsed_path = urlparse(self.path)

        if parsed_path.path == "/api/endless-players":
            self.respond_json(HTTPStatus.OK, EndlessStore(account_store()).leaderboard())
            return

        if parsed_path.path in ACCOUNT_ROUTES:
            self.handle_account_request()
            return

        if parsed_path.path == "/api/collaborator-players":
            with DB_LOCK:
                db = load_current_quiz_db(COLLABORATOR_DB_PATH)
            self.respond_json(HTTPStatus.OK, serialize_collaborator_payload(db))
            return

        if parsed_path.path == "/api/achievements":
            with DB_LOCK:
                db = load_db(ACHIEVEMENTS_DB_PATH, lambda: {"profiles": []})
            self.respond_json(HTTPStatus.OK, db)
            return

        if parsed_path.path == "/api/health":
            self.respond_json(
                HTTPStatus.OK,
                {
                    "status": "ok",
                    **serialize_db_payload(load_current_db()),
                },
            )
            return

        if parsed_path.path == "/api/players":
            with DB_LOCK:
                db = load_current_db()

            self.respond_json(HTTPStatus.OK, serialize_db_payload(db))
            return

        if parsed_path.path in {"/api/quiz-players", "/api/quick-quiz-players"}:
            with DB_LOCK:
                db = load_current_quiz_db(
                    QUICK_QUIZ_DB_PATH if parsed_path.path == "/api/quick-quiz-players" else QUIZ_DB_PATH,
                )

            self.respond_json(
                HTTPStatus.OK,
                serialize_quiz_db_payload(
                    db,
                    "quick" if parsed_path.path == "/api/quick-quiz-players" else "quiz",
                ),
            )
            return

        if parsed_path.path == "/api/analytics":
            with DB_LOCK:
                db = load_current_analytics_db()

            self.respond_json(HTTPStatus.OK, serialize_analytics_payload(db, parse_qs(parsed_path.query).get("view") == ["full"]))
            return

        super().do_GET()

    def do_POST(self) -> None:
        parsed_path = urlparse(self.path)

        if (GAME_STATE_EPOCH and parsed_path.path in GAME_WRITE_PATHS and
            self.headers.get("X-Neutrino-State-Epoch") != GAME_STATE_EPOCH):
            self.respond_json(HTTPStatus.CONFLICT, {"error": "The game was reset. Reload the page to start a fresh run."})
            return

        if parsed_path.path == "/api/endless-players":
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 65536:
                    raise EndlessError(400, "Invalid checkpoint size.")
                payload = json.loads(self.rfile.read(size).decode("utf-8"))
                store = EndlessStore(account_store())
                record = store.save(payload)
                self.respond_json(HTTPStatus.OK, {"record": record, "player": store.best_for_player(record["nameKey"]), "crowdStats": store.leaderboard()["crowdStats"]})
            except EndlessError as error:
                self.respond_json(error.status, {"error": str(error)})
            except (ValueError, UnicodeError):
                self.respond_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid Endless Mode checkpoint."})
            return

        if parsed_path.path in ACCOUNT_ROUTES:
            self.handle_account_request()
            return

        if parsed_path.path == "/api/collaborator-players":
            self.handle_collaborator_post()
            return

        if parsed_path.path == "/api/achievements":
            self.handle_achievement_post()
            return

        if parsed_path.path == "/api/analytics-events":
            self.handle_analytics_event_post()
            return

        if parsed_path.path not in {"/api/players", "/api/quiz-players", "/api/quick-quiz-players"}:
            self.respond_json(
                HTTPStatus.NOT_FOUND,
                {"error": "Not found"},
            )
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length) if content_length else b""

        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError:
            self.respond_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid JSON"})
            return

        if not isinstance(payload, dict):
            self.respond_json(HTTPStatus.BAD_REQUEST, {"error": "Expected an object"})
            return

        try:
            with DB_LOCK:
                is_quiz = parsed_path.path in {"/api/quiz-players", "/api/quick-quiz-players"}
                quiz_db_path = QUICK_QUIZ_DB_PATH if parsed_path.path == "/api/quick-quiz-players" else QUIZ_DB_PATH
                db = load_current_quiz_db(quiz_db_path) if is_quiz else load_current_db()

                if not is_quiz:
                    requested_cycle_start = str(payload.get("cycleStart", "")).strip()

                    if requested_cycle_start and requested_cycle_start != db.get("activeCycleStart"):
                        self.respond_json(
                            HTTPStatus.CONFLICT,
                            {
                                "error": "Weekly lineup changed. Start a fresh run for the current Friday slate.",
                                **serialize_db_payload(db),
                            },
                        )
                        return

                player_mode = (
                    "quick" if parsed_path.path == "/api/quick-quiz-players" else "quiz"
                ) if is_quiz else "friday"
                db["players"] = upsert_player(
                    db.get("players", []),
                    payload,
                    player_mode,
                )
                db["history"] = upsert_history_record(
                    db.get("history", []),
                    payload,
                )
                db["updatedAt"] = now_iso()
                save_db(quiz_db_path if is_quiz else FRIDAY_DB_PATH, db)
        except ValueError as error:
            self.respond_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        except OSError:
            self.respond_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "Could not persist shared leaderboard"},
            )
            return

        self.respond_json(
            HTTPStatus.OK,
            serialize_quiz_db_payload(
                db,
                "quick" if parsed_path.path == "/api/quick-quiz-players" else "quiz",
            ) if parsed_path.path in {"/api/quiz-players", "/api/quick-quiz-players"} else serialize_db_payload(db),
        )

    def handle_collaborator_post(self) -> None:
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 100000:
                raise ValueError("Invalid request size")
            payload = json.loads(self.rfile.read(size).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("Expected an object")
            with DB_LOCK:
                db = load_current_quiz_db(COLLABORATOR_DB_PATH)
                merge_collaborator_record(db, payload)
                save_db(COLLABORATOR_DB_PATH, db)
        except (ValueError, UnicodeDecodeError) as error:
            self.respond_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        except OSError:
            self.respond_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Could not persist collaborator score"})
            return
        self.respond_json(HTTPStatus.OK, serialize_collaborator_payload(db))

    def handle_achievement_post(self) -> None:
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 4096:
                self.respond_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid request size"})
                return
            payload = json.loads(self.rfile.read(size).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("Expected an object")
            with DB_LOCK:
                db = load_db(ACHIEVEMENTS_DB_PATH, lambda: {"profiles": []})
                merge_achievement_profile(db, payload)
                save_db(ACHIEVEMENTS_DB_PATH, db)
        except (ValueError, UnicodeDecodeError) as error:
            self.respond_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        except OSError:
            self.respond_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Could not save trophies"})
            return
        self.respond_json(HTTPStatus.OK, db)

    def handle_analytics_event_post(self) -> None:
        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length) if content_length else b""

        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError:
            self.respond_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid JSON"})
            return

        if not isinstance(payload, dict):
            self.respond_json(HTTPStatus.BAD_REQUEST, {"error": "Expected an object"})
            return

        events = payload.get("events")

        if not isinstance(events, list):
            self.respond_json(HTTPStatus.BAD_REQUEST, {"error": "Expected events array"})
            return

        try:
            with DB_LOCK:
                db = load_current_analytics_db()
                db["events"] = append_analytics_events(db.get("events", []), events)
                db["updatedAt"] = now_iso()
                save_db(ANALYTICS_DB_PATH, db)
        except OSError:
            self.respond_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "Could not persist analytics events"},
            )
            return

        self.respond_json(
            HTTPStatus.OK,
            serialize_analytics_payload(db),
        )

    def send_head(self):
        # Also covers HEAD, encoded paths, directory indexes and symlinks.
        target = Path(self.translate_path(self.path)).resolve()
        root = Path(self.directory).resolve()
        account_path = Path(os.environ.get("ACCOUNT_DB_PATH", str(DATA_DIR / "accounts.sqlite3"))).resolve()
        if (not target.is_relative_to(root) or target.is_relative_to(DATA_DIR.resolve()) or
            str(target).startswith(str(account_path)) or
            any(part.startswith(".") for part in target.relative_to(root).parts)):
            self.send_error(HTTPStatus.FORBIDDEN)
            return None
        return super().send_head()

    def handle_account_request(self):
        try:
            payload = None
            if self.command == "POST":
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= MAX_BODY:
                    raise AccountError(413, "Account request is too large or empty.")
                if self.headers.get_content_type() != "application/json":
                    raise AccountError(415, "Send account requests as JSON.")
                payload = json.loads(self.rfile.read(size).decode("utf-8"))
            result, token = account_store().handle(self.command, urlparse(self.path).path, payload,
                                                  self.headers, self.client_address[0])
            headers = {"Cache-Control": "private, no-store"}
            if token is not None:
                hostname = urlparse("//" + self.headers.get("Host", "")).hostname
                headers["Set-Cookie"] = session_cookie(token, secure=hostname not in {"localhost", "127.0.0.1", "::1"})
            self.respond_json(HTTPStatus.OK, result, headers)
        except AccountError as error:
            headers = {"Cache-Control": "private, no-store"}
            if error.status == 429:
                headers["Retry-After"] = "900"
            self.respond_json(error.status, error.payload, headers)
        except (ValueError, UnicodeError):
            self.respond_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid account request."})

    def respond_json(self, status: HTTPStatus, payload: dict, headers=None) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)


def serve() -> None:
    port = int(os.environ.get("PORT", "8000"))
    host = os.environ.get("HOST", "0.0.0.0")

    handler = partial(SharedLeaderboardHandler, directory=str(ROOT_DIR))
    server = ThreadingHTTPServer((host, port), handler)

    print(f"Serving shared neutrino app on http://{host}:{port}/")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    try:
        serve()
    except OSError as error:
        print(f"Could not start server: {error}", file=sys.stderr)
        sys.exit(1)
