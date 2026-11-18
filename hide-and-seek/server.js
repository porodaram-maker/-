'use strict';
// 멀티플레이 숨바꼭질 서버 (서버 권위형, WebSocket)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const S = require('./public/shared.js');
const { C } = S;

const PORT = Number(process.env.PORT) || 3000;
const TICK_HZ = 30;
const SEND_EVERY = 2;           // 15Hz 상태 전송
const MAX_PLAYERS = 10;
const MAX_ROOMS = 300;
const GRACE_GAME = 60;          // 게임 중 끊긴 플레이어 재접속 대기(초)
const GRACE_LOBBY = 15;         // 로비에서 끊긴 플레이어 대기(초)
const EMPTY_ROOM_TTL = 60;      // 사람이 없는 방 삭제(초)
const END_TIME = Number(process.env.END_TIME) || 8;
const DEFAULT_HIDE = Number(process.env.HIDE_TIME) || 25;
const DEFAULT_SEEK = Number(process.env.SEEK_TIME) || 150;
const HIDE_CHOICES = [10, 15, 25, 40, 60];
const SEEK_CHOICES = [60, 90, 150, 240, 360];
const COLORS = ['#ffd166', '#06d6a0', '#4cc9f0', '#f72585', '#b5179e', '#ff9f1c', '#90be6d', '#c77dff', '#f94144', '#e9ecef'];
const BOT_NAMES = ['봇 철수', '봇 영희', '봇 민수', '봇 지수', '봇 하늘', '봇 바다', '봇 별이', '봇 구름', '봇 콩이'];

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------- 정적 파일 ----------------
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const rooms = new Map();
const startedAt = Date.now();

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') {
      let players = 0;
      for (const r of rooms.values()) players += r.players.size;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptime: Math.round((Date.now() - startedAt) / 1000), rooms: rooms.size, players, mem: Math.round(process.memoryUsage().rss / 1048576) + 'MB' }));
      return;
    }
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    });
  } catch (e) {
    res.writeHead(400); res.end();
  }
});

// ---------------- 유틸 ----------------
const now = () => Date.now() / 1000;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function cleanName(n) {
  n = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
  return n || '플레이어' + Math.floor(Math.random() * 900 + 100);
}
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)];
    if (!rooms.has(c)) return c;
  }
}

// 걸을 수 있는 타일 목록 (봇/스폰용)
const FLOOR = [];
const BUSHES = [];
const HIDE_SPOTS = [];
for (let y = 0; y < S.H; y++) for (let x = 0; x < S.W; x++) {
  if (S.solid(x, y)) continue;
  FLOOR.push({ x, y });
  if (S.tile(x, y) === '*') BUSHES.push({ x, y });
  let walls = 0;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (S.opaque(x + dx, y + dy)) walls++;
  if (walls >= 2) HIDE_SPOTS.push({ x, y });
}

// BFS 길찾기 (4방향)
function findPath(sx, sy, ex, ey) {
  sx = Math.floor(sx); sy = Math.floor(sy); ex = Math.floor(ex); ey = Math.floor(ey);
  if (S.solid(ex, ey)) return null;
  const W = S.W, prev = new Int32Array(W * S.H).fill(-2);
  const start = sy * W + sx, goal = ey * W + ex;
  prev[start] = -1;
  const q = [start];
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi];
    if (cur === goal) break;
    const cx = cur % W, cy = (cur / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (S.solid(nx, ny)) continue;
      const ni = ny * W + nx;
      if (prev[ni] !== -2) continue;
      prev[ni] = cur;
      q.push(ni);
    }
  }
  if (prev[goal] === -2) return null;
  const out = [];
  for (let c = goal; c !== -1 && c !== start; c = prev[c]) out.push({ x: (c % W) + 0.5, y: ((c / W) | 0) + 0.5 });
  return out.reverse();
}

function spawnNear(cx, cy, radius) {
  for (let i = 0; i < 50; i++) {
    const x = cx + rand(-radius, radius), y = cy + rand(-radius, radius);
    if (!S.solid(Math.floor(x), Math.floor(y))) {
      const p = { x, y };
      S.resolve(p);
      if (findPath(p.x, p.y, cx, cy)) return p;
    }
  }
  return { x: cx, y: cy };
}

