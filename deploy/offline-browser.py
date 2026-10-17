"""Local browser bridge into a running --network none container.

Usage: python deploy/offline-browser.py --container NAME --port 8087
Requires Docker CLI on the host and Python in the image. No API key is embedded.
This is a test tool, not a production proxy. Requests travel over docker exec,
not a published container port. CSP blocks external page resources and requests.
"""
import argparse
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import subprocess


CONTAINER_REQUEST = """
import base64, http.client, json, sys
request = json.load(sys.stdin)
connection = http.client.HTTPConnection('127.0.0.1', 8000, timeout=300)
connection.request(request['method'], request['path'],
                   body=base64.b64decode(request['body']), headers=request['headers'])
response = connection.getresponse()
print(json.dumps({'status': response.status, 'headers': response.getheaders(),
                  'body': base64.b64encode(response.read()).decode('ascii')}))
connection.close()
"""
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'self'; "
       "object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--container', required=True)
    parser.add_argument('--port', type=int, default=8087)
    args = parser.parse_args()
    mode = subprocess.check_output(
        ['docker', 'inspect', args.container, '--format', '{{.HostConfig.NetworkMode}}'], text=True).strip()
    if mode != 'none':
        raise SystemExit('Browser offline check requires container --network none')

    class Bridge(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *unused):
            pass  # Do not log credentials, cookies or request bodies.

        def proxy(self):
            if not self.path.startswith('/') or self.path.startswith('//'):
                self.send_error(400)
                return
            length = int(self.headers.get('Content-Length', 0))
            if length < 0 or length > 210 * 1024 * 1024:
                self.send_error(413)
                return
            excluded = {'host', 'connection', 'transfer-encoding', 'accept-encoding'}
            request = {'method': self.command, 'path': self.path,
                       'headers': {k: v for k, v in self.headers.items() if k.lower() not in excluded},
                       'body': base64.b64encode(self.rfile.read(length)).decode('ascii')}
            try:
                process = subprocess.run(
                    ['docker', 'exec', '-i', args.container, 'python3', '-c', CONTAINER_REQUEST],
                    input=json.dumps(request).encode(), capture_output=True, timeout=310, check=True)
                response = json.loads(process.stdout)
                body = base64.b64decode(response['body'])
            except (subprocess.SubprocessError, ValueError):
                self.send_error(502, 'Container bridge request failed')
                return
            self.send_response(response['status'])
            original_length = '0'
            for key, value in response['headers']:
                if key.lower() == 'content-length':
                    original_length = value
                if key.lower() not in {'connection', 'transfer-encoding', 'content-encoding',
                                       'content-length', 'cache-control', 'content-security-policy'}:
                    self.send_header(key, value)
            self.send_header('Content-Security-Policy', CSP)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', original_length if self.command == 'HEAD' else str(len(body)))
            self.end_headers()
            if self.command != 'HEAD':
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass

        do_GET = do_HEAD = do_POST = proxy

    print(f'Offline browser bridge: http://127.0.0.1:{args.port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), Bridge).serve_forever()


if __name__ == '__main__':
    main()
