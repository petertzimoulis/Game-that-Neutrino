"""A completed collaborator run is persisted and visible to independent clients."""
import importlib.util
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path

spec = importlib.util.spec_from_file_location('collaborator_server', Path(__file__).parents[1] / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


def record(name='Alice', run_id='alice-one', completed='2026-10-13T12:00:00Z', coins=15):
    return {'id': run_id, 'name': name, 'nameKey': name.lower(), 'completedAt': completed, 'finalCoins': coins,
            'answers': [{'videoId': f'clip-{i}', 'choice': 'track', 'correct': True} for i in range(5)]}


class GlobalLeaderboardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        server.DATA_DIR = Path(cls.folder.name)
        server.COLLABORATOR_DB_PATH = server.DATA_DIR / 'collaborator.json'
        cls.http = ThreadingHTTPServer(('127.0.0.1', 0), partial(server.SharedLeaderboardHandler, directory=str(server.ROOT_DIR)))
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.http.server_address[1]}/api/collaborator-players'

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()
        cls.folder.cleanup()

    def request(self, payload=None):
        # Each call opens an independent HTTP connection, with no browser storage.
        req = urllib.request.Request(self.url, data=json.dumps(payload).encode() if payload is not None else None,
                                     headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req) as response:
            return json.load(response)

    def test_cross_client_persistence_retry_and_old_import(self):
        self.request(record())
        self.request(record('Bob', 'bob-one', coins=17))
        board = self.request()
        self.assertEqual([p['name'] for p in board['players']], ['Bob', 'Alice'])
        self.assertEqual(len(board['history']), 2)
        self.request(record())  # Retry the same run; do not duplicate standings or votes.
        self.assertEqual(len(self.request()['history']), 2)
        self.request(record(' ALICE ', 'alice-old', completed='2026-10-12T12:00:00Z', coins=20))
        board = self.request()
        alice = next(p for p in board['players'] if p['nameKey'] == 'alice')
        self.assertEqual(alice['id'], 'alice-one')
        self.assertEqual(len(board['history']), 3)
        disk = server.load_current_quiz_db(server.COLLABORATOR_DB_PATH)
        self.assertEqual(len(disk['players']), 2)
        self.assertEqual(len(disk['history']), 3)

    def test_invalid_or_incomplete_run_does_not_change_board(self):
        original = self.request()
        invalid = record('Invalid', 'invalid')
        for field, value in [('answers', invalid['answers'][:4]), ('completedAt', 'not-a-date'), ('finalCoins', float('nan')), ('name', '')]:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.request({**invalid, field: value})
            self.assertEqual(error.exception.code, 400)
        malformed_choice = {**invalid, 'answers': [{**answer, 'choice': {}} for answer in invalid['answers']]}
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request(malformed_choice)
        self.assertEqual(error.exception.code, 400)
        self.assertEqual(self.request(), original)


if __name__ == '__main__':
    unittest.main()
