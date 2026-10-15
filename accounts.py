"""Optional private accounts shared by the development and production servers."""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import time
import uuid
from contextlib import contextmanager
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import urlparse
from endless import SCHEMA as ENDLESS_SCHEMA

COOKIE_NAME = "neutrino_session"
SESSION_SECONDS = 30 * 24 * 60 * 60
MAX_BODY = 240_000
ROUTES = {"/api/account", "/api/account/progress", "/api/auth/register", "/api/auth/login", "/api/auth/logout"}
SCHEMA = """
CREATE TABLE IF NOT EXISTS auth_accounts (
    id text PRIMARY KEY, username text NOT NULL, username_key text NOT NULL UNIQUE,
    password_hash text NOT NULL, progress text NOT NULL DEFAULT '{}',
    revision integer NOT NULL DEFAULT 0, updated_at double precision NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash text PRIMARY KEY, account_id text NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
    expires_at double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
CREATE TABLE IF NOT EXISTS auth_limits (
    key text PRIMARY KEY, hits integer NOT NULL, until double precision NOT NULL
);
"""


class AccountError(Exception):
    def __init__(self, status, message, **details):
        super().__init__(message)
        self.status = status
        self.payload = {"error": message, **details}


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 600_000).hex()
    return f"pbkdf2-sha256$600000${salt}${digest}"


def password_matches(password, encoded):
    _, iterations, salt, expected = encoded.split("$")
    actual = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations)).hex()
    return hmac.compare_digest(actual, expected)


# Unknown users receive the same expensive password check as existing users.
DUMMY_HASH = password_hash("unused-password", "00" * 16)


def credentials(payload):
    username, password = payload.get("username"), payload.get("password")
    if not isinstance(username, str) or not re.fullmatch(r"[A-Za-z0-9_\-]{3,32}", username):
        raise AccountError(400, "Use a username with 3–32 letters, numbers, underscores, or hyphens.")
    if username.lower() in {"__proto__", "constructor", "prototype"}:
        raise AccountError(400, "Please choose a different username.")
    if not isinstance(password, str) or not 8 <= len(password) <= 128:
        raise AccountError(400, "Use a password with 8–128 characters.")
    return username, password


def validate_progress(progress):
    if not isinstance(progress, dict) or len(json.dumps(progress, allow_nan=False).encode()) > MAX_BODY - 1000:
        raise AccountError(400, "Saved progress is too large or invalid.")
    allowed = {"currentRun", "lastCompletedRun", "completedRuns", "trophies", "lastName", "selectedMode", "pendingRuns", "endlessRun", "pendingEndless"}
    if set(progress) - allowed:
        raise AccountError(400, "Invalid saved-progress fields.")
    if not isinstance(progress.get("selectedMode", "demo"), str) or progress.get("selectedMode", "demo") not in {"demo", "friday", "quiz", "quick", "endless"}:
        raise AccountError(400, "Invalid game mode.")
    if not isinstance(progress.get("lastName", ""), str) or len(progress.get("lastName", "")) > 80:
        raise AccountError(400, "Invalid player name.")
    runs = []
    for key, limit in [("completedRuns", 10), ("pendingRuns", 20), ("pendingEndless", 20)]:
        items = progress.get(key, [])
        if not isinstance(items, list) or len(items) > limit:
            raise AccountError(400, "Invalid saved runs.")
        runs.extend(items)
    runs.extend(progress[key] for key in ["currentRun", "lastCompletedRun", "endlessRun"] if progress.get(key) is not None)
    for run in runs:
        if not isinstance(run, dict) or not isinstance(run.get("mode"), str) or run.get("mode") not in {"demo", "friday", "quiz", "quick", "endless"}:
            raise AccountError(400, "Invalid saved game.")
        for field, limit in [("id", 120), ("name", 80)]:
            if not isinstance(run.get(field), str) or not 1 <= len(run[field]) <= limit:
                raise AccountError(400, "Invalid saved game.")
        answers = run.get("answers", [])
        order = run.get("videoOrder", [])
        if not isinstance(answers, list) or len(answers) > 100 or any(not isinstance(a, dict) for a in answers):
            raise AccountError(400, "Invalid saved answers.")
        if not isinstance(order, list) or len(order) > 100 or any(not isinstance(v, str) or len(v) > 240 for v in order):
            raise AccountError(400, "Invalid saved clip order.")
        if "currentIndex" in run and (type(run["currentIndex"]) is not int or not 0 <= run["currentIndex"] <= 100):
            raise AccountError(400, "Invalid saved question.")
    trophies = progress.get("trophies", {})
    if not isinstance(trophies, dict) or len(trophies) > 100:
        raise AccountError(400, "Invalid trophies.")
    for key, value in trophies.items():
        if key in {"__proto__", "constructor", "prototype"} or not isinstance(value, dict) or not isinstance(value.get("name"), str) or not isinstance(value.get("unlocked"), list) or any(not isinstance(item, str) for item in value["unlocked"]):
            raise AccountError(400, "Invalid trophies.")
    return progress


