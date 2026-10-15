"""Endless checkpoint ownership, monotonic updates, best runs, and private long-run saves."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlparse

from accounts import AccountStore, validate_progress
from endless import EndlessStore, EndlessError


def checkpoint(run_id="run-a", name="Alice", total=10, correct=10, coins=28, finished=False, key="a" * 64):
    return {"id": run_id, "mode": "endless", "name": name, "checkpointKey": key,
            "startedAt": "2026-10-15T12:00:00Z", "totalQuestions": total,
            "totalCorrect": correct, "finalCoins": coins, "bestStreak": min(correct, 10), "isCompleted": finished}


class EndlessContract:
    def test_reset_to_ten_preserves_lifetime_totals_and_private_ownership(self):
        self.endless.save(checkpoint(total=150, correct=120, coins=190))
        reset = {**checkpoint(total=150, correct=120, coins=10), 'walletResets': 1}
        saved = self.endless.save(reset)
        self.assertEqual(saved['finalCoins'], 10)
        self.assertEqual(saved['totalCorrect'], 120)
        self.assertEqual(saved['walletResets'], 1)
        self.assertEqual(self.endless.save(reset), saved)
        self.assertEqual(self.endless.leaderboard()['players'], [])
        self.assertIsNone(self.endless.best_for_player('alice'))
        with self.assertRaises(EndlessError) as error:
            self.endless.save({**reset, 'walletResets': 2, 'checkpointKey': 'b' * 64})
        self.assertEqual(error.exception.status, 403)
        resumed = self.endless.save({**reset, 'totalQuestions':151,'totalCorrect':121,'finalCoins':11})
        self.assertEqual(resumed['totalQuestions'], 151)
        self.assertEqual(resumed['finalCoins'], 11)

    def test_stale_pre_reset_checkpoints_cannot_restore_old_coins(self):
        original = checkpoint(total=100, correct=80, coins=100)
        self.endless.save(original)
        reset = self.endless.save({**original, 'finalCoins':10, 'walletResets':1})
        self.assertEqual(self.endless.save(original), reset)
        with self.assertRaises(EndlessError):
            self.endless.save({**original,'totalQuestions':101,'totalCorrect':81,'finalCoins':101})
        for changes in [{'finalCoins':11}, {'totalCorrect':79}, {'bestStreak':9}, {'totalQuestions':99}]:
            with self.assertRaises(EndlessError):
                self.endless.save({**original, 'finalCoins':10, 'walletResets':2, **changes})
        self.assertEqual(self.endless.leaderboard()['players'], [])

    def test_offline_reset_then_new_answers_can_sync_together(self):
        self.endless.save(checkpoint(total=100, correct=80, coins=100))
        updated = self.endless.save({**checkpoint(total=105,correct=84,coins=14),'walletResets':3, 'leaderboardBaseQuestions':100, 'leaderboardBaseCorrect':80})
        self.assertEqual(updated['walletResets'], 3)
        self.assertEqual(updated['totalQuestions'], 105)
        self.assertEqual(updated['finalCoins'], 14)

    def test_reset_hides_older_runs_and_restarts_ranking_without_removing_votes(self):
        self.endless.save(checkpoint(run_id="older", total=50, correct=50, coins=100))
        initial = {**checkpoint(total=100, correct=80, coins=100), "videoStats":{"clip":{"trackCount":80,"cascadeCount":20,"correctCount":80}}}
        self.endless.save(initial)
        reset = {**initial, "walletResets":1, "finalCoins":10, "leaderboardBaseQuestions":100, "leaderboardBaseCorrect":80}
        self.endless.save(reset)
        self.assertEqual(self.endless.leaderboard()["players"], [])
        self.assertEqual(self.endless.leaderboard()["crowdStats"]["clip"]["trackCount"], 80)
        self.assertEqual(len(self.endless.leaderboard()["history"]), 2, "Reset retains research history")
        resumed = {**reset, "totalQuestions":101, "totalCorrect":81, "finalCoins":15,
                   "videoStats":{"clip":{"trackCount":81,"cascadeCount":20,"correctCount":81}}}
        saved = self.endless.save(resumed)
        self.assertEqual(saved["totalCorrect"] - saved["leaderboardBaseCorrect"], 1)
        self.assertEqual(self.endless.leaderboard()["players"][0]["id"], "run-a")
        self.endless.save(resumed)
        self.assertEqual(self.endless.leaderboard()["crowdStats"]["clip"]["trackCount"], 81)
        self.endless.save(initial)  # A stale device cannot restore pre-reset standings.
        self.assertEqual(self.endless.best_for_player("alice")["finalCoins"], 15)
        with self.assertRaises(EndlessError):
            self.endless.save({**resumed,"totalQuestions":102,"totalCorrect":82,"finalCoins":16,"leaderboardBaseQuestions":0,"leaderboardBaseCorrect":0})

    def test_vote_totals_are_bounded_and_monotonic(self):
        initial = {**checkpoint(), "videoStats":{"clip":{"trackCount":8,"cascadeCount":2,"correctCount":10}}}
        self.endless.save(initial)
        for stats in [{"clip":{"trackCount":7,"cascadeCount":2,"correctCount":9}}, {"clip":{"trackCount":10,"cascadeCount":2,"correctCount":10}}]:
            with self.assertRaises(EndlessError):
                self.endless.save({**initial,"totalQuestions":11,"totalCorrect":11,"finalCoins":30,"videoStats":stats})
        for stats in [{"clip":{"trackCount":True,"cascadeCount":0,"correctCount":0}}, {"clip":{"trackCount":11,"cascadeCount":0,"correctCount":0}}]:
            with self.assertRaises(EndlessError):
                self.endless.save({**checkpoint(run_id="bad"),"videoStats":stats})

    def test_checkpoint_persists_beyond_100_and_retries_are_idempotent(self):
        record = checkpoint(total=150, correct=120, coins=190)
        original = self.endless.save(record)
        self.assertEqual(self.endless.save(record), original)
        updated = self.endless.save({**record, "totalQuestions": 160, "totalCorrect": 125, "finalCoins": 195})
        self.assertEqual(updated["totalQuestions"], 160)
        self.assertEqual(self.endless.leaderboard()["players"][0], updated)
        self.assertNotIn("checkpointKey", json.dumps(self.endless.leaderboard()))
        self.assertNotIn("checkpoint_hash", json.dumps(self.endless.leaderboard()))

    def test_another_player_cannot_overwrite_a_published_run_id(self):
        saved = self.endless.save(checkpoint())
        with self.assertRaises(EndlessError) as error:
            self.endless.save(checkpoint(key="b" * 64))
        self.assertEqual(error.exception.status, 403)
        self.assertEqual(self.endless.leaderboard()["players"][0], saved)

    def test_stale_checkpoint_does_not_roll_back_progress_or_finish_a_newer_run(self):
        original = self.endless.save(checkpoint(total=100, correct=80, coins=100))
        self.assertEqual(self.endless.save(checkpoint()), original)
        with self.assertRaises(EndlessError) as error:
            self.endless.save(checkpoint(finished=True))
        self.assertEqual(error.exception.status, 409)
        with self.assertRaises(EndlessError):
            self.endless.save(checkpoint(total=100, correct=80, coins=101))
        self.assertEqual(self.endless.leaderboard()["players"][0], original)

    def test_finished_runs_are_final_but_a_finish_retry_is_safe(self):
        self.endless.save(checkpoint())
        finished = self.endless.save(checkpoint(finished=True))
        self.assertTrue(finished["isCompleted"])
        self.assertEqual(self.endless.save(checkpoint(finished=True)), finished)
        with self.assertRaises(EndlessError):
            self.endless.save(checkpoint(total=11, correct=11, coins=30))

    def test_best_run_per_player_and_ranking_are_separate(self):
        self.endless.save(checkpoint())
        self.endless.save(checkpoint(run_id="alice-short", name=" alice ", total=3, correct=3, coins=14))
        self.endless.save(checkpoint(run_id="bob", name="Bob", total=12, correct=11, coins=29))
        self.endless.save(checkpoint(run_id="carol", name="Carol", total=11, correct=11, coins=30))
        board = self.endless.leaderboard()["players"]
        self.assertEqual([row["name"] for row in board], ["Carol", "Bob", "Alice"])
        self.assertEqual(self.endless.best_for_player("alice")["id"], "run-a")
        self.assertEqual(len(board), 3)

    def test_negative_coins_are_valid_and_invalid_totals_are_rejected(self):
        self.assertEqual(self.endless.save(checkpoint(total=20, correct=0, coins=-10))["finalCoins"], -10)
        for changes in [{"totalCorrect": 21}, {"totalQuestions": True}, {"finalCoins": 10000}, {"bestStreak": -1}, {"checkpointKey": "public-id"}, {"isCompleted": "true"}]:
            with self.assertRaises(EndlessError):
                self.endless.save({**checkpoint(run_id="invalid", total=20, correct=0, coins=-10), **changes})

    def test_compact_private_progress_has_no_lifetime_question_cap(self):
        run = {"id": "million-questions", "name": "Alice", "mode": "endless", "phase": "question",
               "checkpointKey": "a" * 64, "currentIndex": 99, "videoOrder": [f"catalog/{i}" for i in range(100)],
               "answers": [{"correct": True} for _ in range(10)], "totalQuestions": 1_000_000,
               "totalCorrect": 800_000, "coins": 500_000, "bestStreak": 100}
        progress = {"currentRun": None, "endlessRun": run, "selectedMode": "endless", "pendingEndless": []}
        self.assertEqual(validate_progress(progress), progress)
        self.assertLess(len(json.dumps(progress)), 10000)


class SQLiteEndless(EndlessContract, unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.endless = EndlessStore(AccountStore.sqlite(Path(self.folder.name) / "accounts.sqlite3"))

    def tearDown(self):
        self.folder.cleanup()


@unittest.skipUnless(os.environ.get("TEST_DATABASE_URL"), "Set a disposable TEST_DATABASE_URL")
class PostgresEndless(EndlessContract, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from database import Store
        from manage import migrate
        url = os.environ["TEST_DATABASE_URL"]
        if not urlparse(url).path.endswith(("_test", "_tests")):
            raise RuntimeError("Use a disposable database")
        migrate(url)
        cls.store = Store(url)

    @classmethod
    def tearDownClass(cls):
        cls.store.close()

    def setUp(self):
        with self.store.pool.connection() as conn:
            conn.execute("TRUNCATE endless_runs")
        self.endless = EndlessStore(AccountStore(self.store.pool.connection, postgres=True))

    def test_public_mode_and_private_paused_run_restore(self):
        from production import create_app
        app = create_app(self.store)
        with self.store.pool.connection() as conn:
            conn.execute("TRUNCATE auth_accounts, auth_sessions, auth_limits CASCADE")
        player, other = app.test_client(), app.test_client()
        response = player.post("/api/endless-players", json=checkpoint(total=200, correct=150, coins=210))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["player"]["totalCorrect"], 150)
        board = other.get("/api/endless-players")
        self.assertEqual(board.status_code, 200)
        self.assertEqual(board.json["players"][0]["mode"], "endless")
        self.assertNotIn("checkpointKey", json.dumps(board.json))
        self.assertEqual(other.get("/api/collaborator-players").status_code, 200)
        headers = {"X-Neutrino-Request": "1"}
        self.assertEqual(player.post("/api/auth/register", json={"username":"Alice","password":"Endless test only"}, headers=headers).status_code, 200)
        progress = {"selectedMode":"endless","currentRun":None,"endlessRun":{
            "id":"run-a","name":"Alice","mode":"endless","checkpointKey":"a"*64,
            "answers":[],"videoOrder":["catalog/one"],"currentIndex":0,
            "totalQuestions":200,"totalCorrect":150,"coins":210,"walletResets":0,"phase":"question"}}
        self.assertEqual(player.post("/api/account/progress", json={"owner":"Alice","revision":0,"progress":progress}, headers=headers).status_code, 200)
        self.assertEqual(other.post("/api/auth/login", json={"username":"Alice","password":"Endless test only"}, headers=headers).status_code, 200)
        self.assertEqual(other.get("/api/account").json["progress"]["endlessRun"]["totalQuestions"], 200)
        progress['endlessRun'].update(coins=10, walletResets=1)
        self.assertEqual(player.post('/api/account/progress', json={'owner':'Alice','revision':1,'progress':progress}, headers=headers).status_code, 200)
        restored = other.get('/api/account').json['progress']['endlessRun']
        self.assertEqual(restored['coins'], 10)
        self.assertEqual(restored['walletResets'], 1)
        self.assertEqual(restored['totalQuestions'], 200)