// ---------------- 시야 ----------------
function canSee(room, v, t) {
  if (v.id === t.id) return true;
  const ph = room.phase;
  if (ph === 'lobby' || ph === 'end') return true;
  const vGhost = v.role === 'caught' || v.role === 'spectator';
  const tGhost = t.role === 'caught' || t.role === 'spectator';
  if (vGhost) return true;               // 유령은 모두 봄
  if (tGhost) return false;              // 살아있는 사람은 유령을 못 봄
  if (v.role === 'seeker' && ph === 'hide') return false; // 술래는 숨는 시간에 눈 감음
  if (v.role === 'hider' && t.role === 'hider') return true; // 같은 팀은 서로 위치 공유
  const d = dist(v, t);
  if (d > C.VISION) return false;
  if (t.role === 'hider' && S.inBush(t.x, t.y) && d > C.BUSH_REVEAL) return false;
  return S.lineOfSight(v.x, v.y, t.x, t.y);
}

// ---------------- 방 ----------------
function createRoom() {
  const room = {
    code: newCode(),
    players: new Map(),
    hostId: null,
    phase: 'lobby',
    phaseEnd: 0,
    round: 0,
    joinCounter: 0,
    lastSeekerOrder: -1,
    settings: { hide: DEFAULT_HIDE, seek: DEFAULT_SEEK },
    emptySince: null,
    pingsSent: 0,
    tick: 0,
    dirty: true,
  };
  rooms.set(room.code, room);
  log('room created', room.code, 'rooms=' + rooms.size);
  return room;
}

function usedColor(room) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  return COLORS.find((c) => !used.has(c)) || pick(COLORS);
}

function addPlayer(room, name, ws, isBot) {
  const id = crypto.randomBytes(6).toString('hex');
  const p = {
    id, name, ws: ws || null, isBot: !!isBot,
    token: crypto.randomBytes(16).toString('hex'),
    color: usedColor(room),
    connected: true, disconnectedAt: 0,
    x: 0, y: 0, lastPosAt: now(), cs: 0,
    role: room.phase === 'lobby' ? 'lobby' : 'spectator',
    score: 0, order: room.joinCounter++,
    bot: isBot ? { path: null, goal: null, think: 0, lastX: 0, lastY: 0, stuck: 0 } : null,
    chatTimes: [],
  };
  const sp = spawnNear(C.SPAWN.x, C.SPAWN.y, 3);
  p.x = sp.x; p.y = sp.y;
  room.players.set(id, p);
  if (!room.hostId && !isBot) room.hostId = id;
  room.dirty = true;
  return p;
}

function removePlayer(room, p, reason) {
  if (!room.players.has(p.id)) return;
  room.players.delete(p.id);
  room.dirty = true;
  if (!p.isBot) feed(room, `${p.name} 님이 나갔습니다.`);
  if (room.hostId === p.id) {
    const next = [...room.players.values()].filter((q) => !q.isBot).sort((a, b) => (b.connected - a.connected) || (a.order - b.order))[0];
    room.hostId = next ? next.id : null;
    if (next) feed(room, `${next.name} 님이 방장이 되었습니다.`);
  }
  if (room.phase === 'hide' || room.phase === 'seek') {
    if (p.role === 'seeker') endRound(room, 'hiders', '술래가 나가서 숨는 팀 승리!');
    else checkRoundOver(room);
  }
  log('player removed', room.code, p.name, reason || '');
}

function send(p, msg) {
  if (!p.ws || p.ws.readyState !== 1) return;
  try { p.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); } catch (e) { /* ignore */ }
}
function broadcast(room, msg) {
  const s = JSON.stringify(msg);
  for (const p of room.players.values()) send(p, s);
}
function feed(room, text, kind) { broadcast(room, { t: 'feed', text, kind: kind || 'info' }); }

function teleport(p, x, y) {
  p.x = x; p.y = y; p.cs++;
  p.lastPosAt = now();
  send(p, { t: 'correct', x, y, cs: p.cs });
}

function roomInfo(room) {
  return {
    t: 'room', code: room.code, hostId: room.hostId, phase: room.phase, round: room.round,
    settings: room.settings, hideChoices: HIDE_CHOICES, seekChoices: SEEK_CHOICES,
    players: [...room.players.values()].sort((a, b) => a.order - b.order).map((p) => ({
      id: p.id, name: p.name, color: p.color, role: p.role, score: p.score, connected: p.connected, bot: p.isBot,
    })),
  };
}

