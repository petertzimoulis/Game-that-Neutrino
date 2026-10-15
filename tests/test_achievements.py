"""Trophies merge once per normalized player name and persist atomically."""
import importlib.util
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

spec = importlib.util.spec_from_file_location('neutrino_server', Path(__file__).parents[1] / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

class TrophyTests(unittest.TestCase):
    def test_new_trophies_sync_together_and_preserve_legacy(self):
        new_ids = {'demo-complete', 'endless-10', 'endless-50', 'endless-100',
                   'endless-250', 'endless-streak-10', 'endless-correct-100'}
        self.assertTrue(new_ids <= server.ACHIEVEMENT_IDS)
        db = {'profiles': []}
        server.merge_achievement_profile(db, {'name': 'Returning player', 'unlocked': ['sure-shot']})
        payload = {'name': 'returning PLAYER', 'unlocked': sorted(server.ACHIEVEMENT_IDS)}
        server.merge_achievement_profile(db, payload)
        server.merge_achievement_profile(db, payload)
        self.assertEqual(len(db['profiles']), 1)
        self.assertEqual(set(db['profiles'][0]['unlocked']), server.ACHIEVEMENT_IDS)
        self.assertEqual(len(db['profiles'][0]['unlocked']), len(server.ACHIEVEMENT_IDS))

    def test_merge_and_persist(self):
        db = {'profiles': []}
        server.merge_achievement_profile(db, {'name': ' Demo Player ', 'unlocked': ['first-call', 'first-call']})
        server.merge_achievement_profile(db, {'name': 'demo   player', 'unlocked': ['hot-hand']})
        self.assertEqual(len(db['profiles']), 1)
        self.assertEqual(set(db['profiles'][0]['unlocked']), {'first-call', 'hot-hand'})
        original = server.DATA_DIR
        try:
            with tempfile.TemporaryDirectory() as folder:
                server.DATA_DIR = Path(folder)
                target = Path(folder) / 'trophies.json'
                server.save_db(target, db)
                self.assertEqual(server.load_db(target, lambda: {'profiles': []}), db)
                self.assertFalse(target.with_suffix('.tmp').exists())
        finally:
            server.DATA_DIR = original

    def test_invalid_entries_do_not_mutate(self):
        db = {'profiles': []}
        for payload in [{'name': 'x', 'unlocked': ['fake']}, {'name': '', 'unlocked': ['first-call']}, {'name': [], 'unlocked': ['first-call']}, {'name': 'x', 'unlocked': []}, {'name': 'x', 'unlocked': [['first-call']]}]:
            before = deepcopy(db)
            with self.assertRaises(ValueError):
                server.merge_achievement_profile(db, payload)
            self.assertEqual(db, before)

if __name__ == '__main__':
    unittest.main()
