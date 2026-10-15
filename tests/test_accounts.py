"""Private account/session/save contract against SQLite and production PostgreSQL."""
import json
import os
import sqlite3
import tempfile
import threading
import unittest
from functools import partial
from http.cookiejar import CookieJar
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, Request, build_opener

from accounts import AccountError, AccountStore, COOKIE_NAME, password_matches


def progress(label="Alice"):
    return {"currentRun": {"id": "saved-run", "name": label, "mode": "demo", "phase": "question",
            "currentIndex": 1, "videoOrder": ["new/a.mp4", "new/b.mp4"],
            "answers": [{"videoId": "new/a.mp4", "choice": "track", "correct": True}], "coins": 11},
            "lastCompletedRun": None, "completedRuns": [], "pendingRuns": [], "lastName": label,
            "selectedMode": "demo", "trophies": {"alice": {"name": label, "unlocked": ["first-call"]}}}


class AccountContract:
    def call(self, path, data=None, token=None, headers=None):
        request_headers = {"Host": "localhost", "X-Neutrino-Request": "1", **(headers or {})}
        if token is not None:
            request_headers["Cookie"] = f"{COOKIE_NAME}={token}"
        return self.accounts.handle("GET" if data is None else "POST", path, data, request_headers, "test-peer")

    def register(self, name="Alice"):
        return self.call("/api/auth/register", {"username": name, "password": "Test-only password 42"})

    def test_private_progress_restores_on_an_independent_session(self):
        payload, token = self.register()
        self.assertEqual(payload["revision"], 0)
        self.assertEqual(self.call("/api/account")[0], {"user": None})
        saved, _ = self.call("/api/account/progress", {"owner": "Alice", "revision": 0, "progress": progress()}, token)
        self.assertEqual(saved["revision"], 1)
        _, second = self.call("/api/auth/login", {"username": "aLiCe", "password": "Test-only password 42"})
        restored, _ = self.call("/api/account", token=second)
        self.assertEqual(restored["progress"], progress())
        self.assertNotEqual(token, second)
        self.assertNotIn("password", json.dumps(restored))

    def test_passwords_and_session_tokens_are_not_stored_in_plaintext(self):
        _, token = self.register()
        with self.accounts.connect() as conn:
            user = self.accounts.query(conn, "SELECT password_hash FROM auth_accounts").fetchone()
            session = self.accounts.query(conn, "SELECT token_hash FROM auth_sessions").fetchone()
        self.assertNotIn("Test-only password 42", user["password_hash"])
        self.assertTrue(password_matches("Test-only password 42", user["password_hash"]))
        self.assertNotEqual(session["token_hash"], token)

    def test_duplicate_wrong_password_and_throttle(self):
        self.register()
        with self.assertRaises(AccountError) as duplicate:
            self.register("aLiCe")
        self.assertEqual(duplicate.exception.status, 409)
        for _ in range(2):
            with self.assertRaises(AccountError) as wrong:
                self.call("/api/auth/login", {"username": "Alice", "password": "wrong-but-long"})
            self.assertEqual(wrong.exception.status, 401)
        for _ in range(12):
            try:
                self.call("/api/auth/login", {"username": "Alice", "password": "wrong-but-long"})
            except AccountError as error:
                if error.status == 429:
                    break
        else:
            self.fail("Repeated password guesses were not throttled")

    def test_other_account_cannot_read_or_overwrite_progress(self):
        _, alice = self.register()
        self.call("/api/account/progress", {"owner": "Alice", "revision": 0, "progress": progress()}, alice)
        _, bob = self.register("Bob")
        self.assertEqual(self.call("/api/account", token=bob)[0]["progress"], {})
        with self.assertRaises(AccountError) as error:
            self.call("/api/account/progress", {"owner": "Alice", "revision": 1, "progress": progress("Bob")}, bob)
        self.assertEqual(error.exception.status, 401)
        self.assertEqual(self.call("/api/account", token=alice)[0]["progress"], progress())

    def test_stale_save_does_not_overwrite_a_newer_device(self):
        _, token = self.register()
        self.call("/api/account/progress", {"owner": "Alice", "revision": 0, "progress": progress()}, token)
        with self.assertRaises(AccountError) as conflict:
            self.call("/api/account/progress", {"owner": "Alice", "revision": 0, "progress": progress("Other")}, token)
        self.assertEqual(conflict.exception.status, 409)
        self.assertEqual(self.call("/api/account", token=token)[0]["progress"], progress())

    def test_csrf_logout_expiry_and_missing_session(self):
        for headers in [{"X-Neutrino-Request": ""}, {"Origin": "https://other.example"}, {"Sec-Fetch-Site": "cross-site"}]:
            with self.assertRaises(AccountError) as error:
                self.call("/api/auth/register", {"username": "Alice", "password": "Test-only password 42"}, headers=headers)
            self.assertEqual(error.exception.status, 403)
        _, token = self.register()
        self.call("/api/auth/logout", {}, token)
        self.assertEqual(self.call("/api/account", token=token)[0], {"user": None})
        with self.assertRaises(AccountError) as error:
            self.call("/api/account/progress", {"owner": "Alice", "revision": 0, "progress": progress()}, token)
        self.assertEqual(error.exception.status, 401)
        _, token = self.call("/api/auth/login", {"username": "Alice", "password": "Test-only password 42"})
        with self.accounts.connect() as conn:
            self.accounts.query(conn, "UPDATE auth_sessions SET expires_at = 0")
        self.assertEqual(self.call("/api/account", token=token)[0], {"user": None})