function activeCount(room) {
  let n = 0;
  for (const p of room.players.values()) if (p.isBot || p.connected) n++;
  return n;
}

function startRound(room) {
  const list = [...room.players.values()].filter((p) => p.isBot || p.connected).sort((a, b) => a.order - b.order);
  if (list.length < 2) { toLobby(room); return false; }
  // 술래 돌아가며 정하기
  let seeker = list.find((p) => p.order > room.lastSeekerOrder) || list[0];
  room.lastSeekerOrder = seeker.order;
  room.round++;
  room.phase = 'hide';
  room.phaseEnd = now() + room.settings.hide;
  room.pingsSent = 0;
  room.caughtCount = 0;
  for (const p of room.players.values()) {
    if (!p.isBot && !p.connected) { p.role = 'spectator'; continue; }
    p.role = p === seeker ? 'seeker' : 'hider';
    p.roundCatches = 0;
    const sp = spawnNear(C.SPAWN.x, C.SPAWN.y, p === seeker ? 0.5 : 2.5);
    teleport(p, sp.x, sp.y);
    if (p.bot) { p.bot.path = null; p.bot.goal = null; p.bot.think = 0; p.bot.lastSeen = null; }
  }
  room.dirty = true;
  broadcast(room, roomInfo(room));
  feed(room, `라운드 ${room.round} 시작! 술래는 ${seeker.name} — ${room.settings.hide}초 안에 숨으세요!`, 'big');
  return true;
}

function toLobby(room) {
  room.phase = 'lobby';
  for (const p of room.players.values()) p.role = 'lobby';
  room.dirty = true;
}

function hidersAlive(room) {
  let n = 0;
  for (const p of room.players.values()) if (p.role === 'hider') n++;
  return n;
}

function checkRoundOver(room) {
  if (room.phase !== 'hide' && room.phase !== 'seek') return;
  const seeker = [...room.players.values()].find((p) => p.role === 'seeker');
  if (!seeker) { endRound(room, 'hiders', '술래가 없어 숨는 팀 승리!'); return; }
  if (hidersAlive(room) === 0) {
    if (room.caughtCount > 0) endRound(room, 'seeker', `${seeker.name}(술래)가 모두 찾았습니다!`);
    else endRound(room, 'none', '숨는 사람이 없어 라운드를 끝냅니다.');
  }
}

function endRound(room, winner, text) {
  if (room.phase !== 'hide' && room.phase !== 'seek') return;
  room.phase = 'end';
  room.phaseEnd = now() + END_TIME;
  const survivors = [];
  for (const p of room.players.values()) {
    if (p.role === 'hider') { p.score += 3; survivors.push(p.name); }
    if (p.role === 'seeker' && winner === 'seeker') p.score += 3;
  }
  room.dirty = true;
  broadcast(room, { t: 'result', winner, text, survivors });
  feed(room, text, 'big');
}

function catchHider(room, seeker, h) {
  h.role = 'caught';
  seeker.score += 2;
  room.caughtCount++;
  room.dirty = true;
  feed(room, `${seeker.name}가 ${h.name}님을 찾았습니다! (남은 인원 ${hidersAlive(room)})`, 'catch');
  send(h, { t: 'caught' });
  checkRoundOver(room);
}

// ---------------- 봇 AI ----------------
function botFollow(p, dt, speed) {
  const b = p.bot;
  if (!b.path || !b.path.length) return false;
  const n = b.path[0];
  const dx = n.x - p.x, dy = n.y - p.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.15) { b.path.shift(); return true; }
  const step = Math.min(d, speed * dt);
  S.move(p, (dx / d) * step, (dy / d) * step);
  return true;
}
function botGo(p, tx, ty) {
  const path = findPath(p.x, p.y, tx, ty);
  p.bot.path = path || null;
  p.bot.goal = path ? { x: tx, y: ty } : null;
}

