(function (root) {
  'use strict';
  // 맵 범례: # 벽, o 상자(막힘/시야차단), ~ 물(막힘/시야통과), * 덤불(숨기), . 잔디, , 실내 바닥
  const MAP = [
    '############################################',
    '#,,,,,,,,#........*****..........#,,,,,,,,,#',
    '#,,o,,,,,#........*****..........#,,,,,,o,,#',
    '#,,o,,,,,,...........**..........,,,,,,,o,,#',
    '#,,,,,,oo#...~~~~................#,,,,,,,,,#',
    '#,,,,,,,,#...~~~~.......oo.......#,,oo,,,,,#',
    '####,#####...~~~~.......oo.......#####,#####',
    '#.........................**...............#',
    '#..**...........................***........#',
    '#..**.....######,######.........***....**..#',
    '#.........#,,,,,,,,,,,#................**..#',
    '#.........#,,o,,,,,o,,#.....~~~............#',
    '#...oo....,,,,,,,,,,,,,.....~~~.....**.....#',
    '#...oo....#,,,,,,,,,,,#.....~~~.....**.....#',
    '#.........#,,o,,,,,o,,#....................#',
    '#.........######,######.........oo.........#',
    '#**.......................oo....oo.....*...#',
    '#**...........***.........oo...........**..#',
    '#.............***..................#####,###',
    '######,####........................#,,,,,,,#',
    '#,,,,,,,,,#.......~~~.......**.....#,,o,,o,#',
    '#,,o,,,,,,#.......~~~.......**.....,,,,,,,,#',
    '#,,,,,,o,,,........................#,,,oo,,#',
    '#,,,,,,,,,#.....oo......***........#,,,,,,,#',
    '#,,oo,,,,,#.....oo......***........#,o,,,,,#',
    '##########.........................#,,,,,,,#',
    '#****..........................***.#########',
    '#****..........................***.........#',
    '############################################',
  ];
  const H = MAP.length;
  const W = MAP[0].length;

  const C = {
    VISION: 7.5,        // 시야 반경 (타일)
    R: 0.35,            // 플레이어 반지름
    HIDER_SPEED: 4.2,
    SEEKER_SPEED: 4.7,
    GHOST_SPEED: 7,
    CATCH_DIST: 0.85,
    BUSH_REVEAL: 1.6,   // 덤불 속 숨은 사람은 이 거리 안에서만 보임
    SPAWN: { x: 21.5, y: 7.5 },
  };

  function tile(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return '#';
    return MAP[ty][tx];
  }
  function solid(tx, ty) {
    const c = tile(tx, ty);
    return c === '#' || c === 'o' || c === '~';
  }
  function opaque(tx, ty) {
    const c = tile(tx, ty);
    return c === '#' || c === 'o';
  }
  function inBush(x, y) {
    return tile(Math.floor(x), Math.floor(y)) === '*';
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function resolve(p) {
    const r = C.R;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      const minX = Math.floor(p.x - r), maxX = Math.floor(p.x + r);
      const minY = Math.floor(p.y - r), maxY = Math.floor(p.y + r);
      for (let ty = minY; ty <= maxY; ty++) {
        for (let tx = minX; tx <= maxX; tx++) {
          if (!solid(tx, ty)) continue;
          const cx = clamp(p.x, tx, tx + 1), cy = clamp(p.y, ty, ty + 1);
          const dx = p.x - cx, dy = p.y - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 >= r * r) continue;
          if (d2 > 1e-9) {
            const d = Math.sqrt(d2);
            p.x += (dx / d) * (r - d);
            p.y += (dy / d) * (r - d);
          } else {
            // 중심이 타일 안: 가장 짧은 방향으로 밀어냄
            const l = p.x - tx, rr = tx + 1 - p.x, t = p.y - ty, b = ty + 1 - p.y;
            const m = Math.min(l, rr, t, b);
            if (m === l) p.x = tx - r; else if (m === rr) p.x = tx + 1 + r;
            else if (m === t) p.y = ty - r; else p.y = ty + 1 + r;
          }
          moved = true;
        }
      }
      if (!moved) break;
    }
    p.x = clamp(p.x, 1 + r, W - 1 - r);
    p.y = clamp(p.y, 1 + r, H - 1 - r);
  }

  // 벽 충돌을 고려해 이동 (터널링 방지를 위해 잘게 나눔)
  function move(p, dx, dy) {
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(dist / 0.2));
    for (let i = 0; i < steps; i++) {
      p.x += dx / steps; resolve(p);
      p.y += dy / steps; resolve(p);
    }
  }

  // 그리드 DDA 레이캐스트: 시야를 막는 타일까지의 거리
  function castRay(x0, y0, ang, maxDist) {
    const dx = Math.cos(ang), dy = Math.sin(ang);
    let tx = Math.floor(x0), ty = Math.floor(y0);
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tmx = dx !== 0 ? (dx > 0 ? tx + 1 - x0 : x0 - tx) * tdx : Infinity;
    let tmy = dy !== 0 ? (dy > 0 ? ty + 1 - y0 : y0 - ty) * tdy : Infinity;
    let t = 0;
    while (t < maxDist) {
      if (tmx < tmy) { tx += sx; t = tmx; tmx += tdx; }
      else { ty += sy; t = tmy; tmy += tdy; }
      if (opaque(tx, ty)) return Math.min(t, maxDist);
    }
    return maxDist;
  }

  function lineOfSight(x0, y0, x1, y1) {
    const d = Math.hypot(x1 - x0, y1 - y0);
    if (d < 1e-6) return true;
    return castRay(x0, y0, Math.atan2(y1 - y0, x1 - x0), d) >= d - 1e-6;
  }

  const api = { MAP, W, H, C, tile, solid, opaque, inBush, resolve, move, castRay, lineOfSight, clamp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HS = api;
})(typeof window !== 'undefined' ? window : globalThis);
