#!/usr/bin/env python3
"""
serve.py — プレゼンツール本体。スライドHTMLを配信し、発表者ビューの編集を元ファイルに書き戻す。

  python3 ~/ghq/github.com/rintaro-chujo/html-slides/tools/serve.py        # 今いるフォルダのデッキを配信し、ブラウザを開く
  python3 .../html-slides/tools/serve.py path/to/slides.html   # そのファイルを読み込んで起動
  python3 .../html-slides/tools/serve.py path/to/folder        # そのフォルダの *.html を一覧に出す
  python3 .../html-slides/tools/serve.py --no-open --port 9000 # ブラウザを開かない／別ポート

- 配信ルート下（サブフォルダ可）の *.html をデッキとして扱う。`/` は一覧ページ（ランチャ）。
- スライドが読む deck/deck.css・deck/deck.js は、そのフォルダに無ければ**このツール同梱の deck/** を返す。
- スライドが公開版 https://rintaro-chujo.github.io/html-slides/v<N>/deck/ を読んでいても、N がこの箱の
  メジャー版（VERSION）と同じなら、配信時に /__box/deck/ に書き換えて手元の deck/ を返す（オフラインでも開ける）。
  発表フォルダにツールのコピーを置かずに開ける（export.py もこのサーバ経由で読むのでコピー不要）。

- GET  /__ping   → {"ok": true}（デッキ側はこれで「書き戻し可能」を判定）
- POST /__notes  → {"file": "index.html", "index": <全 section 中の0始まり順位>,
                    "title": "<見出し>", "text": "<ノート本文>"}
                   text は空行区切りの段落。<p>…</p> にして該当 section の <aside class="notes"> を置換。
                   file は配信ルート直下の *.html に限る（同じフォルダに複数バージョンがあっても取り違えない）。
- POST /__text   → {"file", "index", "title", "old": "<置換前の要素 outerHTML>", "nth": <同一文字列の何番目か>, "new": "<置換後>"}
                   発表者ビューの本文編集。該当 section 内で old の nth 番目の出現を new に置き換える。
- 静的配信はマルチスレッド（画像が多くても詰まらない）。
- 各ファイルへの最初の書き込み前に dist/<name>.bak-<時刻> を1回だけ取る。書き込みは一時ファイル→rename。
"""
import argparse, errno, html, json, mimetypes, os, re, shutil, sys, threading, time, urllib.parse, urllib.request, webbrowser
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

BOX = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOL_DECK = os.path.join(BOX, 'deck')
try:
    BOX_VERSION = open(os.path.join(BOX, 'VERSION')).read().strip()
except OSError:
    BOX_VERSION = '0'
PUBLIC_DECK_RE = re.compile(r'https://rintaro-chujo\.github\.io/html-slides/(v[0-9][0-9.]*|latest)/deck/')


def localize_public_deck(src: str) -> str:
    """公開版 deck の URL を、メジャー版が同じなら手元の /__box/deck/ に向け直す。"""
    major = 'v' + BOX_VERSION.split('.')[0]

    def sub(m):
        v = m.group(1)
        return '/__box/deck/' if v == 'latest' or v == major or v.startswith(major + '.') else m.group(0)
    return PUBLIC_DECK_RE.sub(sub, src)

SECTION_RE = re.compile(r'<section class="slide[^"]*"[^>]*>.*?</section>', re.S)
ASIDE_RE = re.compile(r'<aside class="notes">.*?</aside>', re.S)
TITLE_RE = re.compile(r'<h2>(.*?)</h2>|<p class="st">(.*?)</p>|<h1>(.*?)</h1>', re.S)
LOCK = threading.Lock()
BACKED = set()


def strip_tags(s: str) -> str:
    return html.unescape(re.sub(r'<[^>]+>', '', s or '')).strip()


def text_to_aside(text: str) -> str:
    paras = [p.strip() for p in re.split(r'\n\s*\n', text.strip()) if p.strip()]
    if not paras:
        return '<aside class="notes"></aside>'
    body = ''.join('\n    <p>%s</p>' % html.escape(p).replace('\n', '<br>') for p in paras)
    return '<aside class="notes">%s\n  </aside>' % body