function updateBot(room, p, dt) {
  const b = p.bot;
  const t = now();
  if (p.role === 'lobby') {
    if (!b.path || !b.path.length) {
      if (t > b.think) { const f = pick(FLOOR); botGo(p, f.x + 0.5, f.y + 0.5); b.think = t + rand(1, 4); }
    } else botFollow(p, dt, C.HIDER_SPEED * 0.6);
    return;
  }
  if (p.role === 'caught' || p.role === 'spectator') {
    // 유령: 그냥 천천히 떠다님
    if (t > b.think) { b.goal = pick(FLOOR); b.think = t + rand(3, 8); }
    if (b.goal) {
      const dx = b.goal.x + 0.5 - p.x, dy = b.goal.y + 0.5 - p.y, d = Math.hypot(dx, dy);
      if (d > 0.2) { p.x += (dx / d) * Math.min(d, 2 * dt); p.y += (dy / d) * Math.min(d, 2 * dt); }
    }
    return;
  }
  if (room.phase === 'end') return;
  const players = [...room.players.values()];

  if (p.role === 'hider') {
    const seeker = players.find((q) => q.role === 'seeker');
    const threat = seeker && room.phase === 'seek' && dist(p, seeker) < 6 && S.lineOfSight(p.x, p.y, seeker.x, seeker.y) ? seeker : null;
    if (threat && t > b.think) {
      // 도망: 술래로부터 멀고 갈 수 있는 곳 선택
      let best = null, bestScore = -1;
      for (let i = 0; i < 25; i++) {
        const f = pick(FLOOR);
        const fx = f.x + 0.5, fy = f.y + 0.5;
        const dme = Math.hypot(fx - p.x, fy - p.y);
        if (dme > 9) continue;
        const sc = Math.hypot(fx - threat.x, fy - threat.y) - dme * 0.3 + (S.lineOfSight(fx, fy, threat.x, threat.y) ? 0 : 3);
        if (sc > bestScore) { bestScore = sc; best = { x: fx, y: fy }; }
      }
      if (best) botGo(p, best.x, best.y);
      b.think = t + 0.6;
      b.hiding = false;
    } else if (!b.path || !b.path.length) {
      if (!b.hiding || (room.phase === 'seek' && t > b.think && Math.random() < 0.002)) {
        // 숨을 곳 선택 (덤불 또는 구석, 스폰에서 멀리)
        const pool = Math.random() < 0.6 ? BUSHES : HIDE_SPOTS;
        let spot = null;
        for (let i = 0; i < 20; i++) {
          const s = pick(pool);
          const taken = players.some((q) => q !== p && q.role === 'hider' && Math.hypot(q.x - s.x - 0.5, q.y - s.y - 0.5) < 1.5);
          if (!taken && Math.hypot(s.x - C.SPAWN.x, s.y - C.SPAWN.y) > 7) { spot = s; break; }
        }
        spot = spot || pick(pool);
        botGo(p, spot.x + 0.5, spot.y + 0.5);
        b.hiding = true;
        b.think = t + 2;
      }
    }
    botFollow(p, dt, C.HIDER_SPEED * 0.95);
    return;
  }

  if (p.role === 'seeker') {
    if (room.phase === 'hide') return; // 눈 감고 대기
    const visible = players.filter((q) => q.role === 'hider' && canSee(room, p, q));
    if (visible.length) {
      visible.sort((a, c) => dist(p, a) - dist(p, c));
      const target = visible[0];
      b.lastSeen = { x: target.x, y: target.y };
      if (t > b.think || !b.path || !b.path.length) { botGo(p, target.x, target.y); b.think = t + 0.3; }
      if (b.path && b.path.length <= 1) {
        // 가까우면 직접 돌진
        const dx = target.x - p.x, dy = target.y - p.y, d = Math.hypot(dx, dy) || 1;
        S.move(p, (dx / d) * C.SEEKER_SPEED * 0.92 * dt, (dy / d) * C.SEEKER_SPEED * 0.92 * dt);
        return;
      }
    } else if (!b.path || !b.path.length) {
      if (b.lastSeen) { botGo(p, b.lastSeen.x, b.lastSeen.y); b.lastSeen = null; }
      else if (b.pingTarget) { botGo(p, b.pingTarget.x, b.pingTarget.y); b.pingTarget = null; }
      else {
        // 덤불/구석 위주로 탐색
        const pool = Math.random() < 0.5 ? BUSHES : (Math.random() < 0.5 ? HIDE_SPOTS : FLOOR);
        const s = pick(pool);
        botGo(p, s.x + 0.5, s.y + 0.5);
      }
    }
    botFollow(p, dt, C.SEEKER_SPEED * 0.92);
  }
}

