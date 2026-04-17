from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.parse import urlparse


ROOT_DIR = Path(__file__).resolve().parent
DATA_DIR = ROOT_DIR / "data"
DB_PATH = DATA_DIR / "shared_leaderboard.json"
DB_LOCK = Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def default_db() -> dict:
    return {
        "players": [],
        "updatedAt": None,
    }


def load_db() -> dict:
    if not DB_PATH.exists():
        return default_db()

    try:
        with DB_PATH.open("r", encoding="utf-8") as handle:
            loaded = json.load(handle)
    except (json.JSONDecodeError, OSError):
        return default_db()

    if not isinstance(loaded, dict):
        return default_db()

    players = loaded.get("players")
    updated_at = loaded.get("updatedAt")

    return {
        "players": players if isinstance(players, list) else [],
        "updatedAt": updated_at if isinstance(updated_at, str) or updated_at is None else None,
    }


def save_db(db: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp_path = DB_PATH.with_suffix(".tmp")

    with temp_path.open("w", encoding="utf-8") as handle:
        json.dump(db, handle, indent=2)

    temp_path.replace(DB_PATH)


def sort_players(players: list[dict]) -> list[dict]:
    return sorted(
        players,
        key=lambda player: (
            -int(player.get("finalCoins", 0)),
            -float(player.get("totalAccuracy", 0)),
            str(player.get("name", "")).lower(),
        ),
    )


def upsert_player(players: list[dict], player_record: dict) -> list[dict]:
    name_key = str(player_record.get("nameKey", "")).strip()

    if not name_key:
        raise ValueError("Missing nameKey")

    next_players = list(players)

    for index, existing in enumerate(next_players):
        if str(existing.get("nameKey", "")).strip() == name_key:
            next_players[index] = player_record
            return sort_players(next_players)

    next_players.append(player_record)
    return sort_players(next_players)


class SharedLeaderboardHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        parsed_path = urlparse(self.path)

        if parsed_path.path == "/api/health":
            self.respond_json(
                HTTPStatus.OK,
                {
                    "status": "ok",
                    "updatedAt": load_db().get("updatedAt"),
                },
            )
            return

        if parsed_path.path == "/api/players":
            with DB_LOCK:
                db = load_db()

            self.respond_json(
                HTTPStatus.OK,
                {
                    "players": sort_players(db.get("players", [])),
                    "updatedAt": db.get("updatedAt"),
                },
            )
            return

        super().do_GET()

    def do_POST(self) -> None:
        parsed_path = urlparse(self.path)

        if parsed_path.path != "/api/players":
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
                db = load_db()
                db["players"] = upsert_player(db.get("players", []), payload)
                db["updatedAt"] = now_iso()
                save_db(db)
                players = db["players"]
                updated_at = db["updatedAt"]
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
            {
                "players": players,
                "updatedAt": updated_at,
            },
        )

    def respond_json(self, status: HTTPStatus, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
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