def backup_once(path: str, root: str) -> None:
    if path in BACKED:
        return
    BACKED.add(path)
    dist = os.path.join(root, 'dist')
    os.makedirs(dist, exist_ok=True)
    dst = os.path.join(dist, '%s.bak-%s' % (os.path.basename(path), time.strftime('%Y%m%d-%H%M%S')))
    shutil.copy2(path, dst)
    print('[serve] backup %s' % os.path.relpath(dst, root), flush=True)


def write_notes(path: str, root: str, index: int, title: str, text: str) -> dict:
    with LOCK:
        src = open(path, encoding='utf-8').read()
        secs = list(SECTION_RE.finditer(src))
        if index < 0 or index >= len(secs):
            return {'ok': False, 'error': 'index out of range (%d / %d)' % (index, len(secs))}
        sec = secs[index].group(0)
        m = TITLE_RE.search(sec)
        found = strip_tags(next((g for g in m.groups() if g), '')) if m else ''
        want = (title or '').strip()
        if want and found and re.sub(r'\s+', '', found) != re.sub(r'\s+', '', want):
            return {'ok': False, 'error': 'title mismatch: file has "%s", client sent "%s"' % (found, want)}
        new_aside = text_to_aside(text)
        if ASIDE_RE.search(sec):
            new_sec = ASIDE_RE.sub(lambda _: new_aside, sec, count=1)
        else:
            new_sec = sec[:-len('</section>')] + '  ' + new_aside + '\n</section>'
        if new_sec == sec:
            return {'ok': True, 'changed': False, 'file': os.path.basename(path)}
        backup_once(path, root)
        out = src[:secs[index].start()] + new_sec + src[secs[index].end():]
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(out)
        os.replace(tmp, path)
        return {'ok': True, 'changed': True, 'title': found, 'file': os.path.basename(path)}


def _find_all(sec: str, needle: str):
    """sec 内での needle の出現位置。完全一致がなければ空白の違いを許して探す。"""
    pos = [m.start() for m in re.finditer(re.escape(needle), sec)]
    if pos:
        return pos, needle
    parts = [re.escape(t) for t in needle.split()]
    if not parts:
        return [], needle
    rx = re.compile(r'\s+'.join(parts))
    ms = list(rx.finditer(sec))
    return [m.start() for m in ms], (ms[0].group(0) if ms else needle)


def write_text(path: str, root: str, index: int, title: str, old: str, nth: int, new: str) -> dict:
    with LOCK:
        src = open(path, encoding='utf-8').read()
        secs = list(SECTION_RE.finditer(src))
        if index < 0 or index >= len(secs):
            return {'ok': False, 'error': 'index out of range (%d / %d)' % (index, len(secs))}
        sec = secs[index].group(0)
        m = TITLE_RE.search(sec)
        found = strip_tags(next((g for g in m.groups() if g), '')) if m else ''
        want = (title or '').strip()
        if want and found and re.sub(r'\s+', '', found) != re.sub(r'\s+', '', want):
            return {'ok': False, 'error': 'title mismatch: file has "%s", client sent "%s"' % (found, want)}
        if not old or not new or '</section>' in new or '<aside' in new or '<section' in new:
            return {'ok': False, 'error': 'bad payload'}
        pos, matched = _find_all(sec, old)
        if not pos:
            return {'ok': False, 'error': 'text not found in slide %d' % (index + 1)}
        if nth < 0 or nth >= len(pos):
            return {'ok': False, 'error': 'occurrence %d not found (%d found)' % (nth, len(pos))}
        # 完全一致で探せたときは old の長さ、空白ゆるめのときは実際にマッチした長さで切る
        at = pos[nth]
        length = len(old) if sec[at:at + len(old)] == old else len(matched)
        new_sec = sec[:at] + new + sec[at + length:]
        if new_sec == sec:
            return {'ok': True, 'changed': False, 'file': os.path.basename(path)}
        backup_once(path, root)
        out = src[:secs[index].start()] + new_sec + src[secs[index].end():]
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(out)
        os.replace(tmp, path)
        return {'ok': True, 'changed': True, 'title': found, 'file': os.path.basename(path)}


SKIP_DIRS = {'dist', 'node_modules', 'assets', 'deck', 'tools', '__pycache__'}

