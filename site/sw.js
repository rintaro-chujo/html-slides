/* html-slides ビューアの Service Worker（scope: ./view/）
   /view/<sid>/<path> へのリクエストを、フォルダを開いているビューアのタブに問い合わせて返す。
   スライドの deck.js が叩く /__ping /__notes /__text も、ビューアのタブに転送して書き戻す。
   ビューアのタブを閉じると、そのフォルダのスライドは表示できなくなる。 */
const DEFAULT_DECK = 'v1';   // build-site.py が最新のメジャー版に書き換える
const SCOPE = new URL(self.registration.scope).pathname;          // /html-slides/view/
const SITE = SCOPE.replace(/view\/$/, '');                         // /html-slides/
const API = ['/__ping', '/__notes', '/__text'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

function parseViewPath(pathname) {
  if (!pathname.startsWith(SCOPE)) return null;
  const rest = pathname.slice(SCOPE.length);
  const i = rest.indexOf('/');
  if (i <= 0) return null;
  return { sid: rest.slice(0, i), path: decodeURIComponent(rest.slice(i + 1)) || 'index.html' };
}

async function ask(msg) {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const viewers = wins.filter((c) => {
    const p = new URL(c.url).pathname;
    return p === SITE || p === SITE + 'index.html';
  });
  for (const c of viewers) {
    const res = await new Promise((resolve) => {
      const ch = new MessageChannel();
      const t = setTimeout(() => resolve(null), 4000);
      ch.port1.onmessage = (ev) => { clearTimeout(t); resolve(ev.data); };
      c.postMessage(Object.assign({ type: 'html-slides' }, msg), [ch.port2]);
    });
    if (res && res.handled) return res;
  }
  return null;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const CLOSED = '<!DOCTYPE html><meta charset="utf-8"><title>ビューアが閉じています</title>' +
  '<body style="font-family:sans-serif;padding:40px;line-height:1.8">' +
  '<h1>フォルダを開いているビューアのタブが見つかりません</h1>' +
  '<p>このスライドは、ビューアのタブがフォルダの中身を渡して表示しています。' +
  '<a href="' + SITE + '">ビューア</a>でフォルダを開き直してから、もう一度開いてください。</p></body>';

async function serveFile(sid, path) {
  const res = await ask({ op: 'get', sid, path });
  if (!res) return new Response(CLOSED, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if (res.status === 404) {
    const m = path.match(/(^|\/)deck\/(deck\.(css|js))$/);
    if (m) return fetch(SITE + DEFAULT_DECK + '/deck/' + m[2]);
    return new Response('Not found: ' + path, { status: 404 });
  }
  return new Response(res.body, {
    status: 200,
    headers: { 'Content-Type': res.contentType, 'Cache-Control': 'no-store' },
  });
}

async function serveApi(event, name) {
  const client = event.clientId ? await self.clients.get(event.clientId) : null;
  const v = client ? parseViewPath(new URL(client.url).pathname) : null;
  if (!v) return json({ ok: false, error: 'not opened from the viewer' }, 400);
  const body = event.request.method === 'POST' ? await event.request.text() : '';
  const res = await ask({ op: name, sid: v.sid, body });
  if (!res) return json({ ok: false, error: 'viewer tab is closed' }, 503);
  return json(res.result, res.result && res.result.ok ? 200 : 400);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (API.includes(url.pathname)) {
    event.respondWith(serveApi(event, url.pathname.slice(3)));
    return;
  }
  const v = parseViewPath(url.pathname);
  if (v && event.request.method === 'GET') event.respondWith(serveFile(v.sid, v.path));
});