// ---------------- 게임 루프 ----------------
function updateRoom(room, dt) {
  room.tick++;
  const t = now();
  const players = [...room.players.values()];

  // 끊긴 플레이어 정리
  for (const p of players) {
    if (!p.isBot && !p.connected) {
      const grace = room.phase === 'lobby' ? GRACE_LOBBY : GRACE_GAME;
      if (t - p.disconnectedAt > grace) removePlayer(room, p, 'timeout');
    }
  }
  const humans = [...room.players.values()].filter((p) => !p.isBot && p.connected).length;
  if (humans === 0) {
    if (!room.emptySince) room.emptySince = t;
    if (t - room.emptySince > EMPTY_ROOM_TTL || ![...room.players.values()].some((p) => !p.isBot)) {
      rooms.delete(room.code);
      log('room deleted', room.code, 'rooms=' + rooms.size);
      return;
    }
  } else room.emptySince = null;

  // 봇
  for (const p of room.players.values()) if (p.isBot) {
    try { updateBot(room, p, dt); } catch (e) { log('bot error', e && e.stack); p.bot.path = null; }
  }

  // 페이즈 진행
  if (room.phase === 'hide' && t >= room.phaseEnd) {
    room.phase = 'seek';
    room.phaseEnd = t + room.settings.seek;
    room.dirty = true;
    feed(room, '술래가 찾기 시작합니다! 🔍', 'big');
  } else if (room.phase === 'seek') {
    const left = room.phaseEnd - t;
    // 막판 위치 노출 (60, 40, 20초 남았을 때)
    const marks = [60, 40, 20].filter((m) => m < room.settings.seek);
    if (room.pingsSent < marks.length && left <= marks[room.pingsSent]) {
      room.pingsSent++;
      const pts = [...room.players.values()].filter((p) => p.role === 'hider').map((p) => [p.x + rand(-1.5, 1.5), p.y + rand(-1.5, 1.5)]);
      for (const p of room.players.values()) {
        if (p.role === 'seeker') { send(p, { t: 'ping', pts }); if (p.bot && pts.length) p.bot.pingTarget = { x: pts[0][0], y: pts[0][1] }; }
        if (p.role === 'hider') send(p, { t: 'exposed' });
      }
      feed(room, '📢 숨은 사람들의 대략적인 위치가 술래에게 노출되었습니다!', 'warn');
    }
    if (left <= 0) {
      endRound(room, 'hiders', `시간 종료! 숨는 팀 승리 (${hidersAlive(room)}명 생존)`);
    } else {
      // 잡기 판정
      const seekers = players.filter((p) => p.role === 'seeker' && room.players.has(p.id));
      for (const s of seekers) for (const h of players) {
        if (h.role === 'hider' && room.players.has(h.id) && dist(s, h) < C.CATCH_DIST && S.lineOfSight(s.x, s.y, h.x, h.y)) {
          catchHider(room, s, h);
          if (room.phase !== 'seek') break;
        }
      }
    }
  } else if (room.phase === 'end' && t >= room.phaseEnd) {
    if (!startRound(room)) { room.dirty = true; feed(room, '인원이 부족해 대기실로 돌아갑니다.'); }
  }

  if (room.dirty || room.tick % (TICK_HZ * 2) === 0) {
    room.dirty = false;
    broadcast(room, roomInfo(room));
  }

  // 상태 전송 (각자 볼 수 있는 것만)
  if (room.tick % SEND_EVERY === 0) {
    const all = [...room.players.values()];
    const tl = room.phase === 'lobby' ? 0 : Math.max(0, Math.ceil(room.phaseEnd - t));
    const seeker = all.find((p) => p.role === 'seeker');
    let alive = 0;
    for (const p of all) if (p.role === 'hider') alive++;
    for (const v of all) {
      if (v.isBot || !v.connected) continue;
      const ents = [];
      for (const q of all) {
        if (q === v) continue;
        if (canSee(room, v, q)) ents.push([q.id, Math.round(q.x * 100) / 100, Math.round(q.y * 100) / 100, S.inBush(q.x, q.y) ? 1 : 0]);
      }
      let danger = 0;
      if (v.role === 'hider' && room.phase === 'seek' && seeker) danger = Math.max(0, Math.min(1, 1 - (dist(v, seeker) - 1) / 9));
      send(v, { t: 'state', ph: room.phase, tl, alive, e: ents, d: Math.round(danger * 100) / 100, role: v.role });
    }
  }
}

