/* html-slides ビューア：発表フォルダ（index.html + assets/）をブラウザで開き、表示・編集・PDF 化する。
   - Chrome / Edge：フォルダの読み書き（File System Access API）。発表者ビューの編集を index.html に書き戻す
   - それ以外：フォルダを読み込むだけ（編集はブラウザ内に保存）
   ファイルの配信は sw.js が担い、このタブに問い合わせる。このタブを閉じるとスライドも表示できなくなる。 */
(function () {
  const $ = (s) => document.querySelector(s);
  const SKIP_DIRS = new Set(['dist', 'node_modules', 'assets', 'deck', 'tools', '__pycache__']);
  const MIME = {
    html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
    json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', pdf: 'application/pdf', woff2: 'font/woff2', woff: 'font/woff',
    ttf: 'font/ttf', otf: 'font/otf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  };
  const canPick = 'showDirectoryPicker' in window;
  const sessions = new Map();   // sid -> { name, dir?, files?, writable, backed:Set }

  // ------------------------------------------------------------------ IndexedDB（前回のフォルダ）
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('html-slides-viewer', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('folders');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbAll() {
    try {
      const db = await idb();
      return await new Promise((res) => {
        const out = [];
        const cur = db.transaction('folders').objectStore('folders').openCursor();
        cur.onsuccess = () => { const c = cur.result; if (c) { out.push(Object.assign({ sid: c.key }, c.value)); c.continue(); } else res(out); };
        cur.onerror = () => res(out);
      });
    } catch (e) { return []; }
  }
  async function idbPut(sid, value) {
    try {
      const db = await idb();
      db.transaction('folders', 'readwrite').objectStore('folders').put(value, sid);
    } catch (e) { /* 保存できなくても使える */ }
  }
  async function idbDel(sid) {
    try { const db = await idb(); db.transaction('folders', 'readwrite').objectStore('folders').delete(sid); } catch (e) {}
  }

  function newSid(name) {
    const slug = (name || 'deck').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'deck';
    return slug + '-' + Math.random().toString(36).slice(2, 8);
  }

  // ------------------------------------------------------------------ ファイルの読み書き
  function splitPath(path) {
    const parts = path.split('/').filter((p) => p && p !== '.');
    if (parts.some((p) => p === '..')) throw new Error('bad path');
    return parts;
  }
  async function dirOf(dir, parts, create) {
    let d = dir;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create: !!create });
    return d;
  }
  async function readFile(s, path) {
    const parts = splitPath(path);
    if (s.dir) {
      const d = await dirOf(s.dir, parts.slice(0, -1));
      return await (await d.getFileHandle(parts[parts.length - 1])).getFile();
    }
    const f = s.files.get(parts.join('/'));
    if (!f) throw new Error('not found');
    return f;
  }
  async function writeFile(s, path, text) {
    const parts = splitPath(path);
    const d = await dirOf(s.dir, parts.slice(0, -1), true);
    const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
    await w.write(text);
    await w.close();
  }
  async function readText(s, path) { return await (await readFile(s, path)).text(); }

  async function listDecks(s) {
    const out = [];
    if (s.dir) {
      const walk = async (d, prefix) => {
        for await (const [name, h] of d.entries()) {
          if (h.kind === 'directory') {
            if (!name.startsWith('.') && !SKIP_DIRS.has(name)) await walk(h, prefix + name + '/');
          } else if (name.endsWith('.html')) out.push(prefix + name);
        }
      };
      await walk(s.dir, '');
    } else {
      for (const p of s.files.keys()) {
        const segs = p.split('/');
        if (!p.endsWith('.html')) continue;
        if (segs.slice(0, -1).some((x) => x.startsWith('.') || SKIP_DIRS.has(x))) continue;
        out.push(p);
      }
    }
    return out.sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
  }

  // ------------------------------------------------------------------ serve.py と同じ書き戻し
  const SECTION_RE = /<section class="slide[^"]*"[^>]*>[\s\S]*?<\/section>/g;
  const ASIDE_RE = /<aside class="notes">[\s\S]*?<\/aside>/;
  const TITLE_RE = /<h2>([\s\S]*?)<\/h2>|<p class="st">([\s\S]*?)<\/p>|<h1>([\s\S]*?)<\/h1>/;
  const squash = (t) => (t || '').replace(/\s+/g, '');
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  function stripTags(t) {
    const d = new DOMParser().parseFromString('<body>' + (t || '').replace(/<[^>]+>/g, '') + '</body>', 'text/html');
    return (d.body.textContent || '').trim();
  }
  function sections(src) { return [...src.matchAll(SECTION_RE)]; }
  function slideTitle(sec) {
    const m = sec.match(TITLE_RE);
    return m ? stripTags(m[1] || m[2] || m[3] || '') : '';
  }
  function textToAside(text) {
    const paras = text.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (!paras.length) return '<aside class="notes"></aside>';
    return '<aside class="notes">' + paras.map((p) => '\n    <p>' + esc(p).replace(/\n/g, '<br>') + '</p>').join('') + '\n  </aside>';
  }
  function reEscape(t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function findAll(sec, needle) {
    const pos = [];
    let i = sec.indexOf(needle);
    while (i >= 0) { pos.push(i); i = sec.indexOf(needle, i + 1); }
    if (pos.length) return { pos, matched: needle };
    const parts = needle.split(/\s+/).filter(Boolean).map(reEscape);
    if (!parts.length) return { pos: [], matched: needle };
    const ms = [...sec.matchAll(new RegExp(parts.join('\\s+'), 'g'))];
    return { pos: ms.map((m) => m.index), matched: ms.length ? ms[0][0] : needle };
  }
  function stamp() {
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds());
  }
  async function backupOnce(s, path, src) {
    if (s.backed.has(path)) return;
    s.backed.add(path);
    await writeFile(s, 'dist/' + path.split('/').pop() + '.bak-' + stamp(), src);
  }
  function deckPath(s, file) {
    // deck.js は location.pathname から「html-slides/view/<sid>/index.html」を送ってくる
    const key = 'view/' + s.sid + '/';
    const i = (file || '').indexOf(key);
    return i >= 0 ? file.slice(i + key.length) : (file || 'index.html');
  }
  let lock = Promise.resolve();
  function locked(fn) { const p = lock.then(fn, fn); lock = p.catch(() => {}); return p; }

  async function writeBack(s, kind, req) {
    const path = deckPath(s, req.file);
    const src = await readText(s, path);
    const secs = sections(src);
    const index = +req.index;
    if (!(index >= 0 && index < secs.length)) return { ok: false, error: 'index out of range (' + index + ' / ' + secs.length + ')' };
    const sec = secs[index][0];
    const found = slideTitle(sec), want = (req.title || '').trim();
    if (want && found && squash(found) !== squash(want)) return { ok: false, error: 'title mismatch: file has "' + found + '", client sent "' + want + '"' };
    let newSec;
    if (kind === 'notes') {
      const aside = textToAside(req.text || '');
      newSec = ASIDE_RE.test(sec) ? sec.replace(ASIDE_RE, () => aside) : sec.slice(0, -'</section>'.length) + '  ' + aside + '\n</section>';
    } else {
      const old = req.old || '', nw = req.new || '', nth = +(req.nth || 0);
      if (!old || !nw || /<\/section>|<aside|<section/.test(nw)) return { ok: false, error: 'bad payload' };
      const { pos, matched } = findAll(sec, old);
      if (!pos.length) return { ok: false, error: 'text not found in slide ' + (index + 1) };
      if (nth < 0 || nth >= pos.length) return { ok: false, error: 'occurrence ' + nth + ' not found (' + pos.length + ' found)' };
      const at = pos[nth];
      const len = sec.substr(at, old.length) === old ? old.length : matched.length;
      newSec = sec.slice(0, at) + nw + sec.slice(at + len);
    }
    const name = path.split('/').pop();
    if (newSec === sec) return { ok: true, changed: false, file: name };
    await backupOnce(s, path, src);
    const start = secs[index].index;
    await writeFile(s, path, src.slice(0, start) + newSec + src.slice(start + sec.length));
    return { ok: true, changed: true, title: found, file: name };
  }

  // ------------------------------------------------------------------ Service Worker からの問い合わせ
  navigator.serviceWorker.addEventListener('message', async (ev) => {
    const m = ev.data, port = ev.ports[0];
    if (!m || m.type !== 'html-slides' || !port) return;
    const s = sessions.get(m.sid);
    if (!s) { port.postMessage({ handled: false }); return; }
    try {
      if (m.op === 'get') {
        let f;
        try { f = await readFile(s, m.path); } catch (e) { port.postMessage({ handled: true, status: 404 }); return; }
        const ext = (m.path.split('.').pop() || '').toLowerCase();
        const body = await f.arrayBuffer();
        port.postMessage({ handled: true, status: 200, contentType: MIME[ext] || f.type || 'application/octet-stream', body }, [body]);
      } else if (m.op === 'ping') {
        port.postMessage({ handled: true, result: { ok: s.writable, root: s.name } });
      } else if (m.op === 'notes' || m.op === 'text') {
        if (!s.writable) { port.postMessage({ handled: true, result: { ok: false, error: 'read-only folder' } }); return; }
        const req = JSON.parse(m.body || '{}');
        const result = await locked(() => writeBack(s, m.op, req));
        port.postMessage({ handled: true, result });
      } else {
        port.postMessage({ handled: true, result: { ok: false, error: 'unknown op' } });
      }
    } catch (e) {
      port.postMessage({ handled: true, status: 500, result: { ok: false, error: String(e && e.message || e) } });
    }
  });

  // ------------------------------------------------------------------ 画面
  function viewUrl(sid, path, params) {
    return 'view/' + encodeURIComponent(sid) + '/' + path.split('/').map(encodeURIComponent).join('/') + '?' + params;
  }
  function openPrint(url) {
    const w = window.open(url, '_blank');
    if (!w) { alert('ポップアップがブロックされました。このサイトのポップアップを許可してください。'); return; }
    w.addEventListener('load', () => {
      const go = () => setTimeout(() => w.print(), 600);
      (w.document.fonts && w.document.fonts.ready ? w.document.fonts.ready : Promise.resolve()).then(go, go);
    });
  }
  function button(label, onClick, cls) {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', onClick);
    return b;
  }

  async function renderSession(s) {
    const box = $('#decks');
    box.hidden = false;
    $('#folder-name').textContent = s.name;
    $('#folder-mode').textContent = s.writable
      ? '読み書き：発表者ビューで編集したノート・本文は、このフォルダのファイルに自動保存されます'
      : '読み込みのみ：編集はブラウザ内に保存されます（Chrome か Edge なら書き戻せます）';
    const ul = $('#deck-list');
    ul.textContent = '';
    const decks = await listDecks(s);
    if (!decks.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'このフォルダに .html がありません。index.html の入った発表フォルダを選んでください。';
      ul.appendChild(li);
      return;
    }
    for (const d of decks) {
      const li = document.createElement('li');
      const f = document.createElement('span');
      f.className = 'f';
      f.textContent = d;
      li.appendChild(f);
      li.appendChild(button('発表者ビュー', () => window.open(viewUrl(s.sid, d, 'mode=notes'), '_blank')));
      li.appendChild(button('本番', () => window.open(viewUrl(s.sid, d, 'mode=present'), '_blank')));
      li.appendChild(button('PDF', () => openPrint(viewUrl(s.sid, d, 'mode=print'))));
      li.appendChild(button('ノート付き PDF', () => openPrint(viewUrl(s.sid, d, 'mode=print&notes=1'))));
      ul.appendChild(li);
    }
  }

  async function activate(s) {
    s.backed = new Set();
    sessions.set(s.sid, s);
    await renderSession(s);
  }

  async function pickFolder() {
    let dir;
    try { dir = await window.showDirectoryPicker({ id: 'html-slides', mode: 'readwrite' }); }
    catch (e) { return; }  // キャンセル
    const known = await idbAll();
    let sid = null;
    for (const k of known) {
      try { if (k.dir && await k.dir.isSameEntry(dir)) { sid = k.sid; break; } } catch (e) {}
    }
    sid = sid || newSid(dir.name);
    await idbPut(sid, { name: dir.name, dir, at: Date.now() });
    await activate({ sid, name: dir.name, dir, writable: true });
    renderRecent();
  }

  function loadFileList(fileList) {
    const files = new Map();
    let root = '';
    for (const f of fileList) {
      const rel = f.webkitRelativePath || f.name;
      const segs = rel.split('/');
      root = root || (segs.length > 1 ? segs[0] : '');
      files.set(segs.length > 1 ? segs.slice(1).join('/') : rel, f);
    }
    const name = root || 'folder';
    activate({ sid: newSid(name), name, files, writable: false });
  }

  async function reopen(k) {
    try {
      let perm = await k.dir.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') perm = await k.dir.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') return;
      await idbPut(k.sid, { name: k.name, dir: k.dir, at: Date.now() });
      await activate({ sid: k.sid, name: k.name, dir: k.dir, writable: true });
    } catch (e) {
      alert('フォルダを開けませんでした（移動・削除された可能性があります）。もう一度選んでください。');
      await idbDel(k.sid);
      renderRecent();
    }
  }

  async function renderRecent() {
    const box = $('#recent');
    const ul = $('#recent-list');
    ul.textContent = '';
    if (!canPick) { box.hidden = true; return; }
    const known = (await idbAll()).filter((k) => k.dir).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 8);
    box.hidden = !known.length;
    for (const k of known) {
      const li = document.createElement('li');
      const f = document.createElement('span');
      f.className = 'f';
      f.textContent = k.name;
      li.appendChild(f);
      li.appendChild(button('開く', () => reopen(k)));
      li.appendChild(button('履歴から消す', async () => { await idbDel(k.sid); renderRecent(); }, 'ghost'));
      ul.appendChild(li);
    }
  }

  async function init() {
    if (!('serviceWorker' in navigator)) {
      $('#status').textContent = 'このブラウザは Service Worker に対応していないため、ビューアを使えません。';
      return;
    }
    // このページは scope（view/）の外なので serviceWorker.ready は解決しない。登録した worker の起動を直接待つ
    const reg = await navigator.serviceWorker.register('sw.js', { scope: 'view/' });
    const sw = reg.installing || reg.waiting;
    if (!reg.active && sw) {
      await new Promise((res) => sw.addEventListener('statechange', () => { if (sw.state === 'activated') res(); }));
    }
    $('#pick').hidden = !canPick;
    $('#pick-ro').hidden = canPick;
    $('#pick').addEventListener('click', pickFolder);
    $('#input-ro').addEventListener('change', (e) => { if (e.target.files.length) loadFileList(e.target.files); });
    $('#status').textContent = canPick ? '' : 'このブラウザではフォルダへの書き戻しができません（Chrome / Edge なら可能）。';
    renderRecent();
  }

  // 動作確認用：任意の FileSystemDirectoryHandle を開く（OPFS など）
  window.htmlSlidesViewer = {
    openHandle: async (dir, name) => {
      const sid = newSid(name || dir.name);
      await activate({ sid, name: name || dir.name || 'folder', dir, writable: true });
      return sid;
    },
  };

  init();
})();
