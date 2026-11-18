'use strict';
// 장시간 안정성 테스트: 짧은 라운드로 서버를 띄우고 가짜 클라이언트+봇으로 계속 플레이
// 사용법: node test/soak.js [초]  (기본 60초)
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const S = require('../public/shared.js');

const DURATION = Number(process.argv[2]) || 60;
const PORT = 3999;
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT, HIDE_TIME: 2, SEEK_TIME: 12, END_TIME: 2 },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
srv.stdout.on('data', (d) => { serverLog += d; });
srv.stderr.on('data', (d) => { serverLog += d; process.stderr.write(d); });
let serverDied = false;
srv.on('exit', (c) => { serverDied = true; console.error('SERVER EXITED', c); });

const stats = { results: 0, caught: 0, states: 0, reconnects: 0, errors: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name, opts = {}) {
  const c = { name, ws: null, id: null, token: null, code: null, x: 0, y: 0, cs: 0, role: 'lobby', closed: false };
  c.open = () => new Promise((res) => {
    c.ws = new WebSocket(`ws://localhost:${PORT}`);
    c.ws.on('open', res);
    c.ws.on('error', () => { stats.errors++; });
    c.ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'joined') { c.id = m.id; c.token = m.token; c.code = m.code; }
      if (m.t === 'correct') { c.x = m.x; c.y = m.y; c.cs = m.cs; }
      if (m.t === 'state') { stats.states++; c.role = m.role; c.phase = m.ph; }
      if (m.t === 'result') stats.results++;
      if (m.t === 'caught') stats.caught++;
      if (m.t === 'room') c.room = m;
    });
  });
  c.send = (m) => { if (c.ws && c.ws.readyState === 1) c.ws.send(typeof m === 'string' ? m : JSON.stringify(m)); };
  c.dir = Math.random() * 7;
  c.loop = setInterval(() => {
    if (Math.random() < 0.05) c.dir = Math.random() * 7;
    const sp = 4.2 / 20;
    const p = { x: c.x, y: c.y };
    S.move(p, Math.cos(c.dir) * sp, Math.sin(c.dir) * sp);
    c.x = p.x; c.y = p.y;
    c.send({ t: 'pos', x: c.x, y: c.y, cs: c.cs });
    if (opts.evil && Math.random() < 0.2) {
      c.send('garbage{{');
      c.send({ t: 'pos', x: 1e9, y: NaN, cs: c.cs });
      c.send({ t: 'pos', x: c.x + 30, y: c.y, cs: c.cs });
      c.send({ t: 'chat', text: 'x'.repeat(500) });
      c.send({ t: 'settings', hide: -1, seek: 'a' });
      c.send({ t: 'unknown' });
    }
  }, 50);
  return c;
}

function health() {
  return new Promise((res) => {
    http.get(`http://localhost:${PORT}/health`, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => res(JSON.parse(b))); }).on('error', () => res(null));
  });
}

(async () => {
  await sleep(600);
  const clients = [];
  for (let r = 0; r < 3; r++) {
    const host = client('host' + r);
    await host.open();
    host.send({ t: 'create', name: 'host' + r });
    await sleep(200);
    clients.push(host);
    for (let i = 0; i < 2; i++) {
      const g = client(`g${r}${i}`, { evil: r === 2 && i === 0 });
      await g.open();
      g.send({ t: 'join', code: host.code, name: `g${r}${i}` });
      clients.push(g);
    }
    for (let i = 0; i < 3; i++) host.send({ t: 'addBot' });
    await sleep(100);
    host.send({ t: 'start' });
  }
  const t0 = Date.now();
  let lastHealth = null;
  while (Date.now() - t0 < DURATION * 1000 && !serverDied) {
    await sleep(3000);
    // 무작위로 연결 끊고 재접속
    const c = clients[Math.floor(Math.random() * clients.length)];
    if (c.id) {
      c.ws.terminate();
      await sleep(300 + Math.random() * 1500);
      await c.open();
      c.send({ t: 'rejoin', code: c.code, id: c.id, token: c.token });
      stats.reconnects++;
    }
    lastHealth = await health();
    process.stdout.write(`\r${Math.round((Date.now() - t0) / 1000)}s ${JSON.stringify(stats)} ${JSON.stringify(lastHealth)}   `);
  }
  console.log();
  // 모두 떠나면 방이 정리되는지 확인
  for (const c of clients) { clearInterval(c.loop); c.ws.terminate(); }
  const ok = !serverDied && stats.results > 0 && lastHealth && lastHealth.ok;
  const errs = serverLog.split('\n').filter((l) => /error|Exception/i.test(l));
  if (errs.length) console.log('SERVER ERRORS:\n' + errs.join('\n'));
  srv.kill();
  console.log(ok && !errs.length ? 'SOAK TEST PASSED' : 'SOAK TEST FAILED');
  process.exit(ok && !errs.length ? 0 : 1);
})();