class SQLiteAccounts(AccountContract, unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.accounts = AccountStore.sqlite(Path(self.folder.name) / "accounts.sqlite3")

    def tearDown(self):
        self.folder.cleanup()


@unittest.skipUnless(os.environ.get("TEST_DATABASE_URL"), "Set a disposable TEST_DATABASE_URL")
class PostgresAccounts(AccountContract, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from urllib.parse import urlparse
        from database import Store
        from manage import migrate
        url = os.environ["TEST_DATABASE_URL"]
        if not urlparse(url).path.endswith(("_test", "_tests")):
            raise RuntimeError("Use a disposable _test or _tests database")
        migrate(url)
        cls.store = Store(url)

    @classmethod
    def tearDownClass(cls):
        cls.store.close()

    def setUp(self):
        with self.store.pool.connection() as conn:
            conn.execute("TRUNCATE auth_accounts, auth_sessions, auth_limits CASCADE")
        self.accounts = AccountStore(self.store.pool.connection, postgres=True)

    def test_production_routes_use_private_cookies_without_caching(self):
        from production import create_app
        app = create_app(self.store)
        client, other = app.test_client(), app.test_client()
        headers = {"X-Neutrino-Request": "1"}
        response = client.post("/api/auth/register", json={"username": "Alice", "password": "Test-only password 42"}, headers=headers, base_url="https://game.example")
        self.assertEqual(response.status_code, 200)
        for attribute in ["HttpOnly", "SameSite=Lax", "Secure", "Path=/"]:
            self.assertIn(attribute, response.headers["Set-Cookie"])
        self.assertEqual(response.headers["Cache-Control"], "private, no-store")
        self.assertEqual(other.get("/api/account").json, {"user": None})
        saved = client.post("/api/account/progress", json={"owner": "Alice", "revision": 0, "progress": progress()}, headers=headers, base_url="https://game.example")
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(client.get("/api/account", base_url="https://game.example").json["progress"], progress())
        self.assertEqual(client.post("/api/auth/logout", json={}, headers=headers, base_url="https://game.example").status_code, 200)
        self.assertIsNone(client.get("/api/account", base_url="https://game.example").json["user"])
        self.assertEqual(other.get("/api/collaborator-players").status_code, 200, "Guest leaderboard still works")


class DevelopmentAccountHTTP(unittest.TestCase):
    def test_real_http_cookies_and_private_files(self):
        import server
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            previous = server.DATA_DIR
            server.DATA_DIR = root / "data"
            http = ThreadingHTTPServer(("127.0.0.1", 0), partial(server.SharedLeaderboardHandler, directory=str(root)))
            thread = threading.Thread(target=lambda: http.serve_forever(poll_interval=.01), daemon=True)
            thread.start()
            try:
                origin = f"http://127.0.0.1:{http.server_port}"
                client = build_opener(HTTPCookieProcessor(CookieJar()))
                req = Request(origin + "/api/auth/register", data=json.dumps({"username": "Alice", "password": "Test-only password 42"}).encode(), headers={"Content-Type": "application/json", "X-Neutrino-Request": "1"})
                with client.open(req) as response:
                    self.assertEqual(response.status, 200)
                    self.assertIn("HttpOnly", response.headers["Set-Cookie"])
                with client.open(origin + "/api/account") as response:
                    self.assertEqual(json.load(response)["user"]["username"], "Alice")
                for path in ["/data/accounts.sqlite3", "/%64ata/accounts.sqlite3", "/.env"]:
                    for method in ["GET", "HEAD"]:
                        with self.assertRaises(HTTPError) as error:
                            client.open(Request(origin + path, method=method))
                        self.assertEqual(error.exception.code, 403)
            finally:
                http.shutdown()
                http.server_close()
                thread.join()
                server.DATA_DIR = previous