LAUNCHER_CSS = (
    'body{font-family:-apple-system,"Hiragino Sans",sans-serif;background:#1b1b1b;color:#eee;margin:0;padding:40px;line-height:1.7}'
    'h1{font-size:22px;margin:0 0 6px}.root{color:#999;font-size:13px;margin:0 0 28px;word-break:break-all}'
    'ul{list-style:none;padding:0;margin:0;max-width:860px}'
    'li{display:flex;align-items:center;gap:12px;background:#2a2a2a;border-radius:10px;padding:14px 18px;margin-bottom:10px}'
    '.f{flex:1;font-size:17px;font-weight:600;word-break:break-all}'
    'a{color:#fff;background:#444;border:1px solid #666;border-radius:6px;padding:6px 12px;text-decoration:none;font-size:14px;white-space:nowrap}'
    'a:hover{background:#c00000;border-color:#c00000}'
    '.empty{color:#999}.tip{color:#888;font-size:13px;margin-top:26px;max-width:860px}'
)


def find_decks(root: str):
    """配信ルート下の *.html（dist/ などは除く）を相対パスで返す。"""
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith('.') and d not in SKIP_DIRS]
        for f in filenames:
            if f.endswith('.html'):
                out.append(os.path.relpath(os.path.join(dirpath, f), root))
    return sorted(out)


def launcher_page(root: str, decks) -> bytes:
    """/ に出すデッキ一覧（どのスライドを開くか選ぶページ）。"""
    rows = []
    for d in decks:
        u = '/' + d.replace(os.sep, '/')
        rows.append('<li><span class="f">%s</span>'
                    '<a href="%s?mode=notes">発表者ビュー</a>'
                    '<a href="%s?mode=present">本番</a>'
                    '<a href="%s?mode=print">印刷用</a></li>' % (html.escape(d), u, u, u))
    body = ('<ul>%s</ul>' % ''.join(rows)) if rows else '<p class="empty">このフォルダに .html がありません。</p>'
    page = ('<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>スライドを開く</title>'
            '<style>%s</style></head><body><h1>スライドを開く</h1><p class="root">%s</p>%s'
            '<p class="tip">発表者ビューで編集したノート・本文は、開いているファイルに書き戻します。'
            '別のフォルダのスライドを開くときは、そのパスを引数にしてサーバを起動し直してください。</p>'
            '</body></html>') % (LAUNCHER_CSS, html.escape(root), body)
    return page.encode('utf-8')


def make_handler(root: str, default_html: str):
    def resolve(name):
        """配信ルート下の既存 *.html だけを書き込み対象にする（サブフォルダ可）。"""
        if not name:
            return default_html
        name = name.split('?')[0].lstrip('/')
        if not name.endswith('.html') or '..' in name.split('/'):
            return None
        p = os.path.abspath(os.path.join(root, name))
        if os.path.commonpath([p, os.path.abspath(root)]) != os.path.abspath(root):
            return None
        return p if os.path.isfile(p) else None

    class H(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=root, **kw)

        def log_message(self, fmt, *args):  # 静かに
            if self.path.startswith('/__'):
                sys.stderr.write('[serve] %s\n' % (fmt % args))

        def _json(self, code, obj):
            data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)

        def end_headers(self):
            if self.path.endswith('.html') or self.path.startswith('/__'):
                self.send_header('Cache-Control', 'no-store')
            super().end_headers()

        def _send_bytes(self, data, ctype):
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            p = self.path.split('?')[0]
            if p == '/__ping':
                return self._json(200, {'ok': True, 'root': os.path.basename(root)})
            if p in ('/', '/__decks'):
                return self._send_bytes(launcher_page(root, find_decks(root)), 'text/html; charset=utf-8')
            base = os.path.basename(p)
            if p.startswith('/__box/deck/') and base in ('deck.css', 'deck.js'):
                ctype = mimetypes.guess_type(base)[0] or 'application/octet-stream'
                return self._send_bytes(open(os.path.join(TOOL_DECK, base), 'rb').read(), ctype)
            if p.endswith('.html'):
                local = resolve(urllib.parse.unquote(p))
                if local:
                    src = open(local, encoding='utf-8').read()
                    return self._send_bytes(localize_public_deck(src).encode('utf-8'), 'text/html; charset=utf-8')
            if base in ('deck.css', 'deck.js') and '/deck/' in p:
                local = os.path.join(root, p.lstrip('/').replace('/', os.sep))
                if not os.path.isfile(local):
                    fallback = os.path.join(TOOL_DECK, base)
                    if os.path.isfile(fallback):
                        ctype = mimetypes.guess_type(fallback)[0] or 'application/octet-stream'
                        return self._send_bytes(open(fallback, 'rb').read(), ctype)
            return super().do_GET()

        def do_POST(self):
            ep = self.path.split('?')[0]
            if ep not in ('/__notes', '/__text'):
                return self._json(404, {'ok': False, 'error': 'unknown endpoint'})
            n = int(self.headers.get('Content-Length') or 0)
            try:
                body = json.loads(self.rfile.read(n).decode('utf-8'))
                target = resolve(body.get('file'))
                if not target:
                    res = {'ok': False, 'error': 'unknown file: %r' % body.get('file')}
                elif ep == '/__text':
                    res = write_text(target, root, int(body['index']), body.get('title', ''),
                                     body.get('old', ''), int(body.get('nth', 0)), body.get('new', ''))
                else:
                    res = write_notes(target, root, int(body['index']), body.get('title', ''), body.get('text', ''))
            except Exception as e:  # noqa
                res = {'ok': False, 'error': str(e)}
            return self._json(200 if res.get('ok') else 400, res)

    return H


