#!/usr/bin/env python3
"""
TOLYQ — статический сервер для разработки.

Отличается от `python3 -m http.server` ровно одним: отдаёт Cache-Control:
no-store. Браузер кэширует ES-модули очень цепко, и после правки исходника
страница молча показывает результаты СТАРОГО кода — тесты «проходят»,
хотя проверяют не то, что лежит на диске. За ночь разработки такая ошибка
стоит дороже, чем пятнадцать строк своего сервера.

    python3 tools/serve.py            # порт 8000
    python3 tools/serve.py 8080

На защите ничего этого не нужно: обычный `python3 -m http.server 8000`
работает точно так же, просто с кэшем.
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Тихо: в консоли нужен вывод тестов, а не журнал запросов.
        pass


def main():
    # Консоль Windows по умолчанию в cp1252 и падает на кириллице в print.
    # Переключаем поток на UTF-8; где это не поддерживается — заменяем
    # непечатаемое, но сервер в любом случае должен подняться.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = partial(NoCacheHandler, directory=".")
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    print(f"TOLYQ: http://localhost:{port}/tests/run.html  (кэш отключён)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nостановлен")


if __name__ == "__main__":
    main()
