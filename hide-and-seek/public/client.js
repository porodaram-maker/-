(function () {
  'use strict';
  const { C } = HS;
  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const fog = document.createElement('canvas');
  const fctx = fog.getContext('2d');

  // ---------------- 상태 ----------------
  let ws = null, wsReady = false, reconnectDelay = 500, wantConnection = false;
  let myId = null, roomCode = null;
  let room = null;                 // 마지막 room 메시지
  const playersById = new Map();   // id -> 정보(name,color,role)
  const ents = new Map();          // id -> {x,y,tx,ty,bush,seen}
  const me = { x: C.SPAWN.x, y: C.SPAWN.y, cs: 0, role: 'lobby' };
  let phase = 'lobby', timeLeft = 0, timeLeftAt = 0, alive = 0, danger = 0;
  let pings = [];                  // {x,y,until}
  let lastSent = { x: 0, y: 0, t: 0 };
  let inGame = false;
  const keys = new Set();
  const joy = { id: null, ox: 0, oy: 0, x: 0, y: 0 };

  // ---------------- 네트워크 ----------------
  function connect() {
    wantConnection = true;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try { ws = new WebSocket(`${proto}//${location.host}`); } catch (e) { scheduleReconnect(); return; }
    ws.onopen = () => {
      wsReady = true; reconnectDelay = 500;
      $('conn').classList.add('hidden');
      const sess = loadSession();
      if (sess) sendMsg({ t: 'rejoin', code: sess.code, id: sess.id, token: sess.token });
      else if (pendingAction) { sendMsg(pendingAction); }
      pendingAction = null;
    };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } onMsg(m); };
    ws.onclose = () => {
      wsReady = false;
      if (inGame) $('conn').classList.remove('hidden');
      scheduleReconnect();
    };
    ws.onerror = () => {};
  }
  function scheduleReconnect() {
    if (!wantConnection) return;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(5000, reconnectDelay * 1.7);
  }
  function sendMsg(m) { if (ws && wsReady && ws.readyState === 1) ws.send(JSON.stringify(m)); }
  let pendingAction = null;
  function action(m) {
    if (wsReady) sendMsg(m); else { pendingAction = m; if (!ws || ws.readyState > 1) connect(); }
  }
  function saveSession(s) { try { sessionStorage.setItem('hs_session', JSON.stringify(s)); } catch (e) { /* ignore */ } }
  function loadSession() { try { return JSON.parse(sessionStorage.getItem('hs_session')); } catch (e) { return null; } }
  function clearSession() { try { sessionStorage.removeItem('hs_session'); } catch (e) { /* ignore */ } }

  function onMsg(m) {
    switch (m.t) {
      case 'joined':
        myId = m.id; roomCode = m.code;
        saveSession({ code: m.code, id: m.id, token: m.token });
        enterGame();
        history.replaceState(null, '', '?room=' + m.code);
        break;
      case 'error':
        if (m.code === 'rejoin_failed') { clearSession(); if (pendingAction) { sendMsg(pendingAction); pendingAction = null; } else leaveGame(); }
        $('homeErr').textContent = m.msg || '오류';
        break;
      case 'correct':
        me.x = m.x; me.y = m.y; me.cs = m.cs;
        break;
      case 'room': onRoom(m); break;
      case 'state': onState(m); break;
      case 'feed': addFeed(m.text, m.kind); if (m.kind === 'big') showBig(m.text, 3000); break;
      case 'chat': addChat(m.name, m.color, m.text); break;
      case 'ping':
        for (const [x, y] of m.pts) pings.push({ x, y, until: performance.now() + 4000 });
        break;
      case 'exposed': showBig('📢 위치가 노출됐어요! 움직이세요!', 2000); break;
      case 'caught': showBig('잡혔습니다! 👻 유령으로 관전합니다', 3000); break;
      case 'result': showResult(m); break;
    }
  }

  function onRoom(m) {
    const prevPhase = room && room.phase;
    room = m;
    playersById.clear();
    for (const p of m.players) playersById.set(p.id, p);
    const mine = playersById.get(myId);
    if (mine) me.role = mine.role;
    phase = m.phase;
    if (prevPhase !== m.phase) {
      if (m.phase !== 'end') $('scoreboard').classList.add('hidden');
      pings = [];
    }
    renderLobby();
    renderHud();
    if (!$('scoreboard').classList.contains('hidden')) renderScoreboard();
  }

  function onState(m) {
    phase = m.ph; timeLeft = m.tl; timeLeftAt = performance.now(); alive = m.alive; danger = m.d; me.role = m.role;
    const seen = new Set();
    for (const [id, x, y, bush] of m.e) {
      seen.add(id);
      let e = ents.get(id);
      if (!e) { e = { x, y }; ents.set(id, e); }
      if (Math.hypot(e.x - x, e.y - y) > 4) { e.x = x; e.y = y; }
      e.tx = x; e.ty = y; e.bush = bush;
    }
    for (const id of [...ents.keys()]) if (!seen.has(id)) ents.delete(id);
    renderHud();
  }

  // ---------------- UI ----------------
  function enterGame() {
    inGame = true;
    $('home').classList.add('hidden');
    $('hud').classList.remove('hidden');
  }
  function leaveGame() {
    inGame = false; myId = null; room = null; ents.clear();
    clearSession();
    $('home').classList.remove('hidden');
    $('hud').classList.add('hidden');
    $('lobby').classList.add('hidden');
    $('scoreboard').classList.add('hidden');
    $('conn').classList.add('hidden');
    history.replaceState(null, '', location.pathname);
  }

  function roleLabel(r) {
    return { seeker: ['술래', 'r-seeker'], hider: ['숨는 사람', 'r-hider'], caught: ['유령 👻', 'r-ghost'], spectator: ['관전 👻', 'r-ghost'], lobby: ['대기실', 'r-lobby'] }[r] || [r, 'r-lobby'];
  }

  function renderHud() {
    if (!room) return;
    const [label, cls] = roleLabel(me.role);
    const rb = $('roleBadge');
    rb.textContent = label; rb.className = cls;
    $('phaseText').textContent = { lobby: '대기 중', hide: '숨는 시간', seek: '찾는 시간', end: '라운드 종료' }[phase] || '';
    $('aliveText').textContent = phase === 'hide' || phase === 'seek' ? `🙈 ${alive}명 남음` : `라운드 ${room.round}`;
  }

  function renderLobby() {
    const show = inGame && room && room.phase === 'lobby';
    $('lobby').classList.toggle('hidden', !show);
    if (!show) return;
    $('roomCode').textContent = room.code;
    const ul = $('playerList');
    ul.innerHTML = '';
    for (const p of room.players) {
      const li = document.createElement('li');
      if (!p.connected) li.className = 'off';
      const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = p.color;
      const nm = document.createElement('span');
      nm.textContent = `${p.name}${p.id === room.hostId ? ' 👑' : ''}${p.id === myId ? ' (나)' : ''}${p.connected ? '' : ' (연결 끊김)'}`;
      const sc = document.createElement('span'); sc.style.marginLeft = 'auto'; sc.textContent = p.score + '점';
      li.append(dot, nm, sc);
      ul.append(li);
    }
    const isHost = room.hostId === myId;
    $('hostControls').classList.toggle('hidden', !isHost);
    $('waitHost').classList.toggle('hidden', isHost);
    if (isHost) {
      fillSelect($('hideSel'), room.hideChoices, room.settings.hide);
      fillSelect($('seekSel'), room.seekChoices, room.settings.seek);
    }
  }
  function fillSelect(sel, choices, val) {
    if (sel.options.length !== choices.length) {
      sel.innerHTML = '';
      for (const c of choices) { const o = document.createElement('option'); o.value = c; o.textContent = c >= 60 ? `${c / 60}분${c % 60 ? ' ' + (c % 60) + '초' : ''}` : `${c}초`; sel.append(o); }
    }
    if (document.activeElement !== sel) sel.value = String(val);
  }

  function renderScoreboard(title) {
    if (!room) return;
    if (title) $('sbTitle').textContent = title;
    const body = $('sbBody');
    body.innerHTML = '';
    const list = [...room.players].sort((a, b) => b.score - a.score);
    list.forEach((p, i) => {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td'); td1.textContent = i + 1;
      const td2 = document.createElement('td');
      const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = p.color; dot.style.marginRight = '6px';
      td2.append(dot, document.createTextNode(`${p.name}${p.id === myId ? ' (나)' : ''} · ${roleLabel(p.role)[0]}`));
      const td3 = document.createElement('td'); td3.className = 'num'; td3.textContent = p.score;
      tr.append(td1, td2, td3);
      body.append(tr);
    });
    $('stopBtn').classList.toggle('hidden', !(room.hostId === myId && room.phase !== 'lobby'));
  }
  function toggleScoreboard(force) {
    const sb = $('scoreboard');
    const show = force !== undefined ? force : sb.classList.contains('hidden');
    sb.classList.toggle('hidden', !show);
    if (show) renderScoreboard('점수판');
  }
  function showResult(m) {
    const title = m.winner === 'seeker' ? '🔍 술래 승리!' : m.winner === 'hiders' ? '🙈 숨는 팀 승리!' : '라운드 종료';
    showBig(title, 3500);
    setTimeout(() => { if (phase === 'end') { toggleScoreboard(true); renderScoreboard(title + ' — 곧 다음 라운드'); } }, 300);
  }

  let bigTimer = null;
  function showBig(text, ms) {
    const el = $('bigMsg');
    el.textContent = text; el.style.opacity = 1;
    clearTimeout(bigTimer);
    bigTimer = setTimeout(() => { el.style.opacity = 0; }, ms);
  }
  function addFeed(text, kind) {
    const d = document.createElement('div');
    d.textContent = text; d.className = kind || '';
    const f = $('feed');
    f.append(d);
    while (f.children.length > 6) f.firstChild.remove();
    setTimeout(() => d.remove(), 7200);
  }
  function addChat(name, color, text) {
    const d = document.createElement('div');
    const b = document.createElement('b'); b.style.color = color; b.textContent = name + ': ';
    d.append(b, document.createTextNode(text));
    const f = $('chatLog');
    f.append(d);
    while (f.children.length > 8) f.firstChild.remove();
    setTimeout(() => d.remove(), 12200);
  }

  // 시작 화면 버튼
  const savedName = localStorage.getItem('hs_name') || '';
  $('nameInput').value = savedName;
  const qs = new URLSearchParams(location.search);
  if (qs.get('room')) $('codeInput').value = qs.get('room').toUpperCase().slice(0, 4);
  function getName() { const n = $('nameInput').value.trim(); localStorage.setItem('hs_name', n); return n; }
  $('createBtn').onclick = () => { $('homeErr').textContent = ''; clearSession(); action({ t: 'create', name: getName() }); };
  $('joinBtn').onclick = () => {
    const code = $('codeInput').value.trim().toUpperCase();
    if (code.length !== 4) { $('homeErr').textContent = '4자리 방 코드를 입력하세요.'; return; }
    $('homeErr').textContent = ''; clearSession();
    action({ t: 'join', code, name: getName() });
  };
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
  $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('codeInput').value.trim().length === 4 ? $('joinBtn') : $('createBtn')).click(); });
  $('startBtn').onclick = () => sendMsg({ t: 'start' });
  $('addBotBtn').onclick = () => sendMsg({ t: 'addBot' });
  $('removeBotBtn').onclick = () => sendMsg({ t: 'removeBot' });
  $('stopBtn').onclick = () => { sendMsg({ t: 'stop' }); toggleScoreboard(false); };
  $('hideSel').onchange = $('seekSel').onchange = () => sendMsg({ t: 'settings', hide: +$('hideSel').value, seek: +$('seekSel').value });
  $('copyBtn').onclick = () => {
    const url = `${location.origin}${location.pathname}?room=${roomCode}`;
    const done = () => addFeed('초대 링크를 복사했습니다: ' + url, 'big');
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => prompt('초대 링크', url));
    else prompt('초대 링크', url);
  };
  $('scoreBtn').onclick = () => toggleScoreboard();
  $('chatBtn').onclick = () => openChat();
  $('leaveBtn').onclick = () => { if (confirm('방에서 나갈까요?')) { sendMsg({ t: 'leave' }); leaveGame(); } };

  function openChat() {
    const ci = $('chatInput');
    ci.classList.remove('hidden'); ci.focus();
    keys.clear();
  }
  $('chatInput').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const v = e.target.value.trim();
      if (v) sendMsg({ t: 'chat', text: v });
      e.target.value = ''; e.target.blur(); e.target.classList.add('hidden');
    } else if (e.key === 'Escape') { e.target.blur(); e.target.classList.add('hidden'); }
  });

  // ---------------- 입력 ----------------
  window.addEventListener('keydown', (e) => {
    if (!inGame) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return;
    if (e.key === 'Enter') { e.preventDefault(); openChat(); return; }
    if (e.key === 'Tab') { e.preventDefault(); toggleScoreboard(); return; }
    keys.add(e.key.toLowerCase());
    if (e.key.startsWith('Arrow')) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());

  canvas.addEventListener('touchstart', (e) => {
    for (const t of e.changedTouches) {
      if (joy.id === null) { joy.id = t.identifier; joy.ox = t.clientX; joy.oy = t.clientY; joy.x = 0; joy.y = 0; }
    }
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) if (t.identifier === joy.id) {
      let dx = t.clientX - joy.ox, dy = t.clientY - joy.oy;
      const d = Math.hypot(dx, dy), max = 50;
      if (d > max) { joy.ox += (dx / d) * (d - max); joy.oy += (dy / d) * (d - max); dx = (dx / d) * max; dy = (dy / d) * max; }
      joy.x = dx / max; joy.y = dy / max;
    }
    e.preventDefault();
  }, { passive: false });
  const endTouch = (e) => { for (const t of e.changedTouches) if (t.identifier === joy.id) { joy.id = null; joy.x = joy.y = 0; } };
  canvas.addEventListener('touchend', endTouch);
  canvas.addEventListener('touchcancel', endTouch);

  function inputVec() {
    let x = 0, y = 0;
    if (keys.has('a') || keys.has('arrowleft') || keys.has('ㅁ')) x -= 1;
    if (keys.has('d') || keys.has('arrowright') || keys.has('ㅇ')) x += 1;
    if (keys.has('w') || keys.has('arrowup') || keys.has('ㅈ')) y -= 1;
    if (keys.has('s') || keys.has('arrowdown') || keys.has('ㄴ')) y += 1;
    if (joy.id !== null) { x += joy.x; y += joy.y; }
    const d = Math.hypot(x, y);
    if (d > 1) { x /= d; y /= d; }
    if (d < 0.15) { x = 0; y = 0; }
    return { x, y };
  }

  const isGhost = () => me.role === 'caught' || me.role === 'spectator';

  // ---------------- 업데이트 ----------------
  function update(dt) {
    if (!inGame || !myId) return;
    const frozen = me.role === 'seeker' && phase === 'hide';
    const v = inputVec();
    if (!frozen && (v.x || v.y)) {
      const sp = isGhost() ? C.GHOST_SPEED : me.role === 'seeker' ? C.SEEKER_SPEED : C.HIDER_SPEED;
      if (isGhost()) {
        me.x = HS.clamp(me.x + v.x * sp * dt, 0.5, HS.W - 0.5);
        me.y = HS.clamp(me.y + v.y * sp * dt, 0.5, HS.H - 0.5);
      } else HS.move(me, v.x * sp * dt, v.y * sp * dt);
    }
    const t = performance.now();
    const moved = Math.hypot(me.x - lastSent.x, me.y - lastSent.y) > 0.01;
    if ((moved && t - lastSent.t > 50) || t - lastSent.t > 1000) {
      sendMsg({ t: 'pos', x: Math.round(me.x * 1000) / 1000, y: Math.round(me.y * 1000) / 1000, cs: me.cs });
      lastSent = { x: me.x, y: me.y, t };
    }
    const k = 1 - Math.exp(-dt * 14);
    for (const e of ents.values()) { e.x += (e.tx - e.x) * k; e.y += (e.ty - e.y) * k; }
    pings = pings.filter((p) => p.until > t);
  }

  // ---------------- 그리기 ----------------
  let W = 0, H = 0, dpr = 1;
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    fog.width = canvas.width; fog.height = canvas.height;
  }
  window.addEventListener('resize', resize);
  resize();

  function hash(x, y) { let h = x * 374761393 + y * 668265263; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967295; }

  function drawTiles(ts, cam, time) {
    const x0 = Math.max(0, Math.floor(cam.x - W / 2 / ts) - 1), x1 = Math.min(HS.W - 1, Math.ceil(cam.x + W / 2 / ts) + 1);
    const y0 = Math.max(0, Math.floor(cam.y - H / 2 / ts) - 1), y1 = Math.min(HS.H - 1, Math.ceil(cam.y + H / 2 / ts) + 1);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      const c = HS.tile(tx, ty);
      const px = tx * ts, py = ty * ts;
      const n = hash(tx, ty);
      if (c === '#') {
        ctx.fillStyle = '#3b4252'; ctx.fillRect(px, py, ts + 0.5, ts + 0.5);
        ctx.fillStyle = '#4c566a'; ctx.fillRect(px, py, ts + 0.5, ts * 0.25);
      } else if (c === ',' || (c === 'o' && isIndoor(tx, ty))) {
        ctx.fillStyle = (tx + ty) % 2 ? '#8a6d4b' : '#806446'; ctx.fillRect(px, py, ts + 0.5, ts + 0.5);
      } else if (c === '~') {
        ctx.fillStyle = '#1f5f8b'; ctx.fillRect(px, py, ts + 0.5, ts + 0.5);
        ctx.strokeStyle = '#5fa8d3'; ctx.lineWidth = Math.max(1, ts / 16);
        const off = Math.sin(time / 600 + tx + ty) * ts * 0.1;
        ctx.beginPath(); ctx.moveTo(px + ts * 0.15, py + ts * 0.45 + off); ctx.quadraticCurveTo(px + ts * 0.5, py + ts * 0.3 + off, px + ts * 0.85, py + ts * 0.45 + off); ctx.stroke();
      } else {
        ctx.fillStyle = n < 0.33 ? '#3f7a3c' : n < 0.66 ? '#437f40' : '#3c7539'; ctx.fillRect(px, py, ts + 0.5, ts + 0.5);
        if (n > 0.85) { ctx.fillStyle = '#5a9a4f'; ctx.fillRect(px + ts * 0.3, py + ts * 0.5, ts * 0.06, ts * 0.18); ctx.fillRect(px + ts * 0.42, py + ts * 0.45, ts * 0.06, ts * 0.22); }
      }
      if (c === 'o') {
        const m = ts * 0.08;
        ctx.fillStyle = '#b07a35'; ctx.fillRect(px + m, py + m, ts - 2 * m, ts - 2 * m);
        ctx.strokeStyle = '#6b4518'; ctx.lineWidth = Math.max(1, ts / 14);
        ctx.strokeRect(px + m, py + m, ts - 2 * m, ts - 2 * m);
        ctx.beginPath(); ctx.moveTo(px + m, py + m); ctx.lineTo(px + ts - m, py + ts - m); ctx.moveTo(px + ts - m, py + m); ctx.lineTo(px + m, py + ts - m); ctx.stroke();
      }
    }
  }
  function isIndoor(tx, ty) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (HS.tile(tx + dx, ty + dy) === ',') return true;
    return false;
  }
  function drawBushes(ts, cam, myBush) {
    const x0 = Math.max(0, Math.floor(cam.x - W / 2 / ts) - 1), x1 = Math.min(HS.W - 1, Math.ceil(cam.x + W / 2 / ts) + 1);
    const y0 = Math.max(0, Math.floor(cam.y - H / 2 / ts) - 1), y1 = Math.min(HS.H - 1, Math.ceil(cam.y + H / 2 / ts) + 1);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      if (HS.tile(tx, ty) !== '*') continue;
      const near = myBush && Math.hypot(tx + 0.5 - me.x, ty + 0.5 - me.y) < 1.6;
      ctx.globalAlpha = near ? 0.5 : 0.95;
      const px = tx * ts, py = ty * ts;
      for (let i = 0; i < 4; i++) {
        const hx = hash(tx * 7 + i, ty * 13 + i), hy = hash(tx * 3 + i, ty * 5 - i);
        ctx.fillStyle = i % 2 ? '#2d6a2f' : '#245a27';
        ctx.beginPath(); ctx.arc(px + ts * (0.2 + hx * 0.6), py + ts * (0.2 + hy * 0.6), ts * 0.45, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = '#3d8b3d';
      ctx.beginPath(); ctx.arc(px + ts * 0.5, py + ts * 0.45, ts * 0.3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawPlayer(ts, x, y, info, isMe, inBushFlag, role) {
    const ghost = role === 'caught' || role === 'spectator';
    const r = C.R * ts;
    const px = x * ts, py = y * ts;
    ctx.globalAlpha = ghost ? 0.45 : 1;
    ctx.fillStyle = '#0006';
    ctx.beginPath(); ctx.ellipse(px, py + r * 0.8, r * 0.9, r * 0.35, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = info ? info.color : '#ccc';
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = Math.max(2, ts / 14);
    ctx.strokeStyle = role === 'seeker' ? '#ff2e3b' : isMe ? '#fff' : '#0008';
    ctx.stroke();
    // 눈
    ctx.fillStyle = '#111';
    const closed = role === 'seeker' && phase === 'hide';
    if (closed) { ctx.fillRect(px - r * 0.5, py - r * 0.2, r * 0.35, r * 0.1); ctx.fillRect(px + r * 0.15, py - r * 0.2, r * 0.35, r * 0.1); }
    else { ctx.beginPath(); ctx.arc(px - r * 0.32, py - r * 0.15, r * 0.14, 0, 7); ctx.arc(px + r * 0.32, py - r * 0.15, r * 0.14, 0, 7); ctx.fill(); }
    ctx.globalAlpha = 1;
    if (info && !(inBushFlag && !isMe && !ghost)) {
      ctx.font = `600 ${Math.max(11, ts * 0.32)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      const label = (role === 'seeker' ? '🔍 ' : ghost ? '👻 ' : '') + info.name;
      ctx.fillStyle = '#000a'; ctx.fillText(label, px + 1, py - r - 5 + 1);
      ctx.fillStyle = role === 'seeker' ? '#ff8a8a' : '#fff'; ctx.fillText(label, px, py - r - 5);
    }
  }

  function render(time) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0f14'; ctx.fillRect(0, 0, W, H);
    if (!inGame || !myId) {
      // 홈 화면 배경: 천천히 움직이는 맵
      const ts = 36, cam = { x: HS.W / 2 + Math.sin(time / 8000) * 8, y: HS.H / 2 + Math.cos(time / 9000) * 5 };
      ctx.save(); ctx.translate(W / 2 - cam.x * ts, H / 2 - cam.y * ts);
      drawTiles(ts, cam, time); drawBushes(ts, cam, false);
      ctx.restore();
      return;
    }
    const ts = Math.max(26, Math.min(60, Math.min(W, H) / 15));
    const cam = { x: me.x, y: me.y };
    ctx.save();
    ctx.translate(Math.round(W / 2 - cam.x * ts), Math.round(H / 2 - cam.y * ts));
    drawTiles(ts, cam, time);
    // 다른 플레이어 (유령 먼저)
    const list = [...ents.entries()].map(([id, e]) => ({ id, e, info: playersById.get(id) }));
    list.sort((a, b) => a.e.y - b.e.y);
    for (const { e, info } of list) drawPlayer(ts, e.x, e.y, info, false, e.bush, info ? info.role : 'hider');
    const myBush = HS.inBush(me.x, me.y) && !isGhost();
    drawPlayer(ts, me.x, me.y, playersById.get(myId), true, false, me.role);
    drawBushes(ts, cam, myBush);
    // 숨은 내 모습 강조
    if (myBush) { ctx.strokeStyle = '#fff8'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.arc(me.x * ts, me.y * ts, C.R * ts * 1.4, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
    // 위치 노출 핑
    for (const p of pings) {
      const a = (p.until - time) / 4000;
      const rr = ts * (1.5 + (1 - a) * 1.5);
      ctx.strokeStyle = `rgba(255,60,60,${a})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(p.x * ts, p.y * ts, rr, 0, 7); ctx.stroke();
      ctx.fillStyle = `rgba(255,60,60,${a * 0.25})`; ctx.fill();
    }
    ctx.restore();

    // 시야 안개
    const playing = phase === 'hide' || phase === 'seek';
    if (playing && !isGhost()) {
      const blind = me.role === 'seeker' && phase === 'hide';
      fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fctx.globalCompositeOperation = 'source-over';
      fctx.clearRect(0, 0, W, H);
      fctx.fillStyle = blind ? 'rgba(5,5,10,0.97)' : 'rgba(5,8,14,0.86)';
      fctx.fillRect(0, 0, W, H);
      if (!blind) {
        fctx.globalCompositeOperation = 'destination-out';
        const cx = W / 2 + (me.x - cam.x) * ts, cy = H / 2 + (me.y - cam.y) * ts;
        const R = C.VISION;
        const grad = fctx.createRadialGradient(cx, cy, ts * 1.5, cx, cy, R * ts);
        grad.addColorStop(0, 'rgba(0,0,0,1)'); grad.addColorStop(0.75, 'rgba(0,0,0,0.9)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
        fctx.fillStyle = grad;
        fctx.beginPath();
        const N = 240;
        for (let i = 0; i <= N; i++) {
          const ang = (i / N) * Math.PI * 2;
          const d = Math.min(R, HS.castRay(me.x, me.y, ang, R) + 0.35);
          const x = cx + Math.cos(ang) * d * ts, y = cy + Math.sin(ang) * d * ts;
          if (i === 0) fctx.moveTo(x, y); else fctx.lineTo(x, y);
        }
        fctx.closePath(); fctx.fill();
        // 바로 주변은 항상 조금 보이게
        const g2 = fctx.createRadialGradient(cx, cy, 0, cx, cy, ts * 1.3);
        g2.addColorStop(0, 'rgba(0,0,0,0.9)'); g2.addColorStop(1, 'rgba(0,0,0,0)');
        fctx.fillStyle = g2; fctx.beginPath(); fctx.arc(cx, cy, ts * 1.3, 0, 7); fctx.fill();
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(fog, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (blind) {
        ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
        ctx.font = `800 ${Math.min(48, W / 12)}px system-ui, sans-serif`;
        ctx.fillText('🙈 눈 감는 중...', W / 2, H / 2 - 20);
        ctx.font = `800 ${Math.min(80, W / 7)}px system-ui, sans-serif`;
        ctx.fillStyle = '#ffd166';
        ctx.fillText(String(curTimeLeft()), W / 2, H / 2 + 60);
      }
    }
    // 위험 경고 (술래가 가까움)
    if (me.role === 'hider' && phase === 'seek' && danger > 0.05) {
      const beat = 0.6 + 0.4 * Math.abs(Math.sin(time / (500 - danger * 300) * Math.PI));
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
      g.addColorStop(0, 'rgba(200,0,0,0)'); g.addColorStop(1, `rgba(200,0,0,${danger * 0.4 * beat})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    // 조이스틱
    if (joy.id !== null) {
      ctx.globalAlpha = 0.35; ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(joy.ox, joy.oy, 50, 0, 7); ctx.fill();
      ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.arc(joy.ox + joy.x * 50, joy.oy + joy.y * 50, 22, 0, 7); ctx.fill();
      ctx.globalAlpha = 1;
    }
    $('timer').textContent = phase === 'lobby' ? '' : fmt(curTimeLeft());
  }
  function curTimeLeft() { return Math.max(0, Math.ceil(timeLeft - (performance.now() - timeLeftAt) / 1000)); }
  function fmt(s) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

  // ---------------- 메인 루프 ----------------
  let lastT = performance.now();
  function frame(t) {
    const dt = Math.min(0.05, (t - lastT) / 1000);
    lastT = t;
    try { update(dt); render(t); } catch (e) { console.error(e); }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // 새로고침 시 이전 게임에 자동 재접속
  connect();
  if (loadSession()) enterGame();
})();
