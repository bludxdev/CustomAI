#!/usr/bin/env python3
"""Локальный сервер для чата: статика + прокси к API нейросети (обходит CORS).

    python server.py                  # http://localhost:8787
    python server.py 9000 --no-browser

Только стандартная библиотека, Python 3.8+.

POST /api/proxy  {url, method, headers, body} -> всегда HTTP 200: {status, json|text, ms} или {error}
POST /api/stream {url, method, headers, body} -> поток ответа как есть; реальный код в X-Upstream-Status
"""

import http.client
import json
import os
import ssl
import sys
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

APP_TITLE = "SiteAI"
ROOT = os.path.dirname(os.path.abspath(__file__))
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
PORT = int(ARGS[0]) if ARGS else 8787
TIMEOUT = 30
STREAM_TIMEOUT = 300
MAX_BODY = 8_000_000
DROP_HEADERS = {"host", "content-length", "connection", "accept-encoding", "origin", "referer"}


class Handler(SimpleHTTPRequestHandler):
    server_version = "SiteAI/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s  %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.split("?")[0] == "/api/health":
            self._json(200, {"ok": True, "app": APP_TITLE})
            return
        super().do_GET()

    def do_POST(self):
        route = self.path.split("?")[0]
        if route not in ("/api/proxy", "/api/stream"):
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY:
                self._json(200, {"error": "Пустой или слишком большой запрос."})
                return
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            url = str(payload.get("url") or "")
            method = str(payload.get("method") or "GET").upper()
            headers = {str(k): str(v) for k, v in (payload.get("headers") or {}).items()}
            body = payload.get("body")
        except Exception as exc:  # noqa: BLE001
            self._json(200, {"error": "Некорректный запрос к прокси: %s" % exc})
            return

        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            self._json(200, {"error": "Разрешены только адреса http/https."})
            return

        clean = {k: v for k, v in headers.items() if k.lower() not in DROP_HEADERS}
        data = None
        if body is not None:
            data = body.encode("utf-8") if isinstance(body, str) else json.dumps(body).encode("utf-8")
            clean.setdefault("Content-Type", "application/json")

        if route == "/api/stream":
            self._stream(parsed, method, clean, data)
        else:
            self._proxy(url, method, clean, data)

    def _proxy(self, url, method, headers, data):
        started = time.perf_counter()
        try:
            with urlopen(Request(url, data=data, headers=headers, method=method), timeout=TIMEOUT) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                status = resp.status
        except HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            status = exc.code
        except URLError as exc:
            self._json(200, {"error": "Не удалось подключиться: %s" % exc.reason})
            return
        except Exception as exc:  # noqa: BLE001
            self._json(200, {"error": "Запрос не выполнен: %s" % exc})
            return

        result = {"status": status, "ms": int((time.perf_counter() - started) * 1000)}
        try:
            result["json"] = json.loads(raw)
        except ValueError:
            result["text"] = raw[:8000]
        self._json(200, result)

    def _stream(self, parsed, method, headers, data):
        conn = None
        try:
            port = parsed.port
            if parsed.scheme == "https":
                conn = http.client.HTTPSConnection(
                    parsed.hostname, port or 443, timeout=STREAM_TIMEOUT, context=ssl.create_default_context()
                )
            else:
                conn = http.client.HTTPConnection(parsed.hostname, port or 80, timeout=STREAM_TIMEOUT)
            path = parsed.path or "/"
            if parsed.query:
                path += "?" + parsed.query
            conn.request(method, path, body=data, headers=headers)
            resp = conn.getresponse()
        except Exception as exc:  # noqa: BLE001
            if conn:
                conn.close()
            self._json(200, {"error": "Не удалось подключиться: %s" % exc})
            return

        try:
            self.send_response(200)
            self.send_header("Content-Type", resp.getheader("Content-Type") or "text/plain; charset=utf-8")
            self.send_header("X-Upstream-Status", str(resp.status))
            self.send_header("Connection", "close")
            self.end_headers()
            while True:
                chunk = resp.read1(2048)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            conn.close()
            self.close_connection = True

    def _json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = "http://localhost:%d" % PORT
    print("%s: %s" % (APP_TITLE, url))
    if "--no-browser" not in sys.argv:
        try:
            webbrowser.open(url)
        except Exception:  # noqa: BLE001
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
