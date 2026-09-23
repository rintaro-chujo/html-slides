/* =========================================================================
   Deck engine（プレゼンツール本体）
   - index.html などの「中身ファイル」は deck.css と deck.js を読み込むだけ。
   - 発表者ビュー・一覧・ヘルプの DOM はここで生成する（中身ファイルには書かない）。
   - 正本は https://github.com/rintaro-chujo/html-slides の deck/。
   ========================================================================= */
(function(){
  const q = new URLSearchParams(location.search);
  const MODE = q.get('mode') || 'present';           // present | notes | print
  const PRINT_NOTES = q.get('notes') === '1';
  const DECK_FILE = decodeURIComponent(location.pathname.replace(/^\/+/, '')) || 'index.html';
  const DECK_NAME = DECK_FILE.split('/').pop();
  const DECK_ID = location.pathname;                  // 同じファイルを開いたタブ同士だけ同期する
  const CH_NAME = 'deck:' + DECK_ID;
  const LS_KEY = 'deck-state:' + DECK_ID;
  const html = document.documentElement, body = document.body;
  html.classList.add('mode-'+MODE); body.classList.add('mode-'+MODE);
  if (MODE==='print' && PRINT_NOTES){ html.classList.add('print-notes'); body.classList.add('print-notes'); }

  const deck = document.getElementById('deck');
  const all = Array.from(deck.querySelectorAll('section.slide'));
  // 変更前の各スライドの複製（ファイルの内容そのもの）。本文編集の「置換前」文字列に使う
  const pristine = all.map(s=>s.cloneNode(true));

  // ---- 発表者ビュー・一覧・ヘルプの DOM ----
  function ensureUI(){
    if (!document.getElementById('speaker')){
      const sp=document.createElement('div'); sp.id='speaker';
      sp.innerHTML = `
  <div class="bar">
    <span class="clock" id="clock">00:00</span>
    <span class="plan" id="plan"></span>
    <span id="counter"></span>
    <button id="btnReset">タイマー リセット</button>
    <button id="btnOpenPresent">本番ウィンドウを開く</button>
    <button id="btnEdit" title="現在のスライドの文章をその場で書き換える（画像・図はそのまま）">本文を編集</button>
    <span class="keys">← → 進む/戻る ・ Home/End ・ 数字+Enter でジャンプ</span>
  </div>
  <div class="cur"><span class="lab">現在</span><div class="preview" id="pvCur"></div><div class="hint">文章をクリックして編集。Enter: 改行 ・ ⌘/Ctrl+B: 赤字の切り替え ・ Esc: 確定。画像・図・グラフは編集できません</div></div>
  <div class="side">
    <div class="next"><span class="lab">次</span><div class="preview" id="pvNext"></div></div>
    <div class="notesbox" id="notesbox"><div class="meta" id="notesMeta"></div><textarea id="notesEd" spellcheck="false" placeholder="ここにスクリプトを書く（空行で段落。自動保存）"></textarea><div class="save" id="notesSave"></div></div>
  </div>`;
      body.appendChild(sp);
    }
    if (!document.getElementById('overview')){ const ov=document.createElement('div'); ov.id='overview'; body.appendChild(ov); }
    if (!document.getElementById('help')){ const h=document.createElement('div'); h.id='help'; h.textContent='← → / Space: 進む・戻る　F: 全画面　S: 発表者ビュー　O: 一覧　?: このヘルプ'; body.appendChild(h); }
  }
  ensureUI();

  // ---- state ----
  let state = { i:0, f:0, hook:'A' };
  try { const s = JSON.parse(localStorage.getItem(LS_KEY)||'null'); if (s) state = Object.assign(state, s); } catch(e){}
  if (q.get('hook')) state.hook = q.get('hook');
  if (location.hash.match(/^#(\d+)$/)) state.i = parseInt(location.hash.slice(1),10)-1;
  if (q.get('slide')) state.i = parseInt(q.get('slide'),10)-1;

  function visibleSlides(){
    return all.filter(s => {
      const h = s.dataset.hook;
      if (!h) return true;
      if (state.hook==='all') return true;
      return h===state.hook;
    });
  }
  function applyHook(){
    body.classList.toggle('mode-hook-all', state.hook==='all');
    all.forEach(s=>{
      const h=s.dataset.hook;
      s.hidden = !!(h && state.hook!=='all' && h!==state.hook);
    });
    const vis = visibleSlides();
    vis.forEach((s,idx)=>{
      let pn = s.querySelector('.pageno'); if(!pn){pn=document.createElement('div');pn.className='pageno';s.appendChild(pn);}
      pn.textContent = idx+1;
      if (s.dataset.hook){
        let b=s.querySelector('.badge-hook'); if(!b){b=document.createElement('div');b.className='badge-hook';s.appendChild(b);}
        b.textContent='つかみ案 '+s.dataset.hook + (s.dataset.hookLabel? '：'+s.dataset.hookLabel:'');
      }
    });
    const sel=document.getElementById('hooksel'); if(sel) sel.value=state.hook;
  }

  function fragmentsOf(s){ return Array.from(s.querySelectorAll('.fragment')); }

  function render(){
    applyHook();
    const vis = visibleSlides();
    state.i = Math.max(0, Math.min(state.i, vis.length-1));
    const cur = vis[state.i];
    const frs = fragmentsOf(cur);
    if (q.get('frag')==='all') state.f = frs.length;
    state.f = Math.max(0, Math.min(state.f, frs.length));
    all.forEach(s=>s.classList.remove('active'));
    if (MODE!=='print'){
      cur.classList.add('active');
      frs.forEach((f,k)=>{ f.classList.toggle('shown', k<state.f); f.classList.toggle('past', k<state.f-1); });
      vis.forEach(s=>{ if(s!==cur) fragmentsOf(s).forEach(f=>f.classList.remove('shown','past')); });
    }
    fit();
    if (MODE==='notes') renderSpeaker(vis, cur);
    if (history.replaceState) history.replaceState(null,'', '#'+(state.i+1));
    try{ localStorage.setItem(LS_KEY, JSON.stringify(state)); }catch(e){}
  }

  // ---- fit to window (present) ----
  function fit(){
    if (MODE!=='present') return;
    const W=1920,H=1080, ww=window.innerWidth, wh=window.innerHeight;
    const sc = Math.min(ww/W, wh/H);
    const ox = (ww - W*sc)/2, oy=(wh-H*sc)/2;
    all.forEach(s=>{ s.style.transform=`translate(${ox}px,${oy}px) scale(${sc})`; });
    deck.style.height = wh+'px';
  }
  window.addEventListener('resize', fit);

  // ---- navigation ----
  function go(i,f){ state.i=i; state.f=(f==null?0:f); render(); broadcast(); }
  function next(){
    const vis=visibleSlides(); const cur=vis[state.i]; const n=fragmentsOf(cur).length;
    if (state.f<n){ state.f++; } else if (state.i<vis.length-1){ state.i++; state.f=0; } else return;
    render(); broadcast();
  }
  function prev(){
    const vis=visibleSlides();
    if (state.f>0){ state.f--; } else if (state.i>0){ state.i--; state.f=fragmentsOf(vis[state.i]).length; } else return;
    render(); broadcast();
  }
  function setHook(h){ state.hook=h; state.i=Math.min(state.i, visibleSlides().length-1); render(); broadcast(); }

  // ---- sync ----
  let ch=null; try{ ch=new BroadcastChannel(CH_NAME);}catch(e){}
  function broadcast(){ if(ch) ch.postMessage({type:'state', state}); }
  if (ch){
    ch.onmessage = (ev)=>{
      const m=ev.data||{};
      if (m.type==='state'){ state=Object.assign(state, m.state); render(); }
      if (m.type==='hello'){ broadcast(); }
      if (m.type==='timer'){ timer.start=m.start; timer.running=m.running; }
      if (m.type==='notes'){ notesApply(m.idx, m.text, false); }
      if (m.type==='text'){ textApplyRemote(m.idx, m.k, m.html); }
    };
    // URLで hook/slide を明示したタブは自分の状態を正とし、他タブへ配信する。それ以外は他タブに現在状態を問い合わせる
    if (MODE!=='print'){ if (q.has('hook')||q.has('slide')) setTimeout(broadcast,0); else ch.postMessage({type:'hello'}); }
  }
  window.addEventListener('storage', (ev)=>{ if(ev.key===LS_KEY && ev.newValue){ try{ state=Object.assign(state, JSON.parse(ev.newValue)); render(); }catch(e){} } });

  // ---- keyboard ----
  function inEditor(t){ return !!(t && (t.tagName==='SELECT'||t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable)); }
  let numBuf='';
  window.addEventListener('keydown', (e)=>{
    if (MODE==='print') return;
    if (inEditor(e.target)) return;
    const k=e.key;
    if (k==='ArrowRight'||k==='PageDown'||k===' '||k==='Enter'&&!numBuf||k==='ArrowDown'){ e.preventDefault(); next(); }
    else if (k==='ArrowLeft'||k==='PageUp'||k==='ArrowUp'||k==='Backspace'){ e.preventDefault(); prev(); }
    else if (k==='Home'){ go(0); }
    else if (k==='End'){ go(visibleSlides().length-1); }
    else if (k==='f'||k==='F'){ if(MODE==='present'){ if(document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); } }
    else if (k==='s'||k==='S'){ openWindow('notes'); }
    else if (k==='o'||k==='O'){ toggleOverview(); }
    else if (k==='?'){ document.getElementById('help').classList.toggle('show'); }
    else if (k>='0'&&k<='9'){ numBuf+=k; clearTimeout(window._nb); window._nb=setTimeout(()=>{numBuf='';},1500); }
    else if (k==='Enter'&&numBuf){ const n=parseInt(numBuf,10); numBuf=''; if(n>=1) go(n-1); }
    else if (k==='Escape'){ if(body.classList.contains('mode-overview')) toggleOverview(); }
  });
  if (MODE==='present'){
    deck.addEventListener('click',(e)=>{ if(body.classList.contains('mode-overview')) return; if(e.clientX>window.innerWidth*0.25) next(); else prev(); });
  }
  function openWindow(mode){
    const u=new URL(location.href); u.searchParams.set('mode',mode); u.hash='#'+(state.i+1);
    window.open(u.toString(), 'deck-'+mode+':'+DECK_ID);
  }

  // ---- overview ----
  function toggleOverview(){
    const ov=document.getElementById('overview');
    const on=body.classList.toggle('mode-overview');
    ov.innerHTML='';
    if(!on) return;
    visibleSlides().forEach((s,idx)=>{
      const t=document.createElement('div'); t.className='thumb'+(idx===state.i?' cur':'');
      const pv=document.createElement('div'); pv.className='preview';
      const c=s.cloneNode(true); c.hidden=false; c.classList.add('active'); c.querySelectorAll('.fragment').forEach(f=>f.classList.add('shown'));
      pv.appendChild(c); t.appendChild(pv);
      const n=document.createElement('span'); n.className='n'; n.textContent=idx+1; t.appendChild(n);
      t.addEventListener('click',()=>{ go(idx); toggleOverview(); });
      ov.appendChild(t);
      requestAnimationFrame(()=>{ const w=t.clientWidth; pv.style.transform=`scale(${w/1920})`; });
    });
  }

  // ---- speaker view ----
  const timer={start:null, running:false};
  function fmt(sec){ sec=Math.max(0,Math.floor(sec)); const m=Math.floor(sec/60), s=sec%60; return String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'); }
  function plannedUntil(vis, idx){ let t=0; for(let k=0;k<idx;k++){ t+=parseFloat(vis[k].dataset.min||'0'); } return t*60; }
  function renderPreview(el, slide, showFragments){
    el.innerHTML=''; if(!slide) return null;
    const c=slide.cloneNode(true); c.hidden=false; c.classList.add('active');
    if (showFragments) c.querySelectorAll('.fragment').forEach(f=>f.classList.add('shown'));
    el.appendChild(c);
    const box=el.parentElement; const w=box.clientWidth, h=box.clientHeight; const sc=Math.min(w/1920,h/1080);
    el.style.transform=`translate(${(w-1920*sc)/2}px,${(h-1080*sc)/2}px) scale(${sc})`;
    return c;
  }

  // ---- server（tools/serve.py）----
  let canWrite = false;   // tools/serve.py 経由で開いているか
  async function detectServer(){
    if (location.protocol!=='http:' && location.protocol!=='https:') return false;
    try{ const r=await fetch('/__ping',{cache:'no-store'}); const j=await r.json(); return !!j.ok; }catch(e){ return false; }
  }
  function setSave(cls, msg){ const el=document.getElementById('notesSave'); if(!el) return; el.className='save '+cls; el.textContent=msg; }
  function slideTitle(s){ const t=s.querySelector('h2, .st, h1'); return t? t.textContent.trim().replace(/\s+/g,' ') : ''; }
  function lsGet(key){ try{ return JSON.parse(localStorage.getItem(key)||'{}'); }catch(e){ return {}; } }
  function lsSet(key, map){ try{ localStorage.setItem(key, JSON.stringify(map)); }catch(e){} }

  // ---- speaker notes editor（発表者ビューでノートを編集し、ファイルに書き戻す） ----
  const NOTES_LS = 'deck-notes-pending:' + DECK_FILE;
  function asideToText(aside){
    if (!aside) return '';
    const ps = Array.from(aside.querySelectorAll('p'));
    if (!ps.length) return aside.textContent.trim();
    return ps.map(p=>p.innerHTML.replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,'')).map(t=>{ const d=document.createElement('textarea'); d.innerHTML=t; return d.value.trim(); }).filter(Boolean).join('\n\n');
  }
  function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function textToAsideHTML(text){
    return text.trim().split(/\n\s*\n/).map(p=>p.trim()).filter(Boolean).map(p=>'<p>'+esc(p).replace(/\n/g,'<br>')+'</p>').join('\n');
  }
  const loadPending=()=>lsGet(NOTES_LS), savePending=(m)=>lsSet(NOTES_LS,m);
  function notesApply(idx, text, fromEditor){
    const s = all[idx]; if(!s) return;
    let aside = s.querySelector('.notes'); if(!aside){ aside=document.createElement('aside'); aside.className='notes'; s.appendChild(aside); }
    aside.innerHTML = textToAsideHTML(text);
    if (MODE==='notes'){
      const ed=document.getElementById('notesEd');
      if (ed && ed.dataset.idx===String(idx) && document.activeElement!==ed && ed.value!==text) ed.value=text;
    }
    if (fromEditor){
      if (ch) ch.postMessage({type:'notes', idx, text});
      const pend=loadPending(); pend[idx]={text, title:slideTitle(s), at:Date.now()}; savePending(pend);
      if (canWrite) pushNotes(idx, text, slideTitle(s)); else setSave('warn','ブラウザに保存（'+DECK_NAME+' には未反映。serve.py かビューアで開くと書き戻せます）');
    }
  }
  async function pushNotes(idx, text, title){
    setSave('', '保存中…');
    try{
      const r = await fetch('/__notes', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({file:DECK_FILE, index:idx, title, text})});
      const j = await r.json();
      if (j.ok){ const pend=loadPending(); delete pend[idx]; savePending(pend); setSave('ok', (j.file||DECK_NAME) + ' に保存しました ' + new Date().toLocaleTimeString()); }
      else setSave('err', '保存できませんでした: '+(j.error||r.status));
    }catch(e){ canWrite=false; setSave('err', 'サーバに接続できません（ブラウザには保存済み）'); }
  }
  async function notesInit(){
    canWrite = await detectServer();
    const pend = loadPending();
    const idxs = Object.keys(pend);
    if (idxs.length){
      for (const k of idxs){ const idx=+k; if(!all[idx]) continue; if (canWrite){ await pushNotes(idx, pend[k].text, pend[k].title||''); } else { notesApply(idx, pend[k].text, false); } }
    }
    const tpend = await textInit();
    if (MODE==='notes'){
      const left = Object.keys(loadPending()).length + tpend;
      if (left){
        setSave('warn', `未書き戻しの編集が ${left} 件あります（serve.py かビューアで開くと ${DECK_NAME} に反映）`);
        addDropButton();
      }
      else if (droppedPending) setSave('ok', `適用できない保留 ${droppedPending} 件を破棄しました（${DECK_NAME} の中身はそのまま）`);
      else setSave(canWrite?'ok':'warn', canWrite? 'ノート・本文の編集は '+DECK_NAME+' に自動保存されます' : 'file:// で開いています。編集はブラウザにのみ保存されます（serve.py かビューアで開くと書き戻し）');
      render();
    }
  }
  let notesTimer=null;
  function bindNotesEditor(){
    const ed=document.getElementById('notesEd'); if(!ed) return;
    ed.addEventListener('compositionstart', ()=>{ composing=true; clearTimeout(notesTimer); });
    ed.addEventListener('compositionend', ()=>{ composing=false; clearTimeout(notesTimer); notesTimer=setTimeout(()=>{ notesApply(+ed.dataset.idx, ed.value, true); }, 700); });
    ed.addEventListener('input', ()=>{ if(composing) return; clearTimeout(notesTimer); setSave('', '…'); notesTimer=setTimeout(()=>{ notesApply(+ed.dataset.idx, ed.value, true); }, 700); });
    ed.addEventListener('blur', ()=>{ clearTimeout(notesTimer); const idx=+ed.dataset.idx; if(all[idx] && asideToText(all[idx].querySelector('.notes'))!==ed.value.trim()) notesApply(idx, ed.value, true); });
    ed.addEventListener('keydown', (e)=>{ e.stopPropagation(); if(e.isComposing||e.keyCode===229) return; if(e.key==='Escape'){ ed.blur(); } });
  }

  // ---- slide text editor（発表者ビューで見出し・本文を書き換え、ファイルに書き戻す。画像・図は対象外） ----
  // 編集単位＝「文章を持つ最外側の要素」。入れ子（li の中の ul など）は親ごと1つの単位になる
  const TEXT_SEL = 'h1,h2,h3,p,li,td,th,dt,dd,figcaption,blockquote,.aff,.condlabel,.bubble,.quote,.conf,.emoji,.ack,.lab';
  const TEXT_LS = 'deck-text-pending:' + DECK_FILE;
  let editMode = false, pvCurIdx = -1, textTimer=null, saveChain=Promise.resolve(), composing=false;
  function editablesOf(sec){
    return Array.from(sec.querySelectorAll(TEXT_SEL)).filter(el=>{
      if (el.closest('aside.notes, svg, .pageno, .badge-hook')) return false;
      const p=el.parentElement; const up=p && p.closest(TEXT_SEL);
      return !(up && sec.contains(up) && up!==sec);
    });
  }
  // ブラウザが編集中に混ぜる余計なマークアップを落とし、元のマークアップ語彙（span.r / span.cap / br / b / i）に寄せる
  function cleanHTML(htmlStr){
    const t=document.createElement('template'); t.innerHTML=htmlStr;
    const KEEP=new Set(['SPAN','B','STRONG','I','EM','BR','SUB','SUP','A','CODE','IMG','SMALL']);
    Array.from(t.content.querySelectorAll('*')).reverse().forEach(el=>{
      if (!KEEP.has(el.tagName) || (el.tagName==='SPAN' && !el.getAttribute('class'))){
        if (el.tagName==='DIV'||el.tagName==='P') el.parentNode.insertBefore(document.createElement('br'), el);
        while(el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
        el.remove(); return;
      }
      Array.from(el.attributes).forEach(a=>{
        const ok = a.name==='class' || (a.name==='href'&&el.tagName==='A') || (a.name==='src'&&el.tagName==='IMG') || (a.name==='alt') || (a.name==='style' && /\bcap\b/.test(el.getAttribute('class')||''));
        if(!ok) el.removeAttribute(a.name);
      });
    });
    let out=t.innerHTML.replace(/ /g,' ');
    out=out.replace(/^(\s*<br>)+/,'').replace(/(<br>\s*)+$/,'');
    return out;
  }
  function outerWith(el, inner){ const c=el.cloneNode(false); c.innerHTML=inner; return c.outerHTML; }
  function nthOf(sec, el){ const target=el.outerHTML; return Array.from(sec.querySelectorAll('*')).filter(e=>e.outerHTML===target).indexOf(el); }
  // 他タブから／保留分から DOM だけ更新
  function textApplyRemote(idx, k, htmlStr){
    const live=editablesOf(all[idx]||document.createElement('div'))[k]; if(!live) return;
    if (live.innerHTML===htmlStr) return;
    live.innerHTML=htmlStr;
    if (MODE==='notes'){
      const pv=document.getElementById('pvCur'); const editing = pv.contains(document.activeElement);
      if (!editing) { pvCurIdx=-1; render(); }
      else { const el=editablesOf(pv.firstChild)[k]; if(el && el!==document.activeElement) el.innerHTML=htmlStr; }
    }
  }
  function textCommit(el){
    const pv=document.getElementById('pvCur'); const clone=pv.firstChild; if(!clone||!clone.contains(el)) return;
    const idx=pvCurIdx; const k=editablesOf(clone).indexOf(el); if(idx<0||k<0) return;
    const live=editablesOf(all[idx])[k], pri=editablesOf(pristine[idx])[k]; if(!live||!pri) return;
    const newInner=cleanHTML(el.innerHTML);
    if (newInner!==el.innerHTML && document.activeElement!==el) el.innerHTML=newInner;
    if (newInner===live.innerHTML) return;
    live.innerHTML=newInner;
    if (ch) ch.postMessage({type:'text', idx, k, html:newInner});
    const rec={old: pri.outerHTML, nth: nthOf(pristine[idx], pri), new: outerWith(pri, newInner), title: slideTitle(pristine[idx]), at:Date.now()};
    const pend=lsGet(TEXT_LS); pend[idx+':'+k]=rec; lsSet(TEXT_LS,pend);
    if (canWrite) queueText(idx,k,rec); else setSave('warn','本文の変更をブラウザに保存（'+DECK_NAME+' には未反映。serve.py かビューアで開くと書き戻せます）');
  }
  function queueText(idx,k,rec){
    saveChain = saveChain.then(()=>pushText(idx,k,rec)).catch(()=>{});
    return saveChain;
  }
  async function pushText(idx,k,rec){
    setSave('', '保存中…');
    try{
      const r = await fetch('/__text', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({file:DECK_FILE, index:idx, title:rec.title, old:rec.old, nth:rec.nth, new:rec.new})});
      const j = await r.json();
      if (j.ok){
        const pend=lsGet(TEXT_LS); delete pend[idx+':'+k]; lsSet(TEXT_LS,pend);
        const pri=editablesOf(pristine[idx])[k]; if(pri){ const t=document.createElement('template'); t.innerHTML=rec.new; if(t.content.firstElementChild) pri.replaceWith(t.content.firstElementChild); }
        setSave('ok', (j.file||DECK_NAME) + ' に保存しました ' + new Date().toLocaleTimeString());
        return {ok:true};
      }
      const err = String(j.error||r.status);
      const stale = /not found|mismatch|occurrence|out of range/.test(err);
      setSave('err', stale
        ? 'この保留は適用できません（スライドの文面が変わっています）。破棄しました'
        : '本文を保存できませんでした: '+err+'（画面には反映済み。'+DECK_NAME+' を手で直してください）');
      return {ok:false, stale};
    }catch(e){ canWrite=false; setSave('err', 'サーバに接続できません（ブラウザには保存済み）'); return {ok:false, stale:false}; }
  }
  let droppedPending=0;
  async function textInit(){
    const pend=lsGet(TEXT_LS); const keys=Object.keys(pend); if(!keys.length) return 0;
    for (const key of keys){
      const [idx,k]=key.split(':').map(Number);
      // スライドが消えた・本文が書き換わった保留はもう適用できないので捨てる
      if(!all[idx]){ dropPending(key); continue; }
      if (canWrite){
        const res = await pushText(idx,k,pend[key]);
        if (res && res.stale) dropPending(key);
      }
      else { const t=document.createElement('template'); t.innerHTML=pend[key].new; const inner=t.content.firstElementChild?t.content.firstElementChild.innerHTML:''; textApplyRemote(idx,k,inner); }
    }
    return Object.keys(lsGet(TEXT_LS)).length;
  }
  function dropPending(key){ const m=lsGet(TEXT_LS); if(m[key]){ delete m[key]; lsSet(TEXT_LS,m); droppedPending++; } }
  function clearPending(){
    lsSet(TEXT_LS,{}); savePending({});
    setSave('ok','保留中の編集を破棄しました（'+DECK_NAME+' の中身はそのまま）');
    const b=document.getElementById('btnDropPending'); if(b) b.remove();
  }
  function unwrap(el){ const p=el.parentNode; while(el.firstChild) p.insertBefore(el.firstChild, el); el.remove(); p.normalize(); }
  function elementOf(n){ return n ? (n.nodeType===1 ? n : n.parentElement) : null; }
  // 選択範囲に赤字が1つでも掛かっていれば外す。掛かっていなければ赤字にする
  function toggleRed(){
    const sel=window.getSelection(); if(!sel.rangeCount||sel.isCollapsed) return;
    const range=sel.getRangeAt(0);
    const host=elementOf(range.commonAncestorContainer); if(!host) return;
    const editable=host.closest('[contenteditable="true"]')||host;
    const reds=Array.from(editable.querySelectorAll('span.r')).filter(el=>{
      try{ return range.intersectsNode(el); }catch(e){ return false; }
    });
    [elementOf(sel.anchorNode), elementOf(sel.focusNode), host].forEach(n=>{
      const r=n && n.closest && n.closest('span.r');
      if (r && editable.contains(r) && !reds.includes(r)) reds.push(r);
    });
    if (reds.length){ reds.forEach(unwrap); sel.removeAllRanges(); return; }
    const span=document.createElement('span'); span.className='r';
    try{ range.surroundContents(span); }
    catch(e){ document.execCommand('insertHTML', false, '<span class="r">'+esc(sel.toString())+'</span>'); }
  }
  function bindEditable(el){
    el.contentEditable='true'; el.spellcheck=false;
    el.addEventListener('compositionstart', ()=>{ composing=true; clearTimeout(textTimer); });
    el.addEventListener('compositionend', ()=>{ composing=false; clearTimeout(textTimer); setSave('', '…'); textTimer=setTimeout(()=>textCommit(el), 700); });
    el.addEventListener('input', ()=>{ if(composing) return; clearTimeout(textTimer); setSave('', '…'); textTimer=setTimeout(()=>textCommit(el), 700); });
    el.addEventListener('blur', ()=>{ composing=false; clearTimeout(textTimer); textCommit(el); });
    el.addEventListener('keydown', (e)=>{
      e.stopPropagation();
      // IME変換中（かな漢字変換の確定など）はブラウザに任せる。Enter を改行にしない
      if (e.isComposing || e.keyCode===229 || composing) return;
      if (e.key==='Escape'){ e.preventDefault(); el.blur(); }
      else if (e.key==='Enter'){ e.preventDefault(); document.execCommand('insertLineBreak'); }
      else if ((e.metaKey||e.ctrlKey) && (e.key==='b'||e.key==='B')){ e.preventDefault(); toggleRed(); el.dispatchEvent(new Event('input')); }
    });
    el.addEventListener('paste', (e)=>{ e.preventDefault(); const t=(e.clipboardData||window.clipboardData).getData('text/plain'); document.execCommand('insertText', false, t); });
  }
  function addDropButton(){
    if (MODE!=='notes' || document.getElementById('btnDropPending')) return;
    const bar=document.querySelector('#speaker .bar'); if(!bar) return;
    const b=document.createElement('button'); b.id='btnDropPending'; b.textContent='保留中の編集を破棄';
    b.title='ブラウザに残っている未反映の編集を捨てる。ファイルの中身は変わらない';
    b.addEventListener('click', clearPending);
    bar.insertBefore(b, bar.querySelector('.keys'));
  }
  function setEditMode(on){
    editMode=on; document.getElementById('speaker').classList.toggle('editing', on);
    document.getElementById('btnEdit').classList.toggle('on', on);
    document.getElementById('btnEdit').textContent = on? '編集を終える' : '本文を編集';
    pvCurIdx=-1; render();
  }

  function renderSpeaker(vis, cur){
    const idx = all.indexOf(cur);
    const pv=document.getElementById('pvCur');
    if (editMode){
      if (pvCurIdx!==idx || !pv.firstChild){
        const c=renderPreview(pv, cur, true); pvCurIdx=idx;
        if (c) editablesOf(c).forEach(bindEditable);
      }
    } else {
      renderPreview(pv, cur, false); pvCurIdx=idx;
      const pc=pv.firstChild; if(pc){ pc.querySelectorAll('.fragment').forEach((f,k)=>f.classList.toggle('shown',k<state.f)); }
    }
    renderPreview(document.getElementById('pvNext'), vis[state.i+1], true);
    const nfr=fragmentsOf(cur).length;
    document.getElementById('notesMeta').innerHTML = `スライド ${state.i+1} / ${vis.length}${nfr?` ・ 断片 ${state.f}/${nfr}`:''}${cur.dataset.min?` ・ 予定 ${cur.dataset.min}分`:''}${cur.dataset.backup==='1'?' ・ 予備':''}`;
    const ed=document.getElementById('notesEd');
    if (ed.dataset.idx!==String(idx) || document.activeElement!==ed){
      if (ed.dataset.idx!==String(idx) && document.activeElement===ed){ clearTimeout(notesTimer); const old=+ed.dataset.idx; if(all[old] && asideToText(all[old].querySelector('.notes'))!==ed.value.trim()) notesApply(old, ed.value, true); }
      ed.dataset.idx=String(idx);
      ed.value = asideToText(cur.querySelector('.notes'));
    }
    document.getElementById('counter').textContent = `${state.i+1} / ${vis.length}`;
    updateClock();
  }
  function updateClock(){
    if (MODE!=='notes') return;
    const el=document.getElementById('clock'); const vis=visibleSlides();
    const elapsed = timer.start? (Date.now()-timer.start)/1000 : 0;
    el.textContent=fmt(elapsed);
    const cur = vis[state.i];
    const planHere = plannedUntil(vis, state.i);
    const planEnd = planHere + parseFloat((cur&&cur.dataset.min)||'0')*60;
    const total = vis.filter(s=>s.dataset.backup!=='1').reduce((a,s)=>a+parseFloat(s.dataset.min||'0'),0)*60;
    const diff = elapsed-planHere;
    const cls = timer.start? (diff>30?'over':(diff<-30?'under':'')) : '';
    // このスライドの予定終了を過ぎていたら終了時刻を赤く出す
    const endCls = (timer.start && elapsed>planEnd)? 'over' : '';
    document.getElementById('plan').innerHTML = `予定: このスライド <b>${fmt(planHere)}</b> 開始 → <b class="${endCls}">${fmt(planEnd)}</b> 終了（本編合計 ${fmt(total)}）${timer.start?` ・ 差分 <span class="${cls}">${diff>=0?'+':'−'}${fmt(Math.abs(diff))}</span>`:' ・ <span class="warn">→ でタイマー開始</span>'}`;
  }
  setInterval(updateClock, 500);
  if (MODE==='notes'){
    { const hs=document.getElementById('hooksel'); if(hs) hs.addEventListener('change', e=>setHook(e.target.value)); }
    document.getElementById('btnReset').addEventListener('click', ()=>{ timer.start=null; timer.running=false; if(ch) ch.postMessage({type:'timer',start:null,running:false}); });
    document.getElementById('btnOpenPresent').addEventListener('click', ()=>openWindow('present'));
    document.getElementById('btnEdit').addEventListener('click', ()=>setEditMode(!editMode));
    bindNotesEditor();
    // タイマーは最初の「進む」で自動開始
    window.addEventListener('keydown',(e)=>{ if(inEditor(e.target)) return; if((e.key==='ArrowRight'||e.key===' '||e.key==='PageDown')&&!timer.start){ timer.start=Date.now(); timer.running=true; if(ch) ch.postMessage({type:'timer',start:timer.start,running:true}); } }, true);
    window.addEventListener('resize', ()=>{ pvCurIdx=-1; render(); });
  }

  // ---- print mode: build notes pages if requested ----
  function buildPrint(){
    applyHook();
    const vis=visibleSlides();
    if (PRINT_NOTES){
      const wrap=document.createElement('div'); wrap.id='npages';
      vis.forEach((s,idx)=>{
        const pg=document.createElement('div'); pg.className='npage';
        const fr=document.createElement('div'); fr.className='frame';
        const c=s.cloneNode(true); c.hidden=false; c.classList.add('active'); fr.appendChild(c);
        const nt=document.createElement('div'); nt.className='ntext';
        const notes=s.querySelector('.notes');
        nt.innerHTML=`<div class="meta">スライド ${idx+1} / ${vis.length}${s.dataset.min?` ・ 予定 ${s.dataset.min}分`:''}${s.dataset.hook?` ・ つかみ案 ${s.dataset.hook}`:''}</div>`+(notes?notes.innerHTML:'');
        pg.appendChild(fr); pg.appendChild(nt); wrap.appendChild(pg);
      });
      document.body.insertBefore(wrap, deck);
    }
    window.deckManifest = vis.map((s,idx)=>({ index:idx+1, id:s.id||null, hook:s.dataset.hook||null, backup:s.dataset.backup==='1', min:parseFloat(s.dataset.min||'0'), title:(s.querySelector('h1,h2,.inner')||{}).textContent?.trim().replace(/\s+/g,' ')||'', notes:(s.querySelector('.notes')||{}).innerText?.trim()||'' }));
    const m=document.createElement('script'); m.type='application/json'; m.id='deck-manifest'; m.textContent=JSON.stringify(window.deckManifest); document.body.appendChild(m);
  }

  // ---- charts (SVG) ----
  // data-chart='{"groups":[{"label":"理由なし","mean":4.09,"se":0.055,"color":"#9a9a9a"},...],"ymin":1,"ymax":5,"brackets":[{"from":1,"to":2,"label":"*"}],"ylabel":"平均値"}'
  // brackets: {from,to,label} は2本の比較、{group:[1,2],to:0,label} は「2本をまとめた線→その中点から対照へ」
  function drawCharts(){
    document.querySelectorAll('[data-chart]').forEach(el=>{
      let d; try{ d=JSON.parse(el.dataset.chart);}catch(e){ console.error('chart json',e); return; }
      const W=d.width||560, H=d.height||420, padL=d.padL||(d.fmt==='pct'?125:95), padR=20, padT=(d.title?70:30)+((d.brackets||[]).reduce((a,b)=>a+(Array.isArray(b.group)?104:44),0)), padB=90;
      const gw=W-padL-padR, gh=H-padT-padB;
      const ymin=d.ymin??0, ymax=d.ymax??5;
      const y=v=>padT+gh-(v-ymin)/(ymax-ymin)*gh;
      const n=d.groups.length, bw=gw/n*0.62, gap=gw/n;
      let s=`<svg class="chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
      if (d.title) s+=`<text x="${padL+gw/2}" y="42" text-anchor="middle" font-size="30" font-weight="900" fill="#111">${d.title}</text>`;
      const ticks=d.ticks|| (()=>{const t=[];for(let v=ymin;v<=ymax+1e-9;v+=(d.step||1)) t.push(+v.toFixed(2));return t;})();
      ticks.forEach(v=>{ s+=`<line x1="${padL}" x2="${padL+gw}" y1="${y(v)}" y2="${y(v)}" stroke="#e5e5e5" stroke-width="2"/><text x="${padL-14}" y="${y(v)+8}" text-anchor="end" font-size="24" fill="#666">${d.fmt==='pct'?Math.round(v*100)+'%':v}</text>`; });
      s+=`<line x1="${padL}" x2="${padL}" y1="${padT}" y2="${padT+gh}" stroke="#999" stroke-width="2"/><line x1="${padL}" x2="${padL+gw}" y1="${padT+gh}" y2="${padT+gh}" stroke="#999" stroke-width="2"/>`;
      if (d.ylabel) s+=`<text transform="translate(26 ${padT+gh/2}) rotate(-90)" text-anchor="middle" font-size="24" fill="#555">${d.ylabel}</text>`;
      d.groups.forEach((g,k)=>{
        const cx=padL+gap*k+gap/2; const x0=cx-bw/2;
        if (g.mean==null){ s+=`<text x="${cx}" y="${y((ymin+ymax)/2)}" text-anchor="middle" font-size="24" fill="#aaa">${g.na||'（未測定）'}</text>`; }
        else{
          s+=`<rect x="${x0}" y="${y(g.mean)}" width="${bw}" height="${padT+gh-y(g.mean)}" fill="${g.color}" rx="6"/>`;
          if (g.se!=null){ const lo=y(g.mean-g.se), hi=y(g.mean+g.se); s+=`<line x1="${cx}" x2="${cx}" y1="${lo}" y2="${hi}" stroke="#222" stroke-width="3"/><line x1="${cx-14}" x2="${cx+14}" y1="${hi}" y2="${hi}" stroke="#222" stroke-width="3"/><line x1="${cx-14}" x2="${cx+14}" y1="${lo}" y2="${lo}" stroke="#222" stroke-width="3"/>`; }
          if (d.values!==false) s+=`<text x="${cx}" y="${y(g.mean)-(g.se?y(g.mean)-y(g.mean+g.se):0)-12}" text-anchor="middle" font-size="26" font-weight="900" fill="#111">${d.fmt==='pct'?Math.round(g.mean*100)+'%':(d.fmt==='int'?Math.round(g.mean):g.mean.toFixed(2))}</text>`;
        }
        const lines=String(g.label).split('\n');
        lines.forEach((ln,li)=> s+=`<text x="${cx}" y="${padT+gh+40+li*30}" text-anchor="middle" font-size="26" font-weight="700" fill="#222">${ln}</text>`);
      });
      const cx=(i)=>padL+gap*i+gap/2;
      const topOf=(idxs)=>Math.min(...idxs.filter(i=>d.groups[i]&&d.groups[i].mean!=null).map(i=>y(d.groups[i].mean+(d.groups[i].se||0))));
      (d.brackets||[]).forEach((b,bi)=>{
        if (Array.isArray(b.group)){
          const g1=cx(b.group[0]), g2=cx(b.group[b.group.length-1]), mid=(g1+g2)/2;
          const gtop = topOf(b.group) - 44 - bi*44;
          const x0 = cx(b.to);
          const top2 = Math.min(gtop, topOf([b.to])) - 56;
          s+=`<path d="M${g1} ${gtop+14} V${gtop} H${g2} V${gtop+14}" fill="none" stroke="#222" stroke-width="3"/>`;
          s+=`<path d="M${x0} ${top2+14} V${top2} H${mid} V${gtop}" fill="none" stroke="#222" stroke-width="3"/>`;
          s+=`<text x="${(x0+mid)/2}" y="${top2-8}" text-anchor="middle" font-size="26" font-weight="900" fill="${b.color||'#111'}">${b.label}</text>`;
          return;
        }
        const x1=cx(b.from), x2=cx(b.to);
        const top = topOf(d.groups.map((_,i)=>i).filter(i=>i>=Math.min(b.from,b.to)&&i<=Math.max(b.from,b.to))) - 56 - bi*44;
        s+=`<path d="M${x1} ${top+14} V${top} H${x2} V${top+14}" fill="none" stroke="#222" stroke-width="3"/><text x="${(x1+x2)/2}" y="${top-8}" text-anchor="middle" font-size="26" font-weight="900" fill="${b.color||'#111'}">${b.label}</text>`;
      });
      s+='</svg>';
      el.innerHTML=s;
    });
  }

  // ---- init ----
  if (q.get('clearpending')==='1'){ try{ localStorage.removeItem(TEXT_LS); localStorage.removeItem(NOTES_LS); }catch(e){} }
  drawCharts();
  if (MODE==='print'){ buildPrint(); }
  else { render(); notesInit(); }
  window.deck = { go, next, prev, setHook, state:()=>state, visible:visibleSlides, file:DECK_FILE };
})();