let last = now();
setInterval(() => {
  const t = now();
  const dt = Math.min(0.1, t - last);
  last = t;
  for (const room of [...rooms.values()]) {
    try { updateRoom(room, dt); } catch (e) {
      log('room error', room.code, e && e.stack);
      // 망가진 방은 대기실로 리셋
      try { room.phase = 'lobby'; for (const p of room.players.values()) p.role = 'lobby'; room.dirty = true; } catch (e2) { rooms.delete(room.code); }
    }
  }
}, 1000 / TICK_HZ);

// ---------------- 메시지 처리 ----------------
function handle(ws, msg) {
  const ctx = ws.ctx;
  const t = msg.t;
  if (t === 'create' || t === 'join' || t === 'rejoin') {
    if (ctx.player) leave(ws);
    if (t === 'rejoin') {
      const room = rooms.get(String(msg.code || '').toUpperCase());
      const p = room && room.players.get(String(msg.id));
      if (!p || p.isBot || p.token !== msg.token) { send({ ws }, { t: 'error', code: 'rejoin_failed', msg: '이전 게임에 다시 들어갈 수 없습니다.' }); return; }
      if (p.ws && p.ws !== ws) { try { p.ws.ctx.player = null; p.ws.close(4000, 'replaced'); } catch (e) { /* ignore */ } }
      p.ws = ws; p.connected = true; p.cs++;
      ctx.player = p; ctx.room = room;
      room.dirty = true;
      send(p, { t: 'joined', code: room.code, id: p.id, token: p.token });
      send(p, { t: 'correct', x: p.x, y: p.y, cs: p.cs });
      send(p, roomInfo(room));
      feed(room, `${p.name} 님이 다시 접속했습니다.`);
      return;
    }
    let room;
    if (t === 'create') {
      if (rooms.size >= MAX_ROOMS) { send({ ws }, { t: 'error', msg: '서버에 방이 너무 많습니다. 잠시 후 다시 시도하세요.' }); return; }
      room = createRoom();
    } else {
      room = rooms.get(String(msg.code || '').toUpperCase().trim());
      if (!room) { send({ ws }, { t: 'error', msg: '방을 찾을 수 없습니다. 코드를 확인하세요.' }); return; }
      if (room.players.size >= MAX_PLAYERS) {
        // 봇이 있으면 봇 하나를 내보내고 자리 마련
        const bot = [...room.players.values()].find((p) => p.isBot);
        if (bot) removePlayer(room, bot, 'make room'); else { send({ ws }, { t: 'error', msg: '방이 가득 찼습니다.' }); return; }
      }
    }
    const p = addPlayer(room, cleanName(msg.name), ws, false);
    ctx.player = p; ctx.room = room;
    send(p, { t: 'joined', code: room.code, id: p.id, token: p.token });
    send(p, { t: 'correct', x: p.x, y: p.y, cs: p.cs });
    send(p, roomInfo(room));
    feed(room, `${p.name} 님이 들어왔습니다.${p.role === 'spectator' ? ' (다음 라운드부터 참가)' : ''}`);
    log('join', room.code, p.name, 'players=' + room.players.size);
    return;
  }

  const p = ctx.player, room = ctx.room;
  if (!p || !room || !rooms.has(room.code) || !room.players.has(p.id)) return;

  switch (t) {
    case 'pos': {
      if (msg.cs !== p.cs || !isNum(msg.x) || !isNum(msg.y)) return;
      const tt = now();
      const dt = Math.min(0.5, tt - p.lastPosAt);
      p.lastPosAt = tt;
      if (p.role === 'seeker' && room.phase === 'hide') {
        if (Math.hypot(msg.x - p.x, msg.y - p.y) > 0.05) send(p, { t: 'correct', x: p.x, y: p.y, cs: p.cs });
        return;
      }
      const ghost = p.role === 'caught' || p.role === 'spectator';
      const speed = ghost ? C.GHOST_SPEED : p.role === 'seeker' ? C.SEEKER_SPEED : C.HIDER_SPEED;
      let dx = msg.x - p.x, dy = msg.y - p.y;
      const d = Math.hypot(dx, dy);
      const maxD = speed * dt * 1.5 + 0.25;
      if (d > maxD) { dx = (dx / d) * maxD; dy = (dy / d) * maxD; }
      if (ghost) {
        p.x = S.clamp(p.x + dx, 0.5, S.W - 0.5);
        p.y = S.clamp(p.y + dy, 0.5, S.H - 0.5);
      } else {
        S.move(p, dx, dy);
      }
      if (Math.hypot(msg.x - p.x, msg.y - p.y) > 0.3) send(p, { t: 'correct', x: p.x, y: p.y, cs: p.cs });
      return;
    }
    case 'start':
      if (p.id !== room.hostId || room.phase !== 'lobby') return;
      if (activeCount(room) < 2) { send(p, { t: 'feed', text: '2명 이상 필요합니다. 친구를 초대하거나 봇을 추가하세요!', kind: 'warn' }); return; }
      startRound(room);
      return;
    case 'stop':
      if (p.id !== room.hostId || room.phase === 'lobby') return;
      toLobby(room);
      feed(room, '방장이 게임을 멈추고 대기실로 돌아왔습니다.');
      return;
    case 'addBot': {
      if (p.id !== room.hostId || room.players.size >= MAX_PLAYERS) return;
      const used = new Set([...room.players.values()].map((q) => q.name));
      const name = BOT_NAMES.find((n) => !used.has(n)) || '봇';
      addPlayer(room, name, null, true);
      feed(room, `${name} 추가됨`);
      return;
    }
    case 'removeBot': {
      if (p.id !== room.hostId) return;
      const bots = [...room.players.values()].filter((q) => q.isBot);
      if (bots.length) removePlayer(room, bots[bots.length - 1], 'host removed bot');
      return;
    }
    case 'settings':
      if (p.id !== room.hostId || room.phase !== 'lobby') return;
      if (HIDE_CHOICES.includes(msg.hide)) room.settings.hide = msg.hide;
      if (SEEK_CHOICES.includes(msg.seek)) room.settings.seek = msg.seek;
      room.dirty = true;
      return;
    case 'chat': {
      const text = String(msg.text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
      if (!text) return;
      const tt = now();
      p.chatTimes = p.chatTimes.filter((x) => tt - x < 5);
      if (p.chatTimes.length >= 5) return;
      p.chatTimes.push(tt);
      broadcast(room, { t: 'chat', name: p.name, color: p.color, text });
      return;
    }
    case 'leave':
      leave(ws);
      return;
  }
}

function leave(ws) {
  const { player, room } = ws.ctx;
  ws.ctx.player = null; ws.ctx.room = null;
  if (player && room && room.players.get(player.id) === player) removePlayer(room, player, 'left');
}

// ---------------- WebSocket ----------------
const wss = new WebSocketServer({ server, maxPayload: 4096, perMessageDeflate: false });
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.ctx = { player: null, room: null, bucket: 60, lastRefill: Date.now() };
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    const ctx = ws.ctx;
    const n = Date.now();
    ctx.bucket = Math.min(120, ctx.bucket + ((n - ctx.lastRefill) / 1000) * 60);
    ctx.lastRefill = n;
    if (ctx.bucket < 1) { ctx.flood = (ctx.flood || 0) + 1; if (ctx.flood > 300) ws.terminate(); return; }
    ctx.bucket -= 1;
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    try { handle(ws, msg); } catch (e) { log('handle error', e && e.stack); }
  });
  ws.on('close', () => {
    const p = ws.ctx.player;
    if (p && p.ws === ws) {
      p.connected = false;
      p.disconnectedAt = now();
      p.ws = null;
      if (ws.ctx.room) ws.ctx.room.dirty = true;
    }
  });
  ws.on('error', () => {});
});

// 죽은 연결 정리 (하트비트)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, 15000);

setInterval(() => {
  let players = 0;
  for (const r of rooms.values()) players += r.players.size;
  log(`status rooms=${rooms.size} players=${players} sockets=${wss.clients.size} rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`);
}, 10 * 60 * 1000);

process.on('uncaughtException', (e) => log('uncaughtException', e && e.stack));
process.on('unhandledRejection', (e) => log('unhandledRejection', e));

server.listen(PORT, () => log(`숨바꼭질 서버 실행 중: http://localhost:${PORT}`));

module.exports = { server, rooms };