class AccountStore:
    def __init__(self, connect, postgres=False):
        self.connect, self.postgres = connect, postgres

    @classmethod
    def sqlite(cls, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(path)
        try:
            with conn:
                conn.executescript(SCHEMA + ENDLESS_SCHEMA)
        finally:
            conn.close()
        path.chmod(0o600)

        @contextmanager
        def connect():
            conn = sqlite3.connect(path, timeout=10)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            try:
                with conn:
                    yield conn
            finally:
                conn.close()
        return cls(connect)

    def query(self, conn, sql, params=()):
        return conn.execute(sql.replace("?", "%s") if self.postgres else sql, params)

    def throttle(self, key, limit, seconds=900):
        now = time.time()
        key = hashlib.sha256(key.encode()).hexdigest()
        with self.connect() as conn:
            # A database counter applies across threads and production workers.
            self.query(conn, "DELETE FROM auth_limits WHERE until < ?", (now - 3600,))
            row = self.query(conn, """INSERT INTO auth_limits (key, hits, until) VALUES (?, 1, ?)
                ON CONFLICT (key) DO UPDATE SET
                hits = CASE WHEN auth_limits.until <= ? THEN 1 ELSE auth_limits.hits + 1 END,
                until = CASE WHEN auth_limits.until <= ? THEN ? ELSE auth_limits.until END
                RETURNING hits""", (key, now + seconds, now, now, now + seconds)).fetchone()
        if row["hits"] > limit:
            raise AccountError(429, "Too many attempts. Please try again in 15 minutes.")

    def account_for_token(self, token):
        if not token or len(token) > 128:
            return None
        with self.connect() as conn:
            row = self.query(conn, """SELECT a.id, a.username, a.progress, a.revision, a.updated_at
                FROM auth_sessions s JOIN auth_accounts a ON a.id = s.account_id
                WHERE s.token_hash = ? AND s.expires_at > ?""", (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
        return dict(row) if row else None

    def start_session(self, account_id, previous=None):
        token = secrets.token_urlsafe(32)
        with self.connect() as conn:
            self.query(conn, "DELETE FROM auth_sessions WHERE expires_at <= ?", (time.time(),))
            if previous:
                self.query(conn, "DELETE FROM auth_sessions WHERE token_hash = ?", (hashlib.sha256(previous.encode()).hexdigest(),))
            self.query(conn, "INSERT INTO auth_sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)",
                       (hashlib.sha256(token.encode()).hexdigest(), account_id, time.time() + SESSION_SECONDS))
        return token

    @staticmethod
    def payload(row):
        return {"user": {"username": row["username"]}, "progress": json.loads(row["progress"]),
                "revision": row["revision"], "updatedAt": row["updated_at"]}

    def handle(self, method, path, payload, headers, peer):
        cookie = SimpleCookie()
        try:
            cookie.load(headers.get("Cookie", ""))
            token = cookie[COOKIE_NAME].value if COOKIE_NAME in cookie else None
        except Exception:
            token = None
        if method == "GET" and path == "/api/account":
            row = self.account_for_token(token)
            return (self.payload(row) if row else {"user": None}), None
        if method != "POST":
            raise AccountError(405, "Method not allowed.")
        origin = headers.get("Origin")
        if (headers.get("X-Neutrino-Request") != "1" or
            headers.get("Sec-Fetch-Site") == "cross-site" or
            (origin and urlparse(origin).netloc.lower() != headers.get("Host", "").lower())):
            raise AccountError(403, "Please submit this request from the game site.")
        if not isinstance(payload, dict):
            raise AccountError(400, "Expected an object.")
        if path in {"/api/auth/register", "/api/auth/login"}:
            username, password = credentials(payload)
            self.throttle("peer:" + peer, 300)
            self.throttle("user:" + username.lower(), 12)
            if path.endswith("register"):
                account_id = str(uuid.uuid4())
                encoded = password_hash(password)
                with self.connect() as conn:
                    result = self.query(conn, """INSERT INTO auth_accounts (id, username, username_key, password_hash, updated_at)
                        VALUES (?, ?, ?, ?, ?) ON CONFLICT (username_key) DO NOTHING""",
                        (account_id, username, username.lower(), encoded, time.time()))
                    if result.rowcount == 0:
                        raise AccountError(409, "That username is already taken. Choose another or log in.")
            else:
                with self.connect() as conn:
                    user = self.query(conn, "SELECT id, password_hash FROM auth_accounts WHERE username_key = ?", (username.lower(),)).fetchone()
                if not password_matches(password, user["password_hash"] if user else DUMMY_HASH) or not user:
                    raise AccountError(401, "Incorrect username or password.")
                account_id = user["id"]
            new_token = self.start_session(account_id, token)
            return self.payload(self.account_for_token(new_token)), new_token
        row = self.account_for_token(token)
        if path == "/api/auth/logout":
            with self.connect() as conn:
                if token:
                    self.query(conn, "DELETE FROM auth_sessions WHERE token_hash = ?", (hashlib.sha256(token.encode()).hexdigest(),))
            return {"user": None}, ""
        if not row:
            raise AccountError(401, "Please log in again. Your progress is still saved on this device.")
        if path == "/api/account/progress":
            if payload.get("owner") != row["username"]:
                raise AccountError(401, "The signed-in account changed. Please log in again.")
            revision = payload.get("revision")
            if type(revision) is not int or revision < 0:
                raise AccountError(400, "Invalid save version.")
            progress = validate_progress(payload.get("progress"))
            now = time.time()
            with self.connect() as conn:
                result = self.query(conn, """UPDATE auth_accounts SET progress = ?, revision = revision + 1, updated_at = ?
                    WHERE id = ? AND revision = ?""", (json.dumps(progress, allow_nan=False), now, row["id"], revision))
                if result.rowcount == 0:
                    raise AccountError(409, "Progress was saved from another tab or device. Choose which copy to keep.")
            return {"revision": revision + 1, "updatedAt": now}, None
        raise AccountError(404, "Not found.")


def session_cookie(token, secure=True):
    cookie = SimpleCookie()
    cookie[COOKIE_NAME] = token
    cookie[COOKIE_NAME]["path"] = "/"
    cookie[COOKIE_NAME]["httponly"] = True
    cookie[COOKIE_NAME]["samesite"] = "Lax"
    cookie[COOKIE_NAME]["max-age"] = SESSION_SECONDS if token else 0
    if secure:
        cookie[COOKIE_NAME]["secure"] = True
    return cookie.output(header="").strip()
