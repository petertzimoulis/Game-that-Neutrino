"""Persistent server data and reset rules work independently of the release checkout."""
import importlib.util
import json
import os
import tempfile
import threading
import unittest
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class LiveServerConfig(unittest.TestCase):
    def test_external_data_directory_and_pre_reset_write_guard(self):
        with tempfile.TemporaryDirectory() as folder:
            data = Path(folder) / 'persistent' / 'reset-test'
            with patch.dict(os.environ, {'NEUTRINO_DATA_DIR':str(data), 'GAME_STATE_EPOCH':'reset-test'}):
                spec = importlib.util.spec_from_file_location('live_config_server', Path(__file__).parents[1] / 'server.py')
                server = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(server)
            http = ThreadingHTTPServer(('127.0.0.1',0), partial(server.SharedLeaderboardHandler,directory=str(server.ROOT_DIR)))
            thread = threading.Thread(target=http.serve_forever,daemon=True)
            thread.start()
            address = f'http://127.0.0.1:{http.server_port}'
            body = json.dumps({'name':'Deployment check','unlocked':['first-call']}).encode()
            try:
                with self.assertRaises(HTTPError) as rejected:
                    urlopen(Request(address+'/api/achievements',data=body,headers={'Content-Type':'application/json'}))
                self.assertEqual(rejected.exception.code,409)
                self.assertFalse(data.exists())
                with urlopen(Request(address+'/api/achievements',data=body,headers={'Content-Type':'application/json','X-Neutrino-State-Epoch':'reset-test'})) as response:
                    self.assertEqual(response.status,200)
                self.assertEqual(json.loads((data/'achievements.json').read_text())['profiles'][0]['name'],'Deployment check')
                with urlopen(address+'/api/analytics?view=full') as response:
                    self.assertEqual(json.load(response)['events'],[])
            finally:
                http.shutdown()
                http.server_close()
                thread.join(timeout=5)
