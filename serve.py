#!/usr/bin/env python3
"""Photo2wire 開発サーバー

python3 -m http.server はキャッシュ制御ヘッダを送らないため、
JSモジュールの更新がブラウザに反映されないことがある。
このスクリプトは Cache-Control: no-store を付けて配信する。

使い方: python3 serve.py [port]   （デフォルト 8932）
"""
import functools
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # アクセスログは出さない


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8932
    root = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(NoCacheHandler, directory=root)
    server = http.server.ThreadingHTTPServer(('', port), handler)
    print(f'Photo2wire dev server: http://localhost:{port}/')
    server.serve_forever()


if __name__ == '__main__':
    main()