def main():
    ap = argparse.ArgumentParser(description='スライドHTMLを配信し、発表者ビューの編集を書き戻すプレゼンツール')
    ap.add_argument('target', nargs='?', help='開くスライド .html、またはデッキの入ったフォルダ')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--bind', default='127.0.0.1')
    ap.add_argument('--html', help='target と同じ（互換のため）')
    ap.add_argument('--open', dest='open_browser', action='store_true', default=True, help='起動時にブラウザを開く（既定）')
    ap.add_argument('--no-open', dest='open_browser', action='store_false')
    a = ap.parse_args()

    target = os.path.abspath(os.path.expanduser(a.target or a.html or os.getcwd()))
    if os.path.isdir(target):
        root, default_html = target, None
    elif os.path.isfile(target):
        root, default_html = os.path.dirname(target), target
    else:
        sys.exit('見つかりません: %s' % target)
    decks = find_decks(root)
    if default_html is None and len(decks) == 1:
        default_html = os.path.join(root, decks[0])

    def deck_url(port):
        b = 'http://%s:%d' % (a.bind, port)
        if default_html:
            return b + '/' + os.path.relpath(default_html, root).replace(os.sep, '/') + '?mode=notes'
        return b + '/'

    def ping(port):
        """そのポートで動いているのが同じツールかどうか。"""
        try:
            with urllib.request.urlopen('http://%s:%d/__ping' % (a.bind, port), timeout=0.8) as r:
                j = json.loads(r.read().decode('utf-8'))
                return j if j.get('ok') else None
        except Exception:
            return None

    handler = make_handler(root, default_html)
    srv, port = None, a.port
    try:
        srv = ThreadingHTTPServer((a.bind, port), handler)
    except OSError as e:
        if e.errno != errno.EADDRINUSE:
            raise
        running = ping(port)
        if running:
            same = running.get('root') == os.path.basename(root)
            print('[serve] ポート %d では既に同じツールが動いています（root=%s）。起動せずにそれを使います。'
                  % (port, running.get('root')), flush=True)
            if not same:
                print('[serve] ただし配信フォルダが違います（今回の指定: %s）。'
                      '別に立てるなら --port で空きポートを指定してください。' % os.path.basename(root), flush=True)
                return
            print('[serve] %s' % deck_url(port), flush=True)
            if a.open_browser:
                webbrowser.open(deck_url(port))
            return
        for cand in range(a.port + 1, a.port + 10):
            try:
                srv = ThreadingHTTPServer((a.bind, cand), handler)
                port = cand
                break
            except OSError:
                continue
        if srv is None:
            sys.exit('ポート %d〜%d がすべて使用中です。--port で指定してください。' % (a.port, a.port + 9))
        print('[serve] ポート %d は別のプロセスが使用中のため %d で起動します。' % (a.port, port), flush=True)

    base = 'http://%s:%d' % (a.bind, port)
    print('[serve] root=%s' % root, flush=True)
    print('[serve] 一覧 %s/' % base, flush=True)
    for d in decks:
        print('[serve]   %s/%s?mode=notes' % (base, d.replace(os.sep, '/')), flush=True)
    if a.open_browser:
        threading.Timer(0.3, lambda: webbrowser.open(deck_url(port))).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
