import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

from .basemouse_client import BaseMouseClient, BaseMouseAPIError, format_context_pack_for_prompt


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/api/context-pack':
            params = parse_qs(parsed.query)
            q = params.get('q', [''])[0]
            self._json(200, {'retrieval': params.get('retrieval', ['lexical'])[0], 'entries': [{'id': 'a', 'title': 'Alpha', 'body': q, 'citation': {'label': '[a] Alpha'}, 'relevance': {'score': 1}, 'provenance': {'checksum': 'abc'}}]})
        elif parsed.path == '/api/search':
            params = parse_qs(parsed.query)
            self._json(200, {'retrieval': params.get('retrieval', ['lexical'])[0], 'results': []})
        elif parsed.path == '/api/usage':
            self._json(401, {'error': 'unauthorized', 'message': 'missing key'})
        else:
            self._json(404, {'error': 'not_found'})

    def do_POST(self):
        if self.path == '/api/documents':
            body = json.loads(self.rfile.read(int(self.headers.get('content-length', '0'))))
            self._json(201, {'id': body['id']})
        else:
            self._json(404, {'error': 'not_found'})

    def log_message(self, fmt, *args):
        pass

    def _json(self, status, payload):
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class ClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join(timeout=2)

    def test_context_pack_and_format(self):
        client = BaseMouseClient(base_url=self.base_url, api_key='bm_test')
        pack = client.context_pack('release policy', limit=2)
        prompt = format_context_pack_for_prompt(pack)
        self.assertIn('[a] Alpha', prompt)
        self.assertIn('release policy', prompt)

    def test_create_document(self):
        client = BaseMouseClient(base_url=self.base_url)
        self.assertEqual(client.create_document({'id': 'doc-1', 'title': 'Doc', 'body': 'Body'})['id'], 'doc-1')

    def test_retrieval_mode_is_forwarded(self):
        client = BaseMouseClient(base_url=self.base_url)
        self.assertEqual(client.search('memory', retrieval='hybrid')['retrieval'], 'hybrid')
        self.assertEqual(client.context_pack('memory', retrieval='hybrid')['retrieval'], 'hybrid')
        # `mode` is accepted as an alias for `retrieval`.
        self.assertEqual(client.search('memory', mode='hybrid')['retrieval'], 'hybrid')
        # Omitting it stays backward-compatible (server default = lexical).
        self.assertEqual(client.search('memory')['retrieval'], 'lexical')

    def test_http_error(self):
        client = BaseMouseClient(base_url=self.base_url)
        with self.assertRaises(BaseMouseAPIError) as ctx:
            client.usage()
        self.assertEqual(ctx.exception.status, 401)


if __name__ == '__main__':
    unittest.main()
