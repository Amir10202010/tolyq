#!/usr/bin/env python3
"""
Статика без кэша — только для разработки.

Обычный `python -m http.server` отдаёт ES-модули с Last-Modified, браузер
кэширует их эвристически, и правка в src/ui/*.js не подхватывается до
жёсткой перезагрузки. На хакатоне это стоит слишком дорого.

На защите ничего этого не нужно: проект открывается обычным
    python3 -m http.server 8000
Файл можно удалить, на приложение он никак не влияет.
"""

import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        # 404 на src/core/*.js — это штатная проба движка, не шумим
        if '404' in (fmt % args) and '/src/core/' in (fmt % args):
            return
        super().log_message(fmt, *args)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    # без кириллицы: консоль Windows по умолчанию в cp1252 и падает на ней
    print(f'TOLYQ dev server (no-cache): http://localhost:{port}')
    ThreadingHTTPServer(('127.0.0.1', port), NoCacheHandler).serve_forever()
