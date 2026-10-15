"""Integration checks against a dedicated PostgreSQL database, never JSON fixtures."""
import json
import os
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

URL = os.environ.get("TEST_DATABASE_URL")


@unittest.skipUnless(URL, "Set TEST_DATABASE_URL to a disposable database ending in _test or _tests")
class ProductionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not urlparse(URL).path.rstrip('/').endswith(("_test", "_tests")):
            raise RuntimeError("Integration tests require a dedicated _test or _tests database")
        from database import Store
        from production import create_app
        from manage import migrate
        migrate(URL)
        cls.store = Store(URL)
        cls.app = create_app(cls.store)
        cls.app.config["TESTING"] = True

    @classmethod
    def tearDownClass(cls):
        cls.store.close()

    def setUp(self):
        with self.store.pool.connection() as conn:
            conn.execute("TRUNCATE runs, achievements, achievement_profiles, analytics_events, weekly_lineups CASCADE")
        # Each test exercises a fresh worker cache.
        from production import create_app
        self.app = create_app(self.store)
        self.app.config["TESTING"] = True

    @staticmethod
    def record(index=0, name=None, when="2026-10-15T12:00:00Z"):
        return {"id": f"test-{index}", "name": name or f"Player {index}", "completedAt": when, "finalCoins": 15,
                "answers": [{"videoId": f"clip-{i}", "choice": "track", "correct": True} for i in range(5)]}

    def post(self, path, payload):
        with self.app.test_client() as client:
            response = client.post(path, json=payload)
            return response.status_code, response.get_json()

    def test_parallel_scores_and_retries(self):
        with ThreadPoolExecutor(max_workers=32) as executor:
            responses = list(executor.map(lambda i: self.post('/api/collaborator-players', self.record(i)), range(200)))
        self.assertTrue(all(status == 200 for status, _ in responses))
        with self.store.pool.connection() as conn:
            self.assertEqual(conn.execute('SELECT count(*) AS n FROM runs').fetchone()['n'], 200)
        with ThreadPoolExecutor(max_workers=16) as executor:
            retries = list(executor.map(lambda i: self.post('/api/collaborator-players', self.record(0)), range(50)))
        self.assertTrue(all(status == 200 for status, _ in retries))
        altered = {**self.record(0), 'finalCoins': 9000}
        status, data = self.post('/api/collaborator-players', altered)
        self.assertEqual(data['history'][0]['finalCoins'], 15)
        self.assertTrue(data['partial'])
        self.assertEqual(len(data['players']), 1)
        with self.store.pool.connection() as conn:
            self.assertEqual(conn.execute('SELECT count(*) AS n FROM runs').fetchone()['n'], 200)

    def test_latest_player_and_historical_crowd(self):
        self.post('/api/collaborator-players', self.record(1, ' Alice ', '2026-10-15T13:00:00Z'))
        _, older = self.post('/api/collaborator-players', self.record(2, 'alice', '2026-10-14T12:00:00Z'))
        self.assertEqual(older['players'][0]['id'], 'test-1')
        board = self.store.leaderboard('demo')
        self.assertEqual(len(board['players']), 1)
        self.assertEqual(board['players'][0]['answers'], [])
        self.assertNotIn('history', board)
        self.assertEqual(board['crowdStats']['clip-0']['trackCount'], 2)
        self.assertEqual(len(self.store.leaderboard('demo', full=True)['players'][0]['answers']), 5)

    def test_concurrent_trophies_union_and_retry(self):
        from server import ACHIEVEMENT_IDS
        ids = sorted(ACHIEVEMENT_IDS - {'sure-shot'})
        with ThreadPoolExecutor(max_workers=16) as executor:
            responses = list(executor.map(lambda item: self.post('/api/achievements', {'name': ' Same Player ', 'unlocked': [item]}), ids * 5))
        self.assertTrue(all(status == 200 for status, _ in responses))
        profiles = self.store.achievements()['profiles']
        self.assertEqual(len(profiles), 1)
        self.assertEqual(set(profiles[0]['unlocked']), set(ids))
        status, _ = self.post('/api/achievements', {'name': 'same player', 'unlocked': ids})
        self.assertEqual(status, 200, 'A full collection can sync in a single request')
        self.assertEqual(set(self.store.achievements()['profiles'][0]['unlocked']), set(ids))

    def test_pagination_has_no_gaps_or_duplicates(self):
        for i in range(12):
            self.store.save_run('demo', {**self.record(i), 'nameKey': f'player {i}'})
        found, cursor = [], None
        while True:
            page = self.store.history('demo', cursor, limit=5)
            found.extend(row['id'] for row in page['history'])
            cursor = page['nextCursor']
            if cursor is None:
                break
        self.assertEqual(len(found), 12)
        self.assertEqual(len(set(found)), 12)
        with self.app.test_client() as client:
            response = client.get('/api/history?mode=demo&cursor=%7B%7D')
            self.assertEqual(response.status_code, 400)

    def test_events_are_idempotent_and_small_ack(self):
        event = {'id': 'event-1', 'type': 'page_opened', 'timestamp': '2026-10-15T12:00:00Z', 'mode': 'demo'}
        for _ in range(2):
            status, ack = self.post('/api/analytics-events', {'events': [event]})
            self.assertEqual(status, 200)
            self.assertEqual(ack, {'accepted': 1})
        self.assertEqual(self.store.analytics()['summary']['totalEvents'], 1)

    def test_validation_is_atomic_and_readiness_is_small(self):
        for record in [{**self.record(), 'finalCoins': float('nan')}, {**self.record(), 'completedAt': 'not a date'}, {**self.record(), 'answers': []}]:
            self.assertEqual(self.post('/api/collaborator-players', record)[0], 400)
        with self.app.test_client() as client:
            self.assertEqual(client.post('/api/collaborator-players', json=[]).status_code, 400)
            self.assertEqual(client.post('/api/analytics-events', data='x' * 300000, content_type='application/json').status_code, 413)
            self.assertEqual(client.get('/api/ready').get_json(), {'status': 'ok', 'storage': 'postgresql'})
            self.assertEqual(client.get('/server.py').status_code, 404)

    def test_media_configuration_is_public_and_optional(self):
        from unittest.mock import patch
        with patch.dict(os.environ, {'VIDEO_BASE_URL': 'https://media.example.test/'}):
            with self.app.test_client() as client:
                response = client.get('/site-config.js')
                self.assertIn('https://media.example.test', response.get_data(as_text=True))
                self.assertEqual(response.mimetype, 'text/javascript')
                self.assertEqual(response.headers['Cache-Control'], 'public, max-age=60')

    def test_cache_and_conditional_get(self):
        with self.app.test_client() as client:
            response = client.get('/api/collaborator-players')
            self.assertIn('s-maxage=15', response.headers['Cache-Control'])
            self.assertIn('ETag', response.headers)
            self.assertEqual(client.get('/api/collaborator-players', headers={'If-None-Match': response.headers['ETag']}).status_code, 304)
            full = client.get('/api/collaborator-players?view=full')
            self.assertEqual(full.headers['Cache-Control'], 'no-store')

    def test_import_is_repeatable(self):
        import tempfile
        from manage import import_json
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'collaborator_leaderboard.json').write_text(json.dumps({'players': [self.record(99)], 'history': [self.record(99)]}))
            import_json(self.store, Path(directory))
            import_json(self.store, Path(directory))
        with self.store.pool.connection() as conn:
            self.assertEqual(conn.execute('SELECT count(*) AS n FROM runs').fetchone()['n'], 1)

    def test_import_preserves_weekly_lineup_and_trophy_date(self):
        import tempfile
        import server as rules
        from manage import import_json
        start = rules.get_active_cycle_start().isoformat()
        ids = list(reversed(rules.load_catalog_video_ids()[:rules.RUN_VIDEO_COUNT]))
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'shared_leaderboard.json').write_text(json.dumps({'activeCycleStart': start, 'activeVideoIds': ids}))
            Path(directory, 'achievements.json').write_text(json.dumps({'profiles': [{'name': 'Imported', 'unlocked': ['first-call'], 'firstEarnedAt': '2026-07-01T12:00:00Z'}]}))
            import_json(self.store, Path(directory))
        self.assertEqual(self.store.schedule()['activeVideoIds'], ids)
        self.assertTrue(self.store.achievements()['profiles'][0]['firstEarnedAt'].startswith('2026-07-01'))

    def test_weekly_submission_and_expired_cycle(self):
        import server as rules
        record = {**self.record(), 'cycleStart': rules.get_active_cycle_start().isoformat(),
                  'answers': [{'videoId': f'weekly-{i}', 'choice': 'track', 'correct': True} for i in range(rules.RUN_VIDEO_COUNT)]}
        status, result = self.post('/api/players', record)
        self.assertEqual(status, 200)
        self.assertEqual(len(result['activeVideoIds']), rules.RUN_VIDEO_COUNT)
        self.assertEqual(self.post('/api/players', {**record, 'cycleStart': '2020-01-01'})[0], 409)

    def test_catalog_replacement_refreshes_retired_weekly_clips(self):
        import server as rules
        from psycopg.types.json import Jsonb
        retired = [f"Group 1/retired-{i}.mp4" for i in range(rules.RUN_VIDEO_COUNT)]
        with self.store.pool.connection() as conn:
            conn.execute("INSERT INTO weekly_lineups (cycle_start, video_ids) VALUES (%s, %s)",
                         (rules.get_active_cycle_start(), Jsonb(retired)))
        current = self.store.schedule()['activeVideoIds']
        self.assertEqual(len(current), rules.RUN_VIDEO_COUNT)
        self.assertTrue(set(current).issubset(rules.load_catalog_video_ids()))
        self.assertEqual(self.store.schedule()['activeVideoIds'], current)


if __name__ == '__main__':
    unittest.main()
