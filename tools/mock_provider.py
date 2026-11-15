#!/usr/bin/env python3
"""Заглушка провайдера для проверки сайта без настоящего ключа.

    python tools/mock_provider.py 8899     ->  endpoint http://127.0.0.1:8899/v1, ключ любой

GET /v1/models и потоковый POST /v1/chat/completions (сначала reasoning_content, затем content).
Без заголовка Authorization: Bearer … отвечает 401. Модель "bad-model" даёт 400 с вложенной ошибкой,
"array-model" отдаёт content массивом частей, "json-model" отвечает без стриминга.
"""

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
MODELS = [
    "gpt-4o", "gpt-4o-mini", "o3-mini", "llama-3.3-70b-versatile", "mixtral-8x7b-32768",
    "array-model", "json-model", "bad-model", "slow-model", "qwen-2.5-coder-32b", "gemma-2-9b",
    "deepseek-chat", "deepseek-reasoner", "mistral-large-latest", "phi-4",
]
REASONING = (
    "Пользователь хочет короткий ответ: сначала суть, затем один пример. "
    "Без длинных списков, спокойным тоном."
)
ANSWER = (
    "Стриминг — это когда ответ приходит **не целиком**, а по кусочкам, по мере генерации.\n\n"
    "Как это выглядит:\n\n"
    "- модель предсказывает следующий токен;\n"
    "- сервер сразу отправляет его клиенту;\n"
    "- текст появляется на экране почти мгновенно.\n\n"
    "| Подход | Задержка | Память |\n"
    "|---|---|---|\n"
    "| Без стриминга | ждём весь ответ | низкая |\n"
    "| Стриминг | первый токен сразу | средняя |\n"
    "| Стриминг + SSE | первый токен сразу | **средняя** |\n\n"
    "Пример на `Python`:\n\n"
    "```python\nfor chunk in stream:\n    print(chunk, end=\"\")\n```\n\n"
    "```ask\nКакой вариант разобрать подробнее?\n"
    "- Стриминг на сервере\n"
    "- Обработка в браузере\n"
    "- Разбор ошибок\n"
    "```\n\n"
    "<script>window.__xss = 1</script> — этот тег должен остаться обычным текстом."
)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth_ok(self):
        return (self.headers.get("Authorization") or "").startswith("Bearer ")

    def do_GET(self):
        if not self.path.startswith("/v1/models"):
            return self._json(404, {"error": {"message": "not found"}})
        if not self._auth_ok():
            return self._json(401, {"error": {"message": "missing api key"}})
        return self._json(200, {"object": "list", "data": [{"id": m, "object": "model"} for m in MODELS]})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except Exception:
            req = {}
        if not self.path.startswith("/v1/chat/completions"):
            return self._json(404, {"error": {"message": "not found"}})
        if not self._auth_ok():
            return self._json(401, {"error": {"message": "missing api key"}})
        model = req.get("model")
        if model == "bad-model":
            return self._json(400, {"error": {"code": 400, "detail": {"reason": "unknown model"}}})
        if model == "json-model":
            return self._json(200, {"choices": [{"message": {"role": "assistant", "content": "Ответ без стриминга."}}]})

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Connection", "close")
        self.end_headers()
        pause = 0.25 if model == "slow-model" else 0.03

        def delta(obj):
            self.wfile.write(("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode())
            self.wfile.flush()

        try:
            for i in range(0, len(REASONING), 14):
                delta({"choices": [{"delta": {"reasoning_content": REASONING[i:i + 14]}}]})
                time.sleep(pause)
            for i in range(0, len(ANSWER), 6):
                piece = ANSWER[i:i + 6]
                content = [{"type": "text", "text": piece}] if model == "array-model" else piece
                delta({"choices": [{"delta": {"content": content}}]})
                time.sleep(pause)
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        self.close_connection = True


print("mock provider on http://127.0.0.1:%d/v1" % PORT)
ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
