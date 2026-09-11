import { useState, useEffect, useRef } from "react";

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────
let COLS = 128, ROWS = 128, CELL = 6;
let W = COLS * CELL, H = ROWS * CELL;
let HX = 64, HY = 64;
const I = (x, y) => y * COLS + x;
const inB = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;
const dst = (ax, ay, bx, by) => Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2);

const POLLEN_CAP_NORMAL = 10;
const POLLEN_CAP_MOSAIC = 100;
// Read dynamically so mosaic bees carry much more
let POLLEN_CAP = POLLEN_CAP_NORMAL;
const FLOWER_MAX = 10;
const SPIRAL_GAP = 8;
const KILL_R = 1;
// BEE_MOVES, FLOWERS_INIT, SPIDERS_INIT, SPIDER_MIN_DIST now come from CFG.*
const BEE_MOVES = 300; // fallback — CFG.BEE_MOVES used in bee factories
const FLOWER_CD = 20;
const NPC_SPAWN_TIER_BASE = 50;
const WIN_BEES_STANDARD = 20; // 20 NPCs + protagonist = 21 total colony
// Endless mode has no win condition
const HEAT_MAX = 300;
const HEAT_DECAY_EVERY = 500; // basically permanent — ~150,000 ticks to fully clear a max-heat cell
const REVEAL_PROTO = 4;
const REVEAL_NPC = 2;
const TICK_MS = 80;

// Spiders must not spawn along the 45° diagonal bands — bees travel those routes constantly
// Band width of 5 cells each side of both diagonals
const DIAG_BAND = 5;
function onDiagonal(x, y) {
  return Math.abs(x - y) <= DIAG_BAND || Math.abs(x - (COLS - 1 - y)) <= DIAG_BAND;
}
const TIER_INTERVAL = 300;

// Combat: 3 bees within KILL_R of same spider = spider dies
const SWARM_COUNT = 3;

// ── BLUE: TACTICIAN — UNIT ROLES & COLONY STANCES ──────────────
const ROLE = {
  FORAGER:  'forager',
  SCOUT:    'scout',
  GUARD:    'guard',
  WARRIOR:  'warrior',
  KAMIKAZE: 'kamikaze',
};
const STANCE = {
  AGGRESSIVE: 'aggressive',
  BALANCED:   'balanced',
  DEFENSIVE:  'defensive',
};
const STANCE_RATIOS = {
  [STANCE.AGGRESSIVE]: [0.15, 0.10, 0.10, 0.45, 0.20],
  [STANCE.BALANCED]:   [0.35, 0.15, 0.20, 0.25, 0.05],
  [STANCE.DEFENSIVE]:  [0.45, 0.10, 0.35, 0.10, 0.00],
};
const STANCE_ENGAGE_MOD = {
  [STANCE.AGGRESSIVE]: 1.8,
  [STANCE.BALANCED]:   1.0,
  [STANCE.DEFENSIVE]:  0.6,
};
const STANCE_RETREAT_THRESH = {
  [STANCE.AGGRESSIVE]: 1.5,
  [STANCE.BALANCED]:   1.0,
  [STANCE.DEFENSIVE]:  0.7,
};
const WARRIOR_HUNT_R  = 55;
const KAMIKAZE_ARM_R  = 30;
const GUARD_LEASH_R   = 28;
const SCOUT_HEAT_SKIP = 40;

function pickRole(stance) {
  const ratios = STANCE_RATIOS[stance] || STANCE_RATIOS[STANCE.BALANCED];
  const r = Math.random();
  let cum = 0;
  const roles = [ROLE.FORAGER, ROLE.SCOUT, ROLE.GUARD, ROLE.WARRIOR, ROLE.KAMIKAZE];
  for (let i = 0; i < roles.length; i++) { cum += ratios[i]; if (r < cum) return roles[i]; }
  return ROLE.FORAGER;
}

function deriveEnemyStance(enemyNPCs, enemyHive, playerBees) {
  const alive = (enemyNPCs || []).filter(n => n.alive !== false).length + 1;
  const playerAlive = (playerBees || []).length;
  const ratio = alive / Math.max(1, playerAlive);
  if (ratio >= 1.3) return STANCE.AGGRESSIVE;
  if (ratio <= 0.7) return STANCE.DEFENSIVE;
  return STANCE.BALANCED;
}

// tacticianMove — per-role movement override, called inside stepNPC before default logic
// Returns [nx,ny] or null to fall through to standard movement
function tacticianMove(npc, grid, allPlayerBees, allEnemyBees, hx, hy, stance) {
  const role = npc.role;
  if (!role || role === ROLE.FORAGER) {
    const engageR = BVB_ENGAGE_R * (STANCE_ENGAGE_MOD[stance] || 1.0);
    const enemies = (npc.team === 'player' ? allEnemyBees : allPlayerBees).filter(e => e.alive !== false);
    const threat = enemies.find(e => dst(npc.x, npc.y, e.x, e.y) <= engageR * 2);
    if (threat) return stepToward(npc.x, npc.y, hx, hy);
    return null;
  }
  if (role === ROLE.SCOUT) {
    const engageR = BVB_ENGAGE_R * (STANCE_ENGAGE_MOD[stance] || 1.0);
    const enemies = (npc.team === 'player' ? allEnemyBees : allPlayerBees).filter(e => e.alive !== false);
    const threat = enemies.find(e => dst(npc.x, npc.y, e.x, e.y) <= engageR * 1.5);
    if (threat) {
      const dx = npc.x - threat.x, dy = npc.y - threat.y;
      const perp = Math.abs(dx) >= Math.abs(dy) ? [0, 1] : [1, 0];
      const nx = npc.x + perp[0], ny = npc.y + perp[1];
      if (inB(nx, ny)) return [nx, ny];
      return stepToward(npc.x, npc.y, hx, hy);
    }
    return null;
  }
  if (role === ROLE.GUARD) {
    const tooFar = dst(npc.x, npc.y, hx, hy) > GUARD_LEASH_R;
    if (tooFar) return stepToward(npc.x, npc.y, hx, hy);
    const engageR = BVB_ENGAGE_R * (STANCE_ENGAGE_MOD[stance] || 1.0);
    const enemies = (npc.team === 'player' ? allEnemyBees : allPlayerBees).filter(e => e.alive !== false);
    const target = enemies.find(e => dst(npc.x, npc.y, e.x, e.y) <= engageR);
    if (target) {
      const friends = (npc.team === 'player' ? allPlayerBees : allEnemyBees)
        .filter(f => f.alive !== false && dst(f.x, f.y, target.x, target.y) <= engageR + 2).length;
      if (friends >= 2) return stepToward(npc.x, npc.y, target.x, target.y);
    }
    return null;
  }
  if (role === ROLE.WARRIOR) {
    const engageR = BVB_ENGAGE_R * (STANCE_ENGAGE_MOD[stance] || 1.0);
    const enemies = (npc.team === 'player' ? allEnemyBees : allPlayerBees).filter(e => e.alive !== false);
    const retreatThresh = STANCE_RETREAT_THRESH[stance] || 1.0;
    const nearEnemies = enemies.filter(e => dst(npc.x, npc.y, e.x, e.y) <= engageR + 4);
    const nearFriends = (npc.team === 'player' ? allPlayerBees : allEnemyBees)
      .filter(f => f.alive !== false && f !== npc && dst(f.x, f.y, npc.x, npc.y) <= engageR + 4).length;
    if (nearEnemies.length > 0 && nearEnemies.length > nearFriends * retreatThresh) {
      return stepToward(npc.x, npc.y, hx, hy);
    }
    if (nearEnemies.length > 0) return stepToward(npc.x, npc.y, nearEnemies[0].x, nearEnemies[0].y);
    // Hunt: seek nearest enemy within hunt radius
    const prey = enemies
      .filter(e => dst(npc.x, npc.y, e.x, e.y) <= WARRIOR_HUNT_R)
      .sort((a, b) => dst(npc.x, npc.y, a.x, a.y) - dst(npc.x, npc.y, b.x, b.y))[0];
    if (prey) return stepToward(npc.x, npc.y, prey.x, prey.y);
    return null;
  }
  if (role === ROLE.KAMIKAZE) {
    const distFromHive = dst(npc.x, npc.y, hx, hy);
    if (distFromHive < KAMIKAZE_ARM_R) return null; // not armed yet — forage normally
    // Armed: beeline toward enemy hive, ignore everything else
    if (npc._enemyHX !== undefined) return stepToward(npc.x, npc.y, npc._enemyHX, npc._enemyHY);
    return null;
  }
  return null;
}

// ── RED: MAP SIZE CONFIGS ───────────────────────────────────────
const MAP_CONFIGS = {
  small:    { label:'SMALL',    COLS:80,  ROWS:80,  CELL:6, FLOWERS_INIT:92,  SPIDERS_INIT:5,  SPIDER_MIN_DIST:16, BEE_MOVES:200, RIVER_SEGS:2, BUSH_CLUSTERS:8,  ROCK_WALLS:5,  MUD_PATCHES:10, TRAIL_LEN:120, INNER_FLOWERS:8  },
  standard: { label:'STANDARD', COLS:128, ROWS:128, CELL:6, FLOWERS_INIT:150, SPIDERS_INIT:8,  SPIDER_MIN_DIST:25, BEE_MOVES:300, RIVER_SEGS:3, BUSH_CLUSTERS:18, ROCK_WALLS:10, MUD_PATCHES:22, TRAIL_LEN:150, INNER_FLOWERS:12 },
  large:    { label:'LARGE',    COLS:192, ROWS:192, CELL:5, FLOWERS_INIT:253, SPIDERS_INIT:14, SPIDER_MIN_DIST:35, BEE_MOVES:450, RIVER_SEGS:5, BUSH_CLUSTERS:30, ROCK_WALLS:18, MUD_PATCHES:38, TRAIL_LEN:100, INNER_FLOWERS:18 },
  epic:     { label:'EPIC',     COLS:256, ROWS:256, CELL:4, FLOWERS_INIT:420, SPIDERS_INIT:22, SPIDER_MIN_DIST:50, BEE_MOVES:600, RIVER_SEGS:7, BUSH_CLUSTERS:45, ROCK_WALLS:28, MUD_PATCHES:60, TRAIL_LEN:80,  INNER_FLOWERS:35 },
};
let CFG = MAP_CONFIGS.standard;
let isMosaicMode = false;
let isFibonacciMode = false;
let isTronMode = false; // Fibonacci only — full opacity solid color per cell, no blending

// Clockwise spiral step — advances the bee clockwise AND gradually outward
// Bees follow the Fibonacci spiral arms rather than orbiting a fixed radius
function stepClockwise(fx, fy, hx, hy, grid, bee = null) {
  const radius = dst(fx, fy, hx, hy);

  // Very close to hive — push outward in the bee's assigned direction
  if (radius < 3) {
    const initAngle = (bee && bee._fibAngle !== undefined) ? bee._fibAngle : Math.atan2(fy - hy, fx - hx);
    const tx = Math.round(hx + Math.cos(initAngle) * 4);
    const ty = Math.round(hy + Math.sin(initAngle) * 4);
    const candidates = [
      [fx+1,fy],[fx-1,fy],[fx,fy+1],[fx,fy-1],
      [fx+1,fy+1],[fx-1,fy-1],[fx+1,fy-1],[fx-1,fy+1],
    ].filter(([cx,cy]) => inB(cx,cy) && isPassable(grid[I(cx,cy)]));
    if (candidates.length === 0) return [fx, fy];
    candidates.sort((a, b) => dst(a[0],a[1],tx,ty) - dst(b[0],b[1],tx,ty));
    return [candidates[0][0], candidates[0][1]];
  }

  const angle = Math.atan2(fy - hy, fx - hx);
  const targetAngle = angle + 0.18;
  const targetRadius = radius + 0.8;
  const tx = Math.round(hx + Math.cos(targetAngle) * targetRadius);
  const ty = Math.round(hy + Math.sin(targetAngle) * targetRadius);

  const candidates = [
    [fx+1,fy],[fx-1,fy],[fx,fy+1],[fx,fy-1],
    [fx+1,fy+1],[fx-1,fy-1],[fx+1,fy-1],[fx-1,fy+1],
  ].filter(([cx,cy]) => inB(cx,cy) && isPassable(grid[I(cx,cy)]));

  if (candidates.length === 0) return [fx, fy];
  candidates.sort((a, b) => dst(a[0],a[1],tx,ty) - dst(b[0],b[1],tx,ty));
  return [candidates[0][0], candidates[0][1]];
}

function applyMapConfig(cfg) {
  CFG = cfg;
  COLS = cfg.COLS; ROWS = cfg.ROWS; CELL = cfg.CELL;
  W = COLS * CELL; H = ROWS * CELL;
  HX = Math.floor(COLS / 2); HY = Math.floor(ROWS / 2);
}

// Terrain move cost — how many moves it costs to step onto each type
const TERRAIN_COST = { empty:1, flower:1, hive:1, enemy_hive:1, spider:1, bush:2, mud:3, river:1, rock:Infinity };
function terrainMoveCost(cell) {
  if (!cell) return 1;
  const cost = TERRAIN_COST[cell.type] ?? 1;
  return cost === Infinity ? 1 : cost; // never charge infinity — bee is already there
}
function isPassable(cell) { return cell && TERRAIN_COST[cell.type] !== Infinity; }
function terrainRevealRadius(bee, grid, baseRadius) {
  const c = grid[I(bee.x, bee.y)];
  if (!c) return baseRadius;
  if (c.type === 'bush') return Math.max(1, Math.floor(baseRadius * 0.4));
  return baseRadius;
}

// Passable stepToward — routes around impassable terrain
// bee optional: if provided, uses lastPos to prevent oscillation
function stepTowardPassable(fx, fy, tx, ty, grid, bee = null) {
  const [nx, ny] = stepToward(fx, fy, tx, ty);
  if (isPassable(grid[I(nx, ny)])) return [nx, ny];

  const candidates = [
    [fx+1,fy],[fx-1,fy],[fx,fy+1],[fx,fy-1],
    [fx+1,fy+1],[fx-1,fy-1],[fx+1,fy-1],[fx-1,fy+1],
  ].filter(([cx,cy]) => inB(cx,cy) && isPassable(grid[I(cx,cy)]));

  if (candidates.length === 0) return [fx, fy];

  // Sort by distance to target
  candidates.sort((a,b) => dst(a[0],a[1],tx,ty) - dst(b[0],b[1],tx,ty));

  // Anti-oscillation: skip candidates that are where we just came from
  const lastX = bee?.lastPos?.x, lastY = bee?.lastPos?.y;
  if (lastX !== undefined && candidates.length > 1) {
    const nonReturn = candidates.filter(([cx,cy]) => !(cx === lastX && cy === lastY));
    if (nonReturn.length > 0) return [nonReturn[0][0], nonReturn[0][1]];
  }

  return [candidates[0][0], candidates[0][1]];
}

// River generation
function generateRiverLine(cols, rows) {
  const startEdge = Math.floor(Math.random() * 4);
  let x, y;
  if (startEdge === 0) { x = Math.floor(Math.random() * cols); y = 0; }
  else if (startEdge === 1) { x = cols - 1; y = Math.floor(Math.random() * rows); }
  else if (startEdge === 2) { x = Math.floor(Math.random() * cols); y = rows - 1; }
  else { x = 0; y = Math.floor(Math.random() * rows); }
  const line = [[x, y]];
  const targetEdge = (startEdge + 2) % 4;
  for (let step = 0; step < (cols + rows) * 2; step++) {
    let tx, ty;
    if (targetEdge === 0) { tx = x; ty = 0; }
    else if (targetEdge === 1) { tx = cols-1; ty = y; }
    else if (targetEdge === 2) { tx = x; ty = rows-1; }
    else { tx = 0; ty = y; }
    const [dx, dy] = [tx-x, ty-y];
    const r = Math.random();
    if (r < 0.6) { x += Math.sign(dx) || 0; }
    else if (r < 0.8) { y += Math.sign(dy) || 0; }
    else { x += (Math.random() < 0.5 ? 1 : -1); }
    if (!inBWH(x, y, cols, rows)) break;
    line.push([x, y]);
    if ((targetEdge === 0 && y === 0) || (targetEdge === 1 && x === cols-1) ||
        (targetEdge === 2 && y === rows-1) || (targetEdge === 3 && x === 0)) break;
  }
  return line;
}
function inBWH(x, y, cols, rows) { return x >= 0 && x < cols && y >= 0 && y < rows; }
function expandRiver(line, width, cols, rows) {
  const cells = new Set();
  for (const [cx, cy] of line) {
    for (let dy = -width; dy <= width; dy++) for (let dx = -width; dx <= width; dx++) {
      if (Math.sqrt(dx*dx+dy*dy) <= width && inBWH(cx+dx, cy+dy, cols, rows))
        cells.add(`${cx+dx},${cy+dy}`);
    }
  }
  return [...cells].map(k => k.split(',').map(Number));
}
function growBushCluster(grid, seedX, seedY, size, cols, rows) {
  const visited = new Set([`${seedX},${seedY}`]);
  const queue = [[seedX, seedY]];
  let count = 0;
  while (queue.length && count < size) {
    const idx = Math.floor(Math.random() * queue.length);
    const [cx, cy] = queue.splice(idx, 1)[0];
    const c = grid[I(cx, cy)];
    if (c && c.type === 'empty') { c.type = 'bush'; count++; }
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = cx+dx, ny = cy+dy, k = `${nx},${ny}`;
      if (inBWH(nx,ny,cols,rows) && !visited.has(k)) { visited.add(k); queue.push([nx,ny]); }
    }
  }
}
const BVB_COLS = 128, BVB_ROWS = 128;
// Player hive: top-left corner. Enemy hive: bottom-right corner.
// BvB corner positions — recomputed from COLS/ROWS after applyMapConfig
// These are read by initSim which runs after applyMapConfig, so they're always current
const bvbCorners = () => ({
  P_HX: 8, P_HY: 8,
  E_HX: COLS - 9, E_HY: ROWS - 9,
});
// Static aliases for default (standard) map — used in function defaults only
const P_HX = 8, P_HY = 8;
const E_HX = 119, E_HY = 119;
const BVB_ENGAGE_R = 4;   // range to detect enemy bee
const BVB_KILL_R   = 2;   // 3 friendlies within this of enemy = instant kill
const BVB_HIVE_KILL_R = 3; // 3 player bees within this of enemy hive = win

// ─────────────────────────────────────────────────────────
// SPIRAL
// ─────────────────────────────────────────────────────────
function buildSpiral() {
  const p = [];
  let x = 0, y = 0, dx = 1, dy = 0, seg = 1, done = 0, turns = 0, n = 0;
  while (n < 120000) {
    if (n % SPIRAL_GAP === 0) { const ax = HX + x, ay = HY + y; if (inB(ax, ay)) p.push([ax, ay]); }
    x += dx; y += dy; done++; n++;
    if (done === seg) { done = 0; const t = dx; dx = -dy; dy = t; turns++; if (turns % 2 === 0) seg++; }
  }
  return p;
}
let SPIRAL = buildSpiral();
let _spiralForCols = COLS;

function getSpiral() {
  if (_spiralForCols !== COLS) { SPIRAL = buildSpiral(); _spiralForCols = COLS; }
  return SPIRAL;
}

// Build a spiral centered on any hive position (for BvB corner hives)
function buildLocalSpiral(cx, cy) {
  const p = [];
  let x = 0, y = 0, dx = 1, dy = 0, seg = 1, done = 0, turns = 0, n = 0;
  while (n < 120000) {
    if (n % SPIRAL_GAP === 0) { const ax = cx + x, ay = cy + y; if (inB(ax, ay)) p.push([ax, ay]); }
    x += dx; y += dy; done++; n++;
    if (done === seg) { done = 0; const t = dx; dx = -dy; dy = t; turns++; if (turns % 2 === 0) seg++; }
  }
  return p;
}

function stepToward(fx, fy, tx, ty) {
  if (fx === tx && fy === ty) return [fx, fy];
  const ax = Math.abs(tx - fx), ay = Math.abs(ty - fy);
  if (ax >= ay) return [fx + (tx > fx ? 1 : -1), fy];
  return [fx, fy + (ty > fy ? 1 : -1)];
}

// ─────────────────────────────────────────────────────────
// BvB COLOR SYSTEM
// Player = blue family (blue → purple → teal/green edge)
// Enemy  = red family  (red → orange → yellow edge)
// Each bee still gets its own distinct shade via golden angle
// within its family's hue range.
// ─────────────────────────────────────────────────────────
function bvbColor(id, colorFamily) {
  // colorFamily: 'blue' (player default) or 'red' (enemy default)
  // Blue family: hue 180–300 (cyan → blue → purple)
  // Red family:  hue 0–80   (red → orange → yellow)
  const range = colorFamily === 'red' ? { start: 0, span: 80 } : { start: 180, span: 120 };
  const hue = (range.start + (id * 137.508) % range.span + 360) % 360;
  const h = hue / 360, s = 0.85, l = 0.55;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p2 = 2 * l - q;
  const hue2rgb = t => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p2 + (q - p2) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p2 + (q - p2) * (2/3 - t) * 6;
    return p2;
  };
  return {
    r: Math.round(hue2rgb(h + 1/3) * 255),
    g: Math.round(hue2rgb(h) * 255),
    b: Math.round(hue2rgb(h - 1/3) * 255),
  };
}

// ─────────────────────────────────────────────────────────
// BvB WORLD — two hives at opposing corners
// ─────────────────────────────────────────────────────────
function makeBvBGrid(phx = P_HX, phy = P_HY, ehx = E_HX, ehy = E_HY) {
  const g = Array.from({ length: COLS * ROWS }, () => ({
    type: 'empty', pollen: 0, max: FLOWER_MAX, cd: 0,
    revealed: false, heat: 0, dead: false, lives: 999,
    visited: false, lastVisited: 0, visitCount: 0,
    eRevealed: false,  // revealed by enemy bees
  }));

  g[I(phx, phy)].type = 'hive';       g[I(phx, phy)].revealed = true;
  g[I(ehx, ehy)].type = 'enemy_hive'; // hidden until discovered

  // Scatter flowers — more than standard so there's plenty to fight over
  let fc = 0;
  while (fc < 160) {
    const fx = 2 + Math.floor(Math.random() * (COLS - 4));
    const fy = 2 + Math.floor(Math.random() * (ROWS - 4));
    const cell = g[I(fx, fy)];
    if (cell.type === 'empty'
        && dst(fx, fy, phx, phy) > 6
        && dst(fx, fy, ehx, ehy) > 6) {
      const d = Math.min(dst(fx, fy, phx, phy), dst(fx, fy, ehx, ehy));
      const diagBonus = onDiagonal(fx, fy) ? 1.1 : 1.0;
      cell.type = 'flower';
      cell.pollen = Math.min(FLOWER_MAX, Math.round((Math.floor(Math.random() * FLOWER_MAX) + 3) * diagBonus));
      cell.lives = flowerLivesByDist(d, 1.0);
      fc++;
    }
  }

  // Spiders — far from both hives
  let sc = 0;
  while (sc < 10) {
    const sx = 2 + Math.floor(Math.random() * (COLS - 4));
    const sy = 2 + Math.floor(Math.random() * (ROWS - 4));
    const cell = g[I(sx, sy)];
    if (cell.type === 'empty'
        && dst(sx, sy, phx, phy) > CFG.SPIDER_MIN_DIST
        && dst(sx, sy, ehx, ehy) > CFG.SPIDER_MIN_DIST
        && !onDiagonal(sx, sy)) {
      cell.type = 'spider'; sc++;
    }
  }
  return g;
}

// ─────────────────────────────────────────────────────────
// BvB BEE FACTORIES
// ─────────────────────────────────────────────────────────
function makeBvBProto(team, hx = P_HX, hy = P_HY) {
  const col = bvbColor(0, team === 'red' ? 'red' : 'blue');
  return {
    x: hx, y: hy, moves: CFG.BEE_MOVES, pollen: 0,
    returning: false, phase: 'spiral', spiralIdx: 0,
    ldx: 1, ldy: 0, trail: [],
    straightSteps: 0, lastDx: 0, lastDy: 0,
    circling: false, circleStep: 0, circleCX: 0, circleCY: 0,
    state: null, alarmTarget: null, alarmCircle: null, alarmCircleIdx: 0, alarmLaps: 0,
    team, hx, hy, ...col,
    bvbState: null,   // null | 'standoff' | 'encircle' | 'retreat'
    bvbTarget: null,  // enemy bee being engaged
  };
}

function makeBvBNPC(id, team, hx = null, hy = null, colorFamily = null) {
  if (hx === null) hx = team === 'player' ? P_HX : E_HX;
  if (hy === null) hy = team === 'player' ? P_HY : E_HY;
  if (colorFamily === null) colorFamily = team === 'player' ? 'blue' : 'red';
  const angle = Math.random() * Math.PI * 2;
  const col = bvbColor(id, colorFamily);
  return {
    id, x: hx, y: hy, pollen: 0, moves: CFG.BEE_MOVES,
    returning: false, alive: true,
    tx: null, ty: null, mode: 'discover',
    personality: Math.random() < 0.5 ? 'spiral' : 'linear',
    ldx: Math.round(Math.cos(angle)) || 1,
    ldy: Math.round(Math.sin(angle)) || 0,
    spiralIdx: Math.floor(Math.random() * 80),
    straightSteps: 0, lastDx: 0, lastDy: 0,
    circling: false, circleStep: 0, circleCX: 0, circleCY: 0,
    trail: [],
    state: null, alarmTarget: null, alarmCircle: null, alarmCircleIdx: 0, alarmLaps: 0,
    team, hx, hy, ...col,
    bvbState: null, bvbTarget: null,
    zoneRole: null,   // null | 'patrol' | 'advance'
  };
}

// ─────────────────────────────────────────────────────────
// BvB COMBAT ENGINE
// ─────────────────────────────────────────────────────────

// Count nearby friendly bees around a position
function countFriendliesNear(x, y, team, allBees, r) {
  return allBees.filter(b =>
    b.team === team && b.alive !== false &&
    dst(b.x, b.y, x, y) <= r
  ).length;
}

// Count nearby enemy bees around a position
function countEnemiesNear(x, y, team, allBees, r) {
  return allBees.filter(b =>
    b.team !== team && b.alive !== false &&
    dst(b.x, b.y, x, y) <= r
  ).length;
}

// Per-tick BvB combat resolution
// Returns set of bee ids killed this tick
function resolveBvBCombat(allBees, grid, log) {
  const killed = new Set();

  for (const bee of allBees) {
    if (bee.alive === false || killed.has(bee)) continue;

    const enemiesNear = allBees.filter(e =>
      e.team !== bee.team && e.alive !== false &&
      !killed.has(e) &&
      dst(bee.x, bee.y, e.x, e.y) <= BVB_ENGAGE_R
    );

    if (enemiesNear.length === 0) {
      // No enemies nearby — clear combat state
      if (bee.bvbState) { bee.bvbState = null; bee.bvbTarget = null; }
      continue;
    }

    // For each nearby enemy, calculate odds
    for (const enemy of enemiesNear) {
      if (killed.has(enemy)) continue;

      const myFriends = countFriendliesNear(bee.x, bee.y, bee.team, allBees, BVB_ENGAGE_R);
      const theirFriends = countFriendliesNear(enemy.x, enemy.y, enemy.team, allBees, BVB_ENGAGE_R);

      if (myFriends === theirFriends) {
        // Even matchup or 1v1 — both retreat
        bee.bvbState = 'retreat';
        bee.bvbTarget = null;
        enemy.bvbState = 'retreat';
        enemy.bvbTarget = null;
      } else if (myFriends > theirFriends) {
        // We outnumber them
        if (myFriends >= 3 && theirFriends < myFriends) {
          // 3+ vs fewer — instant kill
          killed.add(enemy);
          log.push(`⚔ ${bee.team} bees killed enemy bee! (${myFriends}v${theirFriends})`);
          // All my bees that were encircling resume
          allBees.filter(b => b.team === bee.team && b.bvbTarget === enemy).forEach(b => {
            b.bvbState = null; b.bvbTarget = null;
          });
        } else {
          // 2v1 — encircle and wait for 3rd
          bee.bvbState = 'encircle';
          bee.bvbTarget = enemy;
          enemy.bvbState = 'trapped';
          enemy.bvbTarget = bee;
        }
      } else {
        // They outnumber us — retreat
        bee.bvbState = 'retreat';
        bee.bvbTarget = null;
      }
      break; // handle one enemy per bee per tick
    }
  }

  return killed;
}

// Move a bee according to its BvB state
// Returns [nx, ny] or null if no special movement needed
function bvbMove(bee, allBees, hx, hy) {
  if (!bee.bvbState) return null;

  if (bee.bvbState === 'retreat') {
    // Head home
    const [nx, ny] = stepToward(bee.x, bee.y, hx, hy);
    // Clear retreat state once far enough from any enemy
    const anyEnemy = allBees.some(e =>
      e.team !== bee.team && e.alive !== false &&
      dst(bee.x, bee.y, e.x, e.y) <= BVB_ENGAGE_R + 4
    );
    if (!anyEnemy) bee.bvbState = null;
    return [nx, ny];
  }

  if (bee.bvbState === 'encircle' && bee.bvbTarget) {
    // Circle around the enemy bee at radius 2
    const target = bee.bvbTarget;
    if (target.alive === false) { bee.bvbState = null; bee.bvbTarget = null; return null; }
    const angle = Math.atan2(bee.y - target.y, bee.x - target.x) + 0.4;
    const cx = Math.round(target.x + Math.cos(angle) * 2);
    const cy = Math.round(target.y + Math.sin(angle) * 2);
    if (inB(cx, cy)) return stepToward(bee.x, bee.y, cx, cy);
    return null;
  }

  if (bee.bvbState === 'trapped') {
    // Try to signal — move toward nearest friendly
    const nearest = allBees.filter(b => b.team === bee.team && b.alive !== false && b !== bee)
      .sort((a, b2) => dst(bee.x, bee.y, a.x, a.y) - dst(bee.x, bee.y, b2.x, b2.y))[0];
    if (nearest) return stepToward(bee.x, bee.y, nearest.x, nearest.y);
    return null;
  }

  return null;
}

// Check if player has won by surrounding enemy hive
function checkHiveKill(allBees, grid, log, ehx = E_HX, ehy = E_HY) {
  const playerBeesNearEnemyHive = allBees.filter(b =>
    b.team === 'player' && b.alive !== false &&
    dst(b.x, b.y, ehx, ehy) <= BVB_HIVE_KILL_R
  ).length;
  if (playerBeesNearEnemyHive >= 3) {
    log.push('🏆 Enemy hive destroyed! Player wins!');
    return true;
  }
  return false;
}

// Enemy hive NPC spawner — mirrors player spawn logic
function spawnEnemyNPC(enemyNPCs, enemyNpcNext, hive, log, ehx = E_HX, ehy = E_HY, playerTeam = 'blue') {
  const id = enemyNpcNext;
  const enemyColor = playerTeam === 'red' ? 'blue' : 'red';
  const npc = makeBvBNPC(id, 'enemy', ehx, ehy, enemyColor);
  npc.isEnemy = true;
  enemyNPCs.push(npc);
  log.push(`Enemy colony grew to ${enemyNPCs.filter(n => n.alive !== false).length + 1}`);
  return id + 1;
}

// Waypoint proximity — is a position within range of any waypoint?
function nearWaypoint(x, y, waypoints, r = 6) {
  return waypoints && waypoints.some(w => dst(x, y, w.x, w.y) <= r);
}

// Is a waypoint currently occupied by a friendly bee?
function waypointOccupied(wp, bees, r = 4) {
  return bees.some(b => b.alive !== false && dst(b.x, b.y, wp.x, wp.y) <= r);
}
const MEM = { flowers: [], dangers: new Set(), spiders: [] };

function memLearn(grid) {
  MEM.flowers = [];
  MEM.spiders = [];
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const c = grid[I(x, y)];
    if (!c.revealed) continue;
    if (c.type === 'flower' && !c.dead) MEM.flowers.push({ x, y, pollen: c.pollen });
    if (c.type === 'spider') {
      MEM.spiders.push({ x, y });
      for (let dy = -(KILL_R + 1); dy <= KILL_R + 1; dy++)
        for (let dx = -(KILL_R + 1); dx <= KILL_R + 1; dx++)
          MEM.dangers.add(`${x + dx},${y + dy}`);
    }
  }
}

const isDanger = (x, y) => MEM.dangers.has(`${x},${y}`);

function clearSpiderFromMemory(sx, sy) {
  for (let dy = -(KILL_R + 2); dy <= KILL_R + 2; dy++)
    for (let dx = -(KILL_R + 2); dx <= KILL_R + 2; dx++)
      MEM.dangers.delete(`${sx + dx},${sy + dy}`);
  MEM.spiders = MEM.spiders.filter(s => !(s.x === sx && s.y === sy));
}

function reveal(grid, x, y, r, turn = 0, enemy = false) {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const nx = x + dx, ny = y + dy;
    if (inB(nx, ny) && Math.sqrt(dx * dx + dy * dy) <= r) {
      const c = grid[I(nx, ny)];
      if (enemy) {
        c.eRevealed = true;
      } else {
        c.revealed = true;
        c.visited = true;
        c.lastVisited = turn;
        c.visitCount = (c.visitCount || 0) + 1;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────
// WORLD GENERATION
// ─────────────────────────────────────────────────────────

// ── ORANGE: SIX FLOWER TYPES ────────────────────────────────────
const FLOWER_TYPES = {
  clover:      { label:'Clover',        color:'#66bb6a', nectar:2,  lives:20, regen:10, rare:false, minDist:5  },
  wildflower:  { label:'Wildflower',    color:'#ff7043', nectar:4,  lives:14, regen:18, rare:false, minDist:10 },
  deepbloom:   { label:'Deep Bloom',    color:'#7c4dff', nectar:9,  lives:8,  regen:30, rare:true,  minDist:45 },
  pollenflower:{ label:'Pollen Flower', color:'#ffca28', nectar:3,  lives:12, regen:22, rare:false, minDist:8  },
  nectarbloom: { label:'Nectar Bloom',  color:'#e91e8c', nectar:10, lives:6,  regen:40, rare:true,  minDist:20 },
  sunflower:   { label:'Sunflower',     color:'#ffd600', nectar:6,  lives:16, regen:25, rare:false, minDist:15 },
};
const FLOWER_TYPE_KEYS = Object.keys(FLOWER_TYPES);
function pickFlowerType(d) {
  const pool = FLOWER_TYPE_KEYS.filter(k => {
    const ft = FLOWER_TYPES[k];
    return !(ft.rare && d < ft.minDist) && d >= ft.minDist;
  });
  if (pool.length === 0) return 'clover';
  const weighted = [];
  for (const k of pool) { weighted.push(k); if (!FLOWER_TYPES[k].rare) weighted.push(k, k); }
  return weighted[Math.floor(Math.random() * weighted.length)];
}

// ── ORANGE: QUEEN ────────────────────────────────────────────────
const SATELLITE_BUILD_COST = 500;  // pollen needed to activate a satellite hive
const SATELLITE_MIN_DIST   = 35;   // minimum distance from any existing hive
const SATELLITE_SCAN_R     = 12;   // radius used to measure flower density at candidate
const SATELLITE_TITHE      = 2;    // pollen tithed per bee passing within range
const SATELLITE_TITHE_R    = 8;    // range within which returning bees tithe
const SATELLITE_SPAWN_CAP  = 10;   // max NPCs per satellite before it seeks another

function makeQueen(hx, hy) {
  return {
    x: hx, y: hy, health: 100, maxHealth: 100,
    alive: true, directive: 'auto', directiveTick: 0,
  };
}

// Evaluate flower density score at (cx,cy) within radius r
function flowerDensityAt(cx, cy, grid, r) {
  let score = 0;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const nx = cx + dx, ny = cy + dy;
    if (!inB(nx, ny) || Math.sqrt(dx*dx+dy*dy) > r) continue;
    const c = grid[I(nx, ny)];
    if (c.type === 'flower' && !c.dead) score += (c.pollen || 0) + (c.lives || 0) * 2;
  }
  return score;
}

// Queen chooses the best satellite site: densest flower cluster far from all hives
function queenChooseSite(grid, hives) {
  let best = null, bestScore = 0;
  // Sample candidate points on a coarse grid
  for (let cy = 8; cy < ROWS - 8; cy += 6) {
    for (let cx = 8; cx < COLS - 8; cx += 6) {
      if (!inB(cx, cy)) continue;
      const c = grid[I(cx, cy)];
      if (c.type === 'rock' || c.type === 'river') continue;
      // Must be far from all existing hives
      const tooClose = hives.some(h => dst(cx, cy, h.x, h.y) < SATELLITE_MIN_DIST);
      if (tooClose) continue;
      const score = flowerDensityAt(cx, cy, grid, SATELLITE_SCAN_R);
      if (score > bestScore) { bestScore = score; best = { x: cx, y: cy }; }
    }
  }
  return best; // null if no good site found
}

function stepQueen(queen, hive, spidersInMem, log, turn) {
  if (!queen.alive) return;
  if (hive.pollen < 20) queen.health = Math.max(0, queen.health - 0.05);
  else queen.health = Math.min(queen.maxHealth, queen.health + 0.02);
  if (queen.health <= 0) { queen.alive = false; log.push('👑 Queen has died! Spawning halted.'); return; }
  if (queen.directive === 'auto' && turn % 100 === 0) {
    const spiderNear = spidersInMem.length > 0;
    if (spiderNear) { queen.directive = 'defend'; queen.directiveTick = turn; log.push('👑 Queen: DEFEND — spiders near.'); }
    else if (hive.pollen < 30) { queen.directive = 'forage'; queen.directiveTick = turn; log.push('👑 Queen: FORAGE — stores low.'); }
    else queen.directive = 'auto';
  }
  if (queen.directive !== 'auto' && turn - queen.directiveTick > 200) queen.directive = 'auto';
}

// Make a satellite hive object
function makeSatelliteHive(x, y, id) {
  return {
    id, x, y,
    pollen: 0,           // construction pollen accumulated
    active: false,       // true once SATELLITE_BUILD_COST reached
    hivePollen: 0,       // active hive's pollen store
    npcs: [],            // bees spawned from this satellite
    npcNext: 1,
    spawnCD: 0,
    beeCount: 0,
    queen: null,         // gets a queen when active
  };
}

// ── MOSAIC MODE — geometric flower patterns ──────────────────────
const MOSAIC_PATTERNS = {
  mandala: {
    label: 'MANDALA',
    desc: 'Concentric rings with radial spokes — bees trace a starburst',
    emoji: '🌸',
  },
  fibonacci: {
    label: 'FIBONACCI SPIRAL',
    desc: 'Golden angle placement like sunflower seeds — dense spiral arms',
    emoji: '🌀',
  },
  hexlattice: {
    label: 'HEX LATTICE',
    desc: 'Honeycomb grid across the full map — bees form hex highways',
    emoji: '⬡',
  },
  radial: {
    label: 'RADIAL RINGS',
    desc: 'Concentric circles at fixed intervals — bees orbit in rings',
    emoji: '◎',
  },
  clusters: {
    label: 'GRID CLUSTERS',
    desc: 'Regular grid of 5-flower clusters — bees build a grid of highways',
    emoji: '⊞',
  },
  checkerboard: {
    label: 'CHECKERBOARD',
    desc: 'Alternating dense and sparse zones — trails reveal the grid',
    emoji: '⊟',
  },
};

function placeFlower(g, x, y, typeKey, pollen, lives) {
  if (!inB(x, y)) return;
  const c = g[I(x, y)];
  if (c.type !== 'empty') return;
  c.type = 'flower';
  c.flowerType = typeKey || 'clover';
  c.pollen = Math.min(FLOWER_MAX, pollen || FLOWER_MAX);
  c.lives = lives || 16;
}

function makeMosaicGrid(pattern) {
  const cols = COLS, rows = ROWS;
  const cx = Math.floor(cols / 2), cy = Math.floor(rows / 2);

  const g = Array.from({ length: cols * rows }, () => ({
    type: 'empty', pollen: 0, max: FLOWER_MAX, cd: 0,
    revealed: false, heat: 0, dead: false, lives: 999,
    eRevealed: false, visited: false, lastVisited: 0, visitCount: 0,
    paint: null,  // { r, g, b } — permanent bee color imprint, mosaic mode only
  }));

  g[I(cx, cy)].type = 'hive';
  g[I(cx, cy)].revealed = true;

  const ringTypes = ['clover','wildflower','sunflower','pollenflower','deepbloom','nectarbloom'];

  if (pattern === 'mandala') {
    // Concentric rings every 14 cells, alternating flower types
    // Radial spokes every 22.5° of clover connecting rings
    const rings = Math.floor(Math.min(cols, rows) / 28);
    for (let r = 1; r <= rings; r++) {
      const radius = r * 14;
      const ft = ringTypes[(r - 1) % ringTypes.length];
      const steps = Math.ceil(Math.PI * 2 * radius / 2.5);
      for (let s = 0; s < steps; s++) {
        const angle = (s / steps) * Math.PI * 2;
        const fx = Math.round(cx + Math.cos(angle) * radius);
        const fy = Math.round(cy + Math.sin(angle) * radius);
        placeFlower(g, fx, fy, ft, FLOWER_MAX, 20);
      }
    }
    // 8 radial spokes
    for (let spoke = 0; spoke < 8; spoke++) {
      const angle = (spoke / 8) * Math.PI * 2;
      const maxR = Math.floor(Math.min(cols, rows) / 2) - 6;
      for (let r = 4; r < maxR; r += 3) {
        const fx = Math.round(cx + Math.cos(angle) * r);
        const fy = Math.round(cy + Math.sin(angle) * r);
        placeFlower(g, fx, fy, 'clover', FLOWER_MAX, 18);
      }
    }
  }

  else if (pattern === 'fibonacci') {
    // Golden angle spiral — φ = 137.508°
    const PHI_ANGLE = 137.508 * (Math.PI / 180);
    const maxR = Math.floor(Math.min(cols, rows) / 2) - 8;
    const count = Math.floor(Math.PI * maxR * maxR / 6);
    for (let n = 1; n <= count; n++) {
      const r = Math.sqrt(n) * (maxR / Math.sqrt(count));
      const angle = n * PHI_ANGLE;
      const fx = Math.round(cx + Math.cos(angle) * r);
      const fy = Math.round(cy + Math.sin(angle) * r);
      // Color by distance band
      const band = Math.floor(r / (maxR / ringTypes.length));
      placeFlower(g, fx, fy, ringTypes[band % ringTypes.length], FLOWER_MAX, 16);
    }
  }

  else if (pattern === 'hexlattice') {
    // Hexagonal lattice — offset rows
    const spacing = 10;
    const hSpacing = spacing;
    const vSpacing = Math.round(spacing * 0.866);
    for (let row = 0; row * vSpacing < rows - 4; row++) {
      for (let col = 0; col * hSpacing < cols - 4; col++) {
        const fx = 4 + col * hSpacing + (row % 2 === 0 ? 0 : Math.floor(hSpacing / 2));
        const fy = 4 + row * vSpacing;
        const d = dst(fx, fy, cx, cy);
        const band = Math.floor(d / 20) % ringTypes.length;
        placeFlower(g, fx, fy, ringTypes[band], FLOWER_MAX, 18);
      }
    }
  }

  else if (pattern === 'radial') {
    // Pure concentric rings, tighter spacing, more rings
    const maxR = Math.floor(Math.min(cols, rows) / 2) - 6;
    for (let r = 8; r <= maxR; r += 8) {
      const ft = ringTypes[Math.floor(r / 8) % ringTypes.length];
      const steps = Math.ceil(Math.PI * 2 * r / 2);
      for (let s = 0; s < steps; s++) {
        const angle = (s / steps) * Math.PI * 2;
        const fx = Math.round(cx + Math.cos(angle) * r);
        const fy = Math.round(cy + Math.sin(angle) * r);
        placeFlower(g, fx, fy, ft, FLOWER_MAX, 18);
      }
    }
  }

  else if (pattern === 'clusters') {
    // Regular NxN grid of 5-flower plus-shaped clusters
    const spacing = 18;
    for (let row = 1; row * spacing < rows - 4; row++) {
      for (let col = 1; col * spacing < cols - 4; col++) {
        const fx = col * spacing, fy = row * spacing;
        const d = dst(fx, fy, cx, cy);
        const ft = ringTypes[Math.floor(d / 30) % ringTypes.length];
        // Plus shape: center + 4 orthogonal
        placeFlower(g, fx, fy, ft, FLOWER_MAX, 20);
        placeFlower(g, fx+2, fy, ft, FLOWER_MAX, 20);
        placeFlower(g, fx-2, fy, ft, FLOWER_MAX, 20);
        placeFlower(g, fx, fy+2, ft, FLOWER_MAX, 20);
        placeFlower(g, fx, fy-2, ft, FLOWER_MAX, 20);
      }
    }
  }

  else if (pattern === 'checkerboard') {
    // Alternating 20×20 zones — dense vs sparse
    const zoneSize = 20;
    for (let y = 2; y < rows - 2; y++) {
      for (let x = 2; x < cols - 2; x++) {
        const zx = Math.floor(x / zoneSize), zy = Math.floor(y / zoneSize);
        const isDense = (zx + zy) % 2 === 0;
        if (isDense) {
          // Dense zone — place every 3rd cell in a grid
          if (x % 3 === 0 && y % 3 === 0) {
            const d = dst(x, y, cx, cy);
            const ft = ringTypes[Math.floor(d / 40) % ringTypes.length];
            placeFlower(g, x, y, ft, FLOWER_MAX, 16);
          }
        } else {
          // Sparse zone — one flower at zone center
          if (x === Math.floor((zx + 0.5) * zoneSize) && y === Math.floor((zy + 0.5) * zoneSize)) {
            placeFlower(g, x, y, 'deepbloom', FLOWER_MAX, 12);
          }
        }
      }
    }
  }

  // Spiders — placed well away from hive center, not on flowers
  let sc = 0;
  while (sc < 12) {
    const sx = 4 + Math.floor(Math.random() * (cols - 8));
    const sy = 4 + Math.floor(Math.random() * (rows - 8));
    const cell = g[I(sx, sy)];
    if (cell.type === 'empty' && dst(sx, sy, cx, cy) > 40 && !onDiagonal(sx, sy)) {
      cell.type = 'spider'; sc++;
    }
  }

  return g;
}

// Lives based on distance from hive — close flowers are visited more so
// they get more lives to compensate. Far flowers are rarely hit so fewer
// lives still means they'll survive a long time naturally.
// tierMult allows difficulty scaling to shrink these values over time.
function flowerLivesByDist(d, tierMult = 1.0) {
  let base;
  if (d <= 15)      base = 18;   // inner ring — heavily trafficked
  else if (d <= 30) base = 12;   // mid range
  else if (d <= 50) base = 7;    // outer
  else              base = 4;    // far frontier — rarely reached, few lives fine
  return Math.max(1, Math.round(base * tierMult));
}

function makeGrid(tierMult = 1.0) {
  const cols = CFG.COLS, rows = CFG.ROWS;
  const g = Array.from({ length: cols * rows }, () => ({
    type: 'empty', pollen: 0, max: FLOWER_MAX, cd: 0,
    revealed: false, heat: 0, dead: false, lives: 999,
    eRevealed: false,
    visited: false, lastVisited: 0, visitCount: 0,
  }));
  g[I(HX, HY)].type = 'hive'; g[I(HX, HY)].revealed = true;

  // RED: Rivers
  for (let r = 0; r < CFG.RIVER_SEGS; r++) {
    const line = generateRiverLine(cols, rows);
    const cells = expandRiver(line, 1, cols, rows);
    for (const [rx, ry] of cells) {
      if (dst(rx, ry, HX, HY) > 12) g[I(rx, ry)].type = 'river';
    }
  }

  // RED: Bush clusters
  for (let b = 0; b < CFG.BUSH_CLUSTERS; b++) {
    const sx = 4 + Math.floor(Math.random() * (cols - 8));
    const sy = 4 + Math.floor(Math.random() * (rows - 8));
    if (dst(sx, sy, HX, HY) > 10) growBushCluster(g, sx, sy, 8 + Math.floor(Math.random() * 12), cols, rows);
  }

  // RED: Rock walls
  for (let rw = 0; rw < CFG.ROCK_WALLS; rw++) {
    const sx = 4 + Math.floor(Math.random() * (cols - 8));
    const sy = 4 + Math.floor(Math.random() * (rows - 8));
    if (dst(sx, sy, HX, HY) > 15) {
      const len = 4 + Math.floor(Math.random() * 8);
      const horiz = Math.random() < 0.5;
      for (let k = 0; k < len; k++) {
        const rx = sx + (horiz ? k : 0), ry = sy + (horiz ? 0 : k);
        if (inB(rx, ry)) g[I(rx, ry)].type = 'rock';
      }
    }
  }

  // RED: Mud patches
  for (let m = 0; m < CFG.MUD_PATCHES; m++) {
    const sx = 2 + Math.floor(Math.random() * (cols - 4));
    const sy = 2 + Math.floor(Math.random() * (rows - 4));
    if (dst(sx, sy, HX, HY) > 8 && g[I(sx, sy)].type === 'empty') {
      g[I(sx, sy)].type = 'mud'; g[I(sx, sy)].muddy = true;
    }
  }

  // Starter flower — always place near hive
  let ok = false;
  while (!ok) {
    const ddx = Math.floor(Math.random() * 14) - 7, ddy = Math.floor(Math.random() * 14) - 7;
    const d = Math.sqrt(ddx * ddx + ddy * ddy), fx = HX + ddx, fy = HY + ddy;
    if (d >= 4 && d <= 7 && inB(fx, fy) && g[I(fx, fy)].type === 'empty') {
      g[I(fx, fy)].type = 'flower'; g[I(fx, fy)].pollen = FLOWER_MAX;
      g[I(fx, fy)].flowerType = 'clover';
      g[I(fx, fy)].lives = flowerLivesByDist(d, tierMult); ok = true;
    }
  }

  // Inner ring — dense cluster within 20 cells of hive, scales with map size
  // Gives the colony something to work with immediately on large/epic maps
  const innerCount = CFG.INNER_FLOWERS || 12;
  let innerPlaced = 0, innerTries = 0;
  while (innerPlaced < innerCount && innerTries < 2000) {
    innerTries++;
    const angle = Math.random() * Math.PI * 2;
    const radius = 6 + Math.random() * 14; // 6–20 cells from hive
    const fx = Math.round(HX + Math.cos(angle) * radius);
    const fy = Math.round(HY + Math.sin(angle) * radius);
    if (!inB(fx, fy) || g[I(fx, fy)].type !== 'empty') continue;
    const d = dst(fx, fy, HX, HY);
    g[I(fx, fy)].type = 'flower';
    g[I(fx, fy)].flowerType = 'clover'; // inner ring is always clover — reliable, steady
    g[I(fx, fy)].pollen = Math.floor(FLOWER_MAX * (0.7 + Math.random() * 0.3));
    g[I(fx, fy)].lives = flowerLivesByDist(d, tierMult);
    innerPlaced++;
  }

  // FLOWERS — typed, diagonal bonus
  let fc = 1;
  const FLOWERS_INIT = CFG.FLOWERS_INIT;
  while (fc < FLOWERS_INIT) {
    const fx = 2 + Math.floor(Math.random() * (cols - 4)), fy = 2 + Math.floor(Math.random() * (rows - 4));
    if (g[I(fx, fy)].type === 'empty' && dst(fx, fy, HX, HY) > 8) {
      const d = dst(fx, fy, HX, HY);
      const ft = pickFlowerType(d);
      const diagBonus = onDiagonal(fx, fy) ? 1.1 : 1.0;
      g[I(fx, fy)].type = 'flower';
      g[I(fx, fy)].flowerType = ft;
      g[I(fx, fy)].pollen = Math.min(FLOWER_MAX, Math.round((Math.floor(Math.random() * FLOWER_MAX) + 3) * diagBonus));
      g[I(fx, fy)].lives = Math.round(flowerLivesByDist(d, tierMult) * (FLOWER_TYPES[ft]?.lives / 10 || 1));
      fc++;
    }
  }

  // SPIDERS
  const SPIDERS_INIT = CFG.SPIDERS_INIT;
  const SPIDER_MIN_DIST = CFG.SPIDER_MIN_DIST;
  let sc = 0;
  while (sc < SPIDERS_INIT) {
    const sx = 2 + Math.floor(Math.random() * (cols - 4)), sy = 2 + Math.floor(Math.random() * (rows - 4));
    if (g[I(sx, sy)].type === 'empty' && dst(sx, sy, HX, HY) > SPIDER_MIN_DIST && !onDiagonal(sx, sy)) {
      g[I(sx, sy)].type = 'spider'; sc++;
    }
  }
  return g;
}

// Add a new spider to the map (difficulty scaling)
function addSpider(grid, minDist) {
  let tries = 0;
  while (tries < 200) {
    const sx = 2 + Math.floor(Math.random() * (COLS - 4)), sy = 2 + Math.floor(Math.random() * (ROWS - 4));
    if (grid[I(sx, sy)].type === 'empty' && dst(sx, sy, HX, HY) > minDist && !onDiagonal(sx, sy)) {
      grid[I(sx, sy)].type = 'spider';
      return;
    }
    tries++;
  }
}

// ─────────────────────────────────────────────────────────
// COMBAT SYSTEM
// Flow: detect spider → ALARM → circle spider (radius 5) →
//   each completed lap broadcasts to hive alarm memory →
//   bees crossing within 3 cells learn alarm immediately →
//   3 bees circling same spider → 4 collective laps → spider dies →
//   all three return to whatever they were doing
// ─────────────────────────────────────────────────────────

const ALARM_DETECT_R = 8;   // range bee detects spider
const CIRCLE_R = 2;          // tight circle around spider
const LAPS_TO_KILL = 4;      // total collective laps needed (3 bees × ~1.3 each)
const GOSSIP_R = 3;          // range bees share alarm info when crossing paths

// Global alarm registry: spiderKey → { x, y, lapCount, beeIds }
const ALARMS = {};

function alarmKey(x, y) { return `${x},${y}`; }

function registerAlarm(sx, sy) {
  const k = alarmKey(sx, sy);
  if (!ALARMS[k]) ALARMS[k] = { x: sx, y: sy, lapCount: 0, beeIds: new Set() };
  return ALARMS[k];
}

function clearAlarm(sx, sy) {
  delete ALARMS[alarmKey(sx, sy)];
}

// Precompute circle waypoints around a spider at radius CIRCLE_R
// offset rotates the starting angle so multiple bees spread around the circle
function buildAlarmCircle(sx, sy, offset = 0) {
  const pts = [];
  const steps = 16;
  for (let i = 0; i < steps; i++) {
    const angle = ((i + offset) / steps) * Math.PI * 2;
    const cx = Math.round(sx + Math.cos(angle) * CIRCLE_R);
    const cy = Math.round(sy + Math.sin(angle) * CIRCLE_R);
    if (inB(cx, cy)) pts.push([cx, cy]);
  }
  return pts;
}

// Check if any bee detects an unalarmed spider nearby
function detectSpiders(bee, grid) {
  for (let dy = -ALARM_DETECT_R; dy <= ALARM_DETECT_R; dy++)
    for (let dx = -ALARM_DETECT_R; dx <= ALARM_DETECT_R; dx++) {
      const cx = bee.x + dx, cy = bee.y + dy;
      if (!inB(cx, cy)) continue;
      const c = grid[I(cx, cy)];
      if (c.type === 'spider' && c.revealed && Math.sqrt(dx*dx+dy*dy) <= ALARM_DETECT_R) {
        return { x: cx, y: cy };
      }
    }
  return null;
}

// Gossip: when two bees are close, share alarm knowledge
function gossipAlarms(allBees) {
  for (let i = 0; i < allBees.length; i++) {
    const a = allBees[i];
    if (!a.alarmTarget) continue;
    for (let j = 0; j < allBees.length; j++) {
      if (i === j) continue;
      const b = allBees[j];
      if (dst(a.x, a.y, b.x, b.y) <= GOSSIP_R && !b.alarmTarget && b.state !== 'alarm') {
        b.alarmTarget = { ...a.alarmTarget };
        b.state = 'alarm';
        const k = alarmKey(a.alarmTarget.x, a.alarmTarget.y);
        const offset = ALARMS[k] ? ALARMS[k].beeIds.size * 5 : 4; // stagger by ~90° each
        b.alarmCircle = buildAlarmCircle(a.alarmTarget.x, a.alarmTarget.y, offset);
        b.alarmCircleIdx = 0;
        b.alarmLaps = 0;
      }
    }
  }
}

// Per-bee alarm circle step — returns next position
function stepAlarmCircle(bee, grid, log) {
  if (!bee.alarmCircle || bee.alarmCircle.length === 0) return 'abandon';

  // Abandon if moves critically low
  const hx = bee.hx !== undefined ? bee.hx : HX;
  const hy = bee.hy !== undefined ? bee.hy : HY;
  const homeDistance = Math.ceil(dst(bee.x, bee.y, hx, hy));
  if (bee.moves !== undefined && bee.moves <= homeDistance + 5) return 'abandon';

  // Hard step limit — abandon after 200 steps regardless of lap completion
  // This catches bees stuck mid-lap or chasing a waypoint they can't reach
  bee.alarmSteps = (bee.alarmSteps || 0) + 1;
  if (bee.alarmSteps > 200) {
    log.push(`🐝 Alarm timeout — bee disengaging and resuming.`);
    return 'abandon';
  }

  const target = bee.alarmCircle[bee.alarmCircleIdx % bee.alarmCircle.length];
  const [tx, ty] = target;
  let [nx, ny] = stepToward(bee.x, bee.y, tx, ty);

  // Arrived at this waypoint
  if (bee.x === tx && bee.y === ty) {
    bee.alarmCircleIdx++;
    // Completed a full lap
    if (bee.alarmCircleIdx > 0 && bee.alarmCircleIdx % bee.alarmCircle.length === 0) {
      bee.alarmLaps = (bee.alarmLaps || 0) + 1;
      const k = alarmKey(bee.alarmTarget.x, bee.alarmTarget.y);
      if (ALARMS[k]) {
        ALARMS[k].lapCount++;
        ALARMS[k].beeIds.add(bee.id !== undefined ? bee.id : 'proto');
        MEM.dangers.add(`alarm:${bee.alarmTarget.x},${bee.alarmTarget.y}`);
        log.push(`🔔 Bee circling spider — lap ${bee.alarmLaps} (${ALARMS[k].beeIds.size} bees)`);

        // Kill condition: 3+ unique bees AND 4+ total laps
        if (ALARMS[k].beeIds.size >= 3 && ALARMS[k].lapCount >= LAPS_TO_KILL) {
          return 'kill';
        }

        // Abandon after 10 solo laps with fewer than 3 bees
        if (bee.alarmLaps >= 10 && ALARMS[k].beeIds.size < 3) {
          log.push(`🐝 No backup — bee abandoning spider after 10 laps.`);
          return 'abandon';
        }
      }
    }
  }

  if (!inB(nx, ny)) return 'abandon';
  return [nx, ny];
}

let pendingSpiderKills = 0;

// Execute spider kill
function executeSpiderKill(sx, sy, allBees, grid, log) {
  grid[I(sx, sy)].type = 'empty';
  grid[I(sx, sy)].revealed = true;
  clearSpiderFromMemory(sx, sy);
  clearAlarm(sx, sy);
  MEM.dangers.delete(`alarm:${sx},${sy}`);
  log.push(`⚔ Spider at (${sx},${sy}) cooked alive! Colony victory.`);
  pendingSpiderKills++;
  // Resume normal behavior for all alarm bees targeting this spider
  for (const bee of allBees) {
    if (bee.alarmTarget && bee.alarmTarget.x === sx && bee.alarmTarget.y === sy) {
      bee.state = null;
      bee.alarmTarget = null;
      bee.alarmCircle = null;
      bee.alarmCircleIdx = 0;
      bee.alarmLaps = 0;
      bee.returning = true; // brief return home then resume
    }
  }
}

// ─────────────────────────────────────────────────────────
// SINGLE-BEE SPIDER CONTACT DEATH (accidental touch)
// ─────────────────────────────────────────────────────────
function spiderKillCheck(bee, grid, log, isProto) {
  for (let dy = -KILL_R; dy <= KILL_R; dy++) for (let dx = -KILL_R; dx <= KILL_R; dx++) {
    const cx = bee.x + dx, cy = bee.y + dy;
    if (!inB(cx, cy)) continue;
    if (grid[I(cx, cy)].type === 'spider') {
      // If bee is in alarm state circling this spider, don't die — that's intentional
      if (bee.alarmTarget && bee.alarmTarget.x === cx && bee.alarmTarget.y === cy) return false;
      grid[I(cx, cy)].revealed = true;
      memLearn(grid);
      if (isProto) {
        const whx = bee.hx !== undefined ? bee.hx : HX;
        const why = bee.hy !== undefined ? bee.hy : HY;
        bee.x = whx; bee.y = why;
        bee.pollen = 0; bee.moves = CFG.BEE_MOVES; bee.returning = false;
        bee.trail = []; // clear trail so no laser line
        log.push('Protagonist hit spider — warped home!');
      }
      return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────
// CIRCLE BEHAVIOR
// When a bee has gone straight for STRAIGHT_TRIGGER steps,
// it executes one lap of a small circle (radius ~3) then resumes.
// ─────────────────────────────────────────────────────────
const STRAIGHT_TRIGGER = 14;  // steps before circling
const CIRCLE_STEPS = 10;      // steps in the circle arc

// Precomputed unit circle offsets (10-step arc, 36° each)
const CIRCLE_ARC = Array.from({ length: CIRCLE_STEPS }, (_, i) => {
  const angle = (i / CIRCLE_STEPS) * Math.PI * 2;
  return { dx: Math.round(Math.cos(angle) * 3), dy: Math.round(Math.sin(angle) * 3) };
});

function applyCircleOrMomentum(bee, proposedNx, proposedNy, proposedDx, proposedDy) {
  // If currently circling, follow the arc
  if (bee.circling) {
    const arc = CIRCLE_ARC[bee.circleStep % CIRCLE_STEPS];
    const nx = bee.circleCX + arc.dx;
    const ny = bee.circleCY + arc.dy;
    bee.circleStep++;
    if (bee.circleStep >= CIRCLE_STEPS) {
      bee.circling = false;
      bee.straightSteps = 0;
    }
    if (inB(nx, ny)) return [nx, ny];
    // If circle goes OOB just end it
    bee.circling = false; bee.straightSteps = 0;
    return [proposedNx, proposedNy];
  }

  // Track straight steps
  if (proposedDx === bee.lastDx && proposedDy === bee.lastDy && (proposedDx !== 0 || proposedDy !== 0)) {
    bee.straightSteps++;
  } else {
    bee.straightSteps = 0;
    bee.lastDx = proposedDx;
    bee.lastDy = proposedDy;
  }

  // Trigger circle
  if (bee.straightSteps >= STRAIGHT_TRIGGER) {
    bee.circling = true;
    bee.circleStep = 0;
    bee.circleCX = proposedNx;
    bee.circleCY = proposedNy;
    bee.straightSteps = 0;
    const arc = CIRCLE_ARC[0];
    const nx = bee.circleCX + arc.dx;
    const ny = bee.circleCY + arc.dy;
    bee.circleStep = 1;
    if (inB(nx, ny)) return [nx, ny];
  }

  return [proposedNx, proposedNy];
}

// ─────────────────────────────────────────────────────────
// PROTAGONIST
// ─────────────────────────────────────────────────────────
function makeProto() {
  return {
    x: HX, y: HY, moves: CFG.BEE_MOVES, pollen: 0,
    returning: false, phase: 'spiral', spiralIdx: 0,
    ldx: 1, ldy: 0, trail: [],
    straightSteps: 0, lastDx: 0, lastDy: 0,
    circling: false, circleStep: 0, circleCX: 0, circleCY: 0,
    state: null, alarmTarget: null, alarmCircle: null, alarmCircleIdx: 0, alarmLaps: 0,
    r: 255, g: 220, b: 0, // gold — used for mosaic paint
  };
}

function stepProto(bee, grid, hive, log, turn) {
  const myHX = bee.hx !== undefined ? bee.hx : HX;
  const myHY = bee.hy !== undefined ? bee.hy : HY;

  if (bee.x === myHX && bee.y === myHY && bee.returning) {
    if (bee.pollen > 0) { hive.pollen += bee.pollen; log.push(`Deposited ${bee.pollen}p → Hive: ${hive.pollen}`); bee.pollen = 0; }
    bee.moves = CFG.BEE_MOVES; bee.returning = false; memLearn(grid);
    // Clear alarm state if returned after kill/abandon
    if (bee.state === 'alarm' && !bee.alarmTarget) bee.state = null;
    if (MEM.flowers.some(f => f.pollen > 0 && !isDanger(f.x, f.y))) bee.phase = 'linear';
    return;
  }

  // ── Alarm: circling spider ──
  if (bee.state === 'alarm' && bee.alarmTarget) {
    // Check spider still exists
    const sc = grid[I(bee.alarmTarget.x, bee.alarmTarget.y)];
    if (!sc || sc.type !== 'spider') {
      bee.state = null; bee.alarmTarget = null; bee.alarmCircle = null;
    } else {
      const result = stepAlarmCircle(bee, grid, log);
      if (result === 'kill') {
        executeSpiderKill(bee.alarmTarget.x, bee.alarmTarget.y, [bee], grid, log);
      } else if (result === 'abandon') {
        // Give up — clear alarm state and return home to refuel then resume
        bee.state = null; bee.alarmTarget = null; bee.alarmCircle = null;
        bee.alarmCircleIdx = 0; bee.alarmLaps = 0; bee.alarmSteps = 0;
        bee.returning = true;
      } else if (result) {
        bee.x = result[0]; bee.y = result[1]; bee.moves--;
        grid[I(bee.x, bee.y)].heat = Math.min(HEAT_MAX, grid[I(bee.x, bee.y)].heat + (isMosaicMode ? 8 : 3));
        reveal(grid, bee.x, bee.y, REVEAL_PROTO, turn, bee.isEnemy === true);
        bee.trail = [{ x: bee.x, y: bee.y }, ...bee.trail].slice(0, CFG.TRAIL_LEN || 150);
      }
      return;
    }
  }

  // ── Detect spiders in range → enter alarm ──
  if (!bee.returning && bee.state !== 'alarm') {
    const spider = detectSpiders(bee, grid);
    if (spider) {
      bee.state = 'alarm';
      bee.alarmTarget = spider;
      registerAlarm(spider.x, spider.y);
      const k = alarmKey(spider.x, spider.y);
      const offset = ALARMS[k] ? ALARMS[k].beeIds.size * 5 : 0;
      bee.alarmCircle = buildAlarmCircle(spider.x, spider.y, offset);
      bee.alarmCircleIdx = 0;
      bee.alarmLaps = 0;
      log.push(`🚨 Protagonist detected spider at (${spider.x},${spider.y}) — circling!`);
      return;
    }
  }

  // ── BvB combat state overrides normal movement ──
  if (bee.bvbState) {
    const allBees = []; // BvB resolution already set bvbState; just execute movement
    const mv = bvbMove(bee, allBees, myHX, myHY);
    if (mv && inB(mv[0], mv[1])) {
      bee.x = mv[0]; bee.y = mv[1]; bee.moves--;
      grid[I(bee.x, bee.y)].heat = Math.min(HEAT_MAX, grid[I(bee.x, bee.y)].heat + (isMosaicMode ? 6 : 2));
      reveal(grid, bee.x, bee.y, REVEAL_PROTO, turn, bee.isEnemy === true);
      bee.trail = [{ x: bee.x, y: bee.y }, ...bee.trail].slice(0, CFG.TRAIL_LEN || 150);
    }
    return;
  }

  const hd = Math.ceil(dst(bee.x, bee.y, myHX, myHY));
  if (bee.pollen >= POLLEN_CAP || bee.moves <= hd + 4) bee.returning = true;

  // Force warp home after 40 ticks of trying to return — overrides all terrain
  if (bee.returning) {
    bee._returnTicks = (bee._returnTicks || 0) + 1;
    if (bee._returnTicks >= 40) {
      bee._returnTicks = 0; bee._stuckTicks = 0;
      if (bee.pollen > 0) { hive.pollen += bee.pollen; bee.pollen = 0; }
      bee.x = myHX; bee.y = myHY;
      bee.moves = CFG.BEE_MOVES; bee.returning = false;
      bee.trail = [];
      log.push('🐝 Bee warped home after river trap.');
      return;
    }
  } else {
    bee._returnTicks = 0;
  }

  let nx, ny;

  // Fibonacci clockwise override — only when actively exploring, not when returning
  if (isFibonacciMode && !bee.returning) {
    [nx, ny] = stepClockwise(bee.x, bee.y, myHX, myHY, grid, bee);
  } else if (bee.returning) {
    // Stranded check — if very low moves and home is far, find nearest flower to refuel at
    const strandedThresh = 15;
    if (bee.moves <= strandedThresh && Math.ceil(dst(bee.x, bee.y, myHX, myHY)) > bee.moves) {
      // Can't make it home — find nearest passable flower
      let best = null, bestD = Infinity;
      for (const f of MEM.flowers) {
        if (f.pollen <= 0 || isDanger(f.x, f.y)) continue;
        const d = dst(bee.x, bee.y, f.x, f.y);
        if (d < bestD && isPassable(grid[I(f.x, f.y)])) { bestD = d; best = f; }
      }
      if (best && bestD <= bee.moves) {
        [nx, ny] = stepTowardPassable(bee.x, bee.y, best.x, best.y, grid, bee);
      } else {
        [nx, ny] = stepTowardPassable(bee.x, bee.y, myHX, myHY, grid, bee);
      }
    } else {
      [nx, ny] = stepTowardPassable(bee.x, bee.y, myHX, myHY, grid, bee);
    }
  } else if (bee.phase === 'spiral') {
    // Use precomputed center spiral or build one for off-center hives, cached on bee
    if (!bee._spiral) {
      bee._spiral = (myHX === HX && myHY === HY) ? getSpiral() : buildLocalSpiral(myHX, myHY);
    }
    const spiralPts = bee._spiral;
    let found = false;
    while (bee.spiralIdx < spiralPts.length) {
      const [wx, wy] = spiralPts[bee.spiralIdx];
      if (bee.x === wx && bee.y === wy) { bee.spiralIdx++; continue; }
      if (isDanger(wx, wy)) { bee.spiralIdx++; continue; }
      [nx, ny] = stepToward(bee.x, bee.y, wx, wy); found = true; break;
    }
    if (!found) { bee.returning = true; [nx, ny] = stepToward(bee.x, bee.y, myHX, myHY); }
  } else {
    // linear/forage
    let best = null, bestD = Infinity;
    for (const f of MEM.flowers) {
      if (isDanger(f.x, f.y) || f.pollen <= 0) continue;
      const d = dst(bee.x, bee.y, f.x, f.y);
      if (d < bestD) { bestD = d; best = f; }
    }
    if (best) [nx, ny] = stepToward(bee.x, bee.y, best.x, best.y);
    else { bee.phase = 'spiral'; [nx, ny] = stepToward(bee.x, bee.y, myHX, myHY); }
  }

  if (nx === undefined || !inB(nx, ny)) return;
  if (isDanger(nx, ny)) { bee.returning = true; [nx, ny] = stepToward(bee.x, bee.y, myHX, myHY); }

  // Apply circle/momentum — only during scouting/foraging, not when returning
  if (!bee.returning) {
    const ddx = nx - bee.x, ddy = ny - bee.y;
    [nx, ny] = applyCircleOrMomentum(bee, nx, ny, ddx, ddy);
    if (!inB(nx, ny)) { nx = bee.x; ny = bee.y; }
    if (isDanger(nx, ny)) { bee.returning = true; [nx, ny] = stepToward(bee.x, bee.y, myHX, myHY); }
  } else {
    bee.circling = false; bee.straightSteps = 0;
  }

  bee.lastPos = { x: bee.x, y: bee.y };

  // Stuck detector — if not making progress toward home, force random escape
  if (bee.returning) {
    const distNow = dst(nx, ny, myHX, myHY);
    const distBefore = dst(bee.x, bee.y, myHX, myHY);
    if (distNow >= distBefore) {
      bee._stuckTicks = (bee._stuckTicks || 0) + 1;
    } else {
      bee._stuckTicks = 0;
    }
    if (bee._stuckTicks >= 10) {
      // Force a random non-back, non-river step to break the pattern
      bee._stuckTicks = 0;
      const escapes = [
        [bee.x+1,bee.y],[bee.x-1,bee.y],[bee.x,bee.y+1],[bee.x,bee.y-1],
        [bee.x+1,bee.y+1],[bee.x-1,bee.y-1],[bee.x+1,bee.y-1],[bee.x-1,bee.y+1],
      ].filter(([ex,ey]) =>
        inB(ex,ey) && isPassable(grid[I(ex,ey)]) &&
        !(ex === bee.lastPos?.x && ey === bee.lastPos?.y)
      );
      if (escapes.length > 0) {
        const pick = escapes[Math.floor(Math.random() * escapes.length)];
        bee.x = pick[0]; bee.y = pick[1];
        bee.moves -= terrainMoveCost(grid[I(pick[0], pick[1])]);
        reveal(grid, pick[0], pick[1], terrainRevealRadius(bee, grid, REVEAL_PROTO), turn, bee.isEnemy === true);
        bee.trail = [{ x: pick[0], y: pick[1] }, ...bee.trail].slice(0, CFG.TRAIL_LEN || 150);
        return;
      }
    }
  }

  bee.x = nx; bee.y = ny;
  bee.moves -= terrainMoveCost(grid[I(nx, ny)]);
  if (!bee.isEnemy) {
    grid[I(nx, ny)].heat = Math.min(HEAT_MAX, grid[I(nx, ny)].heat + (isMosaicMode ? 8 : 3));
    if (isMosaicMode && bee.r !== undefined) {
      const cell = grid[I(nx, ny)];
      if (isTronMode) {
        cell.paint = { r: bee.r, g: bee.g, b: bee.b };
      } else if (!cell.paint) {
        cell.paint = { r: bee.r, g: bee.g, b: bee.b };
      } else {
        cell.paint.r = Math.round(cell.paint.r * 0.6 + bee.r * 0.4);
        cell.paint.g = Math.round(cell.paint.g * 0.6 + bee.g * 0.4);
        cell.paint.b = Math.round(cell.paint.b * 0.6 + bee.b * 0.4);
      }
    }
  }
  reveal(grid, nx, ny, terrainRevealRadius(bee, grid, REVEAL_PROTO), turn, bee.isEnemy === true);
  bee.trail = isMosaicMode ? [] : [{ x: nx, y: ny }, ...bee.trail].slice(0, CFG.TRAIL_LEN || 150);

  if (spiderKillCheck(bee, grid, log, true)) return;

  const c = grid[I(bee.x, bee.y)];
  if (c.type === 'flower' && c.pollen > 0 && !c.dead && bee.pollen < POLLEN_CAP) {
    const take = Math.min(c.pollen, POLLEN_CAP - bee.pollen);
    c.pollen -= take; bee.pollen += take;
    if (c.pollen === 0) {
      c.lives = Math.max(0, c.lives - 1);
      if (c.lives <= 0) {
        // Permanent death
        c.dead = true; c.type = 'dead_flower';
        log.push(`Flower at (${bee.x},${bee.y}) exhausted permanently.`);
      } else {
        c.cd = FLOWER_CD;
      }
    }
    if (bee.pollen >= POLLEN_CAP) bee.returning = true;
  }
}

// ─────────────────────────────────────────────────────────
// NPC
// ─────────────────────────────────────────────────────────
const CLAIMS = {};

function claimFlower(npc, fx, fy) {
  if (npc.tx !== null) { const old = `${npc.tx},${npc.ty}`; if (CLAIMS[old] === npc.id) delete CLAIMS[old]; }
  CLAIMS[`${fx},${fy}`] = npc.id; npc.tx = fx; npc.ty = fy; npc.mode = 'harvest';
}
function releaseClaim(npc) {
  if (npc.tx === null) return;
  const key = `${npc.tx},${npc.ty}`; if (CLAIMS[key] === npc.id) delete CLAIMS[key];
  npc.tx = null; npc.ty = null;
}
function isClaimed(fx, fy, byId) { const k = `${fx},${fy}`; return CLAIMS[k] !== undefined && CLAIMS[k] !== byId; }

// Each NPC gets a unique hue spread evenly across the full color wheel.
// id 0 = red, id 1 = orange-red, ... id 19 = magenta, cycling if >20.
// Returns { r, g, b } as 0-255 integers.
function npcColor(id) {
  const hue = (id * 137.508) % 360; // golden angle — maximally distinct neighbors
  // HSL to RGB
  const h = hue / 360, s = 0.85, l = 0.55;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  return {
    r: Math.round(hue2rgb(h + 1/3) * 255),
    g: Math.round(hue2rgb(h) * 255),
    b: Math.round(hue2rgb(h - 1/3) * 255),
  };
}

function makeNPC(id) {
  const angle = Math.random() * Math.PI * 2;
  const { r, g, b } = npcColor(id);
  // In Fibonacci mode, assign a unique starting angle offset so bees
  // fan out across different spiral arms immediately from the hive
  const fibAngleOffset = isFibonacciMode ? (id * (Math.PI * 2 / 8)) : 0;
  return {
    id, x: HX, y: HY, pollen: 0, moves: CFG.BEE_MOVES,
    returning: false, alive: true,
    tx: null, ty: null, mode: 'discover',
    personality: Math.random() < 0.5 ? 'spiral' : 'linear',
    ldx: Math.round(Math.cos(angle + fibAngleOffset)) || 1,
    ldy: Math.round(Math.sin(angle + fibAngleOffset)) || 0,
    spiralIdx: Math.floor(Math.random() * 80),
    straightSteps: 0, lastDx: 0, lastDy: 0,
    circling: false, circleStep: 0, circleCX: 0, circleCY: 0,
    trail: [],
    r, g, b,
    state: null, alarmTarget: null, alarmCircle: null, alarmCircleIdx: 0, alarmLaps: 0,
    _fibAngle: angle + fibAngleOffset, // remember initial angle for clockwise stepping
  };
}

function stepNPC(npc, grid, hive, log, turn, defenseZone = null, advanceZone = null) {
  if (!npc.alive) return;

  // ── Alarm: circling spider ──
  if (npc.state === 'alarm' && npc.alarmTarget) {
    const sc = grid[I(npc.alarmTarget.x, npc.alarmTarget.y)];
    if (!sc || sc.type !== 'spider') {
      npc.state = null; npc.alarmTarget = null; npc.alarmCircle = null;
    } else {
      const result = stepAlarmCircle(npc, grid, log);
      if (result === 'kill') {
        executeSpiderKill(npc.alarmTarget.x, npc.alarmTarget.y, [npc], grid, log);
      } else if (result === 'abandon') {
        npc.state = null; npc.alarmTarget = null; npc.alarmCircle = null;
        npc.alarmCircleIdx = 0; npc.alarmLaps = 0; npc.alarmSteps = 0;
        npc.returning = true;
      } else if (result) {
        npc.x = result[0]; npc.y = result[1]; npc.moves--;
        grid[I(npc.x, npc.y)].heat = Math.min(HEAT_MAX, grid[I(npc.x, npc.y)].heat + (isMosaicMode ? 6 : 2));
        reveal(grid, npc.x, npc.y, REVEAL_NPC, turn, npc.isEnemy === true);
        npc.trail = [{ x: npc.x, y: npc.y }, ...(npc.trail || [])].slice(0, CFG.TRAIL_LEN || 150);
      }
      return;
    }
  }

  // ── Detect spiders → enter alarm ──
  if (!npc.returning && npc.state !== 'alarm') {
    const spider = detectSpiders(npc, grid);
    if (spider) {
      npc.state = 'alarm';
      npc.alarmTarget = spider;
      registerAlarm(spider.x, spider.y);
      const k = alarmKey(spider.x, spider.y);
      const offset = ALARMS[k] ? ALARMS[k].beeIds.size * 5 : 0;
      npc.alarmCircle = buildAlarmCircle(spider.x, spider.y, offset);
      npc.alarmCircleIdx = 0;
      npc.alarmLaps = 0;
      registerAlarm(spider.x, spider.y);
      log.push(`🚨 Bee #${npc.id} detected spider — circling!`);
      return;
    }
  }

  // Use hive coords from npc if BvB, otherwise default
  const myHX = npc.hx !== undefined ? npc.hx : HX;
  const myHY = npc.hy !== undefined ? npc.hy : HY;

  if (npc.x === myHX && npc.y === myHY) {
    if (npc.pollen > 0) { hive.pollen += npc.pollen; npc.pollen = 0; }
    npc.moves = CFG.BEE_MOVES; npc.returning = false; releaseClaim(npc);
    let best = null, bestD = Infinity;
    for (const f of MEM.flowers) {
      if (isDanger(f.x, f.y) || f.pollen <= 0 || isClaimed(f.x, f.y, npc.id)) continue;
      const d = dst(myHX, myHY, f.x, f.y); if (d < bestD) { bestD = d; best = f; }
    }
    if (best) claimFlower(npc, best.x, best.y);
    else { npc.tx = null; npc.ty = null; npc.mode = 'discover'; }
  }

  const hd = Math.ceil(dst(npc.x, npc.y, myHX, myHY));
  if (npc.pollen >= POLLEN_CAP || npc.moves <= hd + 3) npc.returning = true;
  if (npc.tx !== null && isDanger(npc.tx, npc.ty)) { releaseClaim(npc); npc.returning = true; }

  // Force warp home after 40 ticks of trying to return — overrides all terrain
  if (npc.returning) {
    npc._returnTicks = (npc._returnTicks || 0) + 1;
    if (npc._returnTicks >= 40) {
      npc._returnTicks = 0; npc._stuckTicks = 0;
      if (npc.pollen > 0) { hive.pollen += npc.pollen; npc.pollen = 0; }
      npc.x = myHX; npc.y = myHY;
      npc.moves = CFG.BEE_MOVES; npc.returning = false;
      releaseClaim(npc);
      npc.trail = [];
      return;
    }
  } else {
    npc._returnTicks = 0;
  }

  // ── BLUE: Tactician role override — fires before zone/default movement ──
  if (!npc.returning && npc.role && npc._tacPlayerBees && npc._tacEnemyBees) {
    const tacMv = tacticianMove(
      npc, grid, npc._tacPlayerBees, npc._tacEnemyBees,
      myHX, myHY, npc._stance || STANCE.BALANCED
    );
    if (tacMv && inB(tacMv[0], tacMv[1])) {
      const [tnx, tny] = tacMv;
      npc.x = tnx; npc.y = tny;
      npc.moves -= terrainMoveCost(grid[I(tnx, tny)]);
      if (!npc.isEnemy) grid[I(tnx, tny)].heat = Math.min(HEAT_MAX, grid[I(tnx, tny)].heat + (isMosaicMode ? 6 : 2));
      reveal(grid, tnx, tny, terrainRevealRadius(npc, grid, REVEAL_NPC), turn, npc.isEnemy === true);
      npc.trail = [{ x: tnx, y: tny }, ...(npc.trail || [])].slice(0, CFG.TRAIL_LEN || 150);
      return;
    }
  }

  let nx, ny;

  // Fibonacci clockwise override — only when exploring, not when returning home
  if (isFibonacciMode && !npc.returning) {
    [nx, ny] = stepClockwise(npc.x, npc.y, myHX, myHY, grid, npc);
  } else if (npc.returning) {
    const strandedThresh = 12;
    if (npc.moves <= strandedThresh && Math.ceil(dst(npc.x, npc.y, myHX, myHY)) > npc.moves) {
      let best = null, bestD = Infinity;
      for (const f of MEM.flowers) {
        if (f.pollen <= 0 || isDanger(f.x, f.y)) continue;
        const d = dst(npc.x, npc.y, f.x, f.y);
        if (d < bestD && isPassable(grid[I(f.x, f.y)])) { bestD = d; best = f; }
      }
      if (best && bestD <= npc.moves) {
        [nx, ny] = stepTowardPassable(npc.x, npc.y, best.x, best.y, grid, npc);
      } else {
        [nx, ny] = stepTowardPassable(npc.x, npc.y, myHX, myHY, grid, npc);
      }
    } else {
      [nx, ny] = stepTowardPassable(npc.x, npc.y, myHX, myHY, grid, npc);
    }

  // ── PATROL: visit unoccupied defense waypoints when nearby ──
  } else if (npc.zoneRole === 'patrol' && defenseZone && defenseZone.length > 0) {
    // Find the nearest unoccupied waypoint
    const allPlayerBees = []; // passed via closure not available here — use grid heat as proxy
    // Pick nearest waypoint that isn't already the npc's current target
    let bestWP = null, bestWPd = Infinity;
    for (const wp of defenseZone) {
      const d = dst(npc.x, npc.y, wp.x, wp.y);
      if (d < bestWPd) { bestWPd = d; bestWP = wp; }
    }
    if (bestWP && bestWPd > 1) {
      [nx, ny] = stepToward(npc.x, npc.y, bestWP.x, bestWP.y);
      // Advance to next waypoint index once arrived
      if (!npc.patrolIdx) npc.patrolIdx = 0;
      const currentWP = defenseZone[npc.patrolIdx % defenseZone.length];
      if (npc.x === currentWP.x && npc.y === currentWP.y) npc.patrolIdx++;
      const nextWP = defenseZone[npc.patrolIdx % defenseZone.length];
      [nx, ny] = stepToward(npc.x, npc.y, nextWP.x, nextWP.y);
    } else {
      // At waypoint — hold briefly then cycle
      [nx, ny] = [npc.x, npc.y];
      if (!npc.holdTimer) npc.holdTimer = 0;
      npc.holdTimer++;
      if (npc.holdTimer > 8) { npc.holdTimer = 0; if (!npc.patrolIdx) npc.patrolIdx = 0; npc.patrolIdx++; }
    }
    // Still forage while patrolling if carrying nothing and a flower is very close
    if (npc.pollen === 0) {
      const closeFlower = MEM.flowers.find(f =>
        f.pollen > 0 && !isDanger(f.x, f.y) && !isClaimed(f.x, f.y, npc.id) &&
        dst(npc.x, npc.y, f.x, f.y) <= 8 && nearWaypoint(f.x, f.y, defenseZone, 10)
      );
      if (closeFlower) claimFlower(npc, closeFlower.x, closeFlower.y);
    }

  // ── ADVANCE: follow breadcrumbs in placement order ──
  } else if (npc.zoneRole === 'advance' && advanceZone && advanceZone.length > 0) {
    // Each waypoint is a breadcrumb in the order it was placed.
    // Bee walks them sequentially, arrives → advances index, loops at end.
    // Harvesting is secondary — only grabs flowers directly on the path (within 2 cells).
    if (!npc.patrolIdx) npc.patrolIdx = 0;
    const crumb = advanceZone[npc.patrolIdx % advanceZone.length];
    const dToCrumb = dst(npc.x, npc.y, crumb.x, crumb.y);

    if (dToCrumb <= 1) {
      // Arrived at this crumb — advance to next
      npc.patrolIdx = (npc.patrolIdx + 1) % advanceZone.length;
    }

    const nextCrumb = advanceZone[npc.patrolIdx % advanceZone.length];
    [nx, ny] = stepToward(npc.x, npc.y, nextCrumb.x, nextCrumb.y);

    // Opportunistically grab a flower that is almost exactly on the path
    // (within 2 cells of the line between current pos and next crumb)
    if (npc.pollen < POLLEN_CAP && npc.mode !== 'harvest') {
      const pathFlower = MEM.flowers.find(f =>
        f.pollen > 0 && !isDanger(f.x, f.y) && !isClaimed(f.x, f.y, npc.id) &&
        dst(npc.x, npc.y, f.x, f.y) <= 3
      );
      if (pathFlower) claimFlower(npc, pathFlower.x, pathFlower.y);
    }
    if (npc.mode === 'harvest' && npc.tx !== null) {
      [nx, ny] = stepTowardPassable(npc.x, npc.y, npc.tx, npc.ty, grid, npc);
    }

  } else if (npc.mode === 'harvest' && npc.tx !== null) {
    [nx, ny] = stepTowardPassable(npc.x, npc.y, npc.tx, npc.ty, grid, npc);
  } else if (npc.personality === 'spiral') {
    // Skip high-heat spiral waypoints when no flowers known — seek fresh territory
    let found = false;
    while (npc.spiralIdx < SPIRAL.length) {
      const [wx, wy] = SPIRAL[npc.spiralIdx];
      if (npc.x === wx && npc.y === wy) { npc.spiralIdx++; continue; }
      if (isDanger(wx, wy)) { npc.spiralIdx++; continue; }
      const waypointHeat = grid[I(wx, wy)]?.heat || 0;
      // Skip high-heat waypoints if no flowers known — look for unvisited territory
      if (waypointHeat > 60 && MEM.flowers.filter(f => f.pollen > 0).length === 0) {
        npc.spiralIdx++; continue;
      }
      [nx, ny] = stepToward(npc.x, npc.y, wx, wy); found = true; break;
    }
    if (!found) { nx = npc.x + npc.ldx; ny = npc.y + npc.ldy; }
  } else {
    const noFlowersKnown = MEM.flowers.filter(f => f.pollen > 0).length === 0;
    const neighbors = [
      { x: npc.x + 1, y: npc.y }, { x: npc.x - 1, y: npc.y },
      { x: npc.x, y: npc.y + 1 }, { x: npc.x, y: npc.y - 1 },
      { x: npc.x + 1, y: npc.y + 1 }, { x: npc.x - 1, y: npc.y - 1 },
      { x: npc.x + 1, y: npc.y - 1 }, { x: npc.x - 1, y: npc.y + 1 },
    ].filter(d => inB(d.x, d.y) && !isDanger(d.x, d.y));

    if (noFlowersKnown && advanceZone && advanceZone.length > 0) {
      // Priority 1: head toward nearest advance waypoint
      const nearest = advanceZone.reduce((a, b) =>
        dst(npc.x, npc.y, a.x, a.y) < dst(npc.x, npc.y, b.x, b.y) ? a : b
      );
      [nx, ny] = stepToward(npc.x, npc.y, nearest.x, nearest.y);
    } else if (noFlowersKnown && neighbors.length > 0) {
      // Priority 2: pick coolest neighbor (avoid retracing)
      neighbors.sort((a, b) => (grid[I(a.x, a.y)]?.heat || 0) - (grid[I(b.x, b.y)]?.heat || 0));
      const pool = neighbors.slice(0, Math.max(1, Math.ceil(neighbors.length / 3)));
      const pick = pool[Math.floor(Math.random() * pool.length)];
      nx = pick.x; ny = pick.y;
      npc.ldx = nx - npc.x; npc.ldy = ny - npc.y;
    } else {
      // Priority 3: linear walk, bounce off walls
      nx = npc.x + npc.ldx; ny = npc.y + npc.ldy;
      if (!inB(nx, ny) || isDanger(nx, ny)) {
        const angle = Math.random() * Math.PI * 2;
        npc.ldx = Math.round(Math.cos(angle)) || 1; npc.ldy = Math.round(Math.sin(angle)) || 0;
        nx = npc.x + npc.ldx; ny = npc.y + npc.ldy;
      }
    }
  }

  if (nx === npc.x && ny === npc.y) {
    const angle = Math.random() * Math.PI * 2;
    npc.ldx = Math.round(Math.cos(angle)) || 1; npc.ldy = Math.round(Math.sin(angle)) || 0;
    nx = npc.x + npc.ldx; ny = npc.y + npc.ldy;
    if (!inB(nx, ny)) { nx = npc.x; ny = npc.y; }
  }

  if (!inB(nx, ny) || isDanger(nx, ny)) { npc.returning = true; [nx, ny] = stepToward(npc.x, npc.y, HX, HY); }

  // Apply circle/momentum during discovery only
  if (!npc.returning && npc.mode === 'discover') {
    const ddx = nx - npc.x, ddy = ny - npc.y;
    [nx, ny] = applyCircleOrMomentum(npc, nx, ny, ddx, ddy);
    if (!inB(nx, ny)) { nx = npc.x; ny = npc.y; }
    if (isDanger(nx, ny)) { npc.returning = true; [nx, ny] = stepToward(npc.x, npc.y, HX, HY); }
  } else {
    npc.circling = false; npc.straightSteps = 0;
  }

  npc.lastPos = { x: npc.x, y: npc.y };

  // Stuck detector
  if (npc.returning) {
    const distNow = dst(nx, ny, myHX, myHY);
    const distBefore = dst(npc.x, npc.y, myHX, myHY);
    if (distNow >= distBefore) {
      npc._stuckTicks = (npc._stuckTicks || 0) + 1;
    } else {
      npc._stuckTicks = 0;
    }
    if (npc._stuckTicks >= 10) {
      npc._stuckTicks = 0;
      const escapes = [
        [npc.x+1,npc.y],[npc.x-1,npc.y],[npc.x,npc.y+1],[npc.x,npc.y-1],
        [npc.x+1,npc.y+1],[npc.x-1,npc.y-1],[npc.x+1,npc.y-1],[npc.x-1,npc.y+1],
      ].filter(([ex,ey]) =>
        inB(ex,ey) && isPassable(grid[I(ex,ey)]) &&
        !(ex === npc.lastPos?.x && ey === npc.lastPos?.y)
      );
      if (escapes.length > 0) {
        const pick = escapes[Math.floor(Math.random() * escapes.length)];
        npc.x = pick[0]; npc.y = pick[1];
        npc.moves -= terrainMoveCost(grid[I(pick[0], pick[1])]);
        if (!npc.isEnemy) grid[I(pick[0], pick[1])].heat = Math.min(HEAT_MAX, grid[I(pick[0], pick[1])].heat + (isMosaicMode ? 6 : 2));
        reveal(grid, pick[0], pick[1], terrainRevealRadius(npc, grid, REVEAL_NPC), turn, npc.isEnemy === true);
        npc.trail = [{ x: pick[0], y: pick[1] }, ...(npc.trail || [])].slice(0, CFG.TRAIL_LEN || 150);
        return;
      }
    }
  }

  npc.x = nx; npc.y = ny;
  npc.moves -= terrainMoveCost(grid[I(nx, ny)]);
  npc.trail = isMosaicMode ? [] : [{ x: nx, y: ny }, ...(npc.trail || [])].slice(0, CFG.TRAIL_LEN || 150);
  if (!npc.isEnemy) {
    grid[I(nx, ny)].heat = Math.min(HEAT_MAX, grid[I(nx, ny)].heat + (isMosaicMode ? 6 : 2));
    if (isMosaicMode && npc.r !== undefined) {
      const cell = grid[I(nx, ny)];
      if (isTronMode) {
        cell.paint = { r: npc.r, g: npc.g, b: npc.b };
      } else if (!cell.paint) {
        cell.paint = { r: npc.r, g: npc.g, b: npc.b };
      } else {
        cell.paint.r = Math.round(cell.paint.r * 0.6 + npc.r * 0.4);
        cell.paint.g = Math.round(cell.paint.g * 0.6 + npc.g * 0.4);
        cell.paint.b = Math.round(cell.paint.b * 0.6 + npc.b * 0.4);
      }
    }
  }
  reveal(grid, nx, ny, terrainRevealRadius(npc, grid, REVEAL_NPC), turn, npc.isEnemy === true);

  if (spiderKillCheck(npc, grid, log, false)) { releaseClaim(npc); npc.alive = false; return; }

  const c = grid[I(npc.x, npc.y)];
  if (c.type === 'flower' && c.pollen > 0 && !c.dead && npc.pollen < POLLEN_CAP) {
    const take = Math.min(c.pollen, POLLEN_CAP - npc.pollen);
    c.pollen -= take; npc.pollen += take;
    if (c.pollen === 0) {
      c.lives = Math.max(0, c.lives - 1);
      if (c.lives <= 0) {
        c.dead = true; c.type = 'dead_flower';
      } else {
        c.cd = FLOWER_CD;
      }
    }
    if (npc.pollen >= POLLEN_CAP) npc.returning = true;
  }
  if (npc.mode === 'harvest' && npc.tx !== null && npc.x === npc.tx && npc.y === npc.ty) { releaseClaim(npc); npc.returning = true; }
}

// ─────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────
function render(ctx, grid, proto, npcs, debug, beeCount, enemyNPCs = [], defenseZone = null, advanceZone = null, queen = null, satellites = []) {
  ctx.clearRect(0, 0, W, H);

  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const c = grid[I(x, y)], px = x * CELL, py = y * CELL;

    if (!c.revealed && !debug) {
      if (c.visited) {
        // Ghost state — visited but fog reclaimed it.
        // Lighter than true fog, brighter with more visit history.
        // visitCount 1 = slightly lighter, 2 = noticeably light, 3+ = permanently revealed (handled above)
        const brightness = Math.min(c.visitCount || 1, 3);
        const base = 122 + brightness * 18; // 140 → 158 → 176
        ctx.fillStyle = `rgb(${base},${Math.floor(base * 0.95)},${Math.floor(base * 0.85)})`;
        ctx.fillRect(px, py, CELL, CELL);
        // Ghost heat bleed — faint warm glow still visible through fog
        if (c.heat > 0) {
          const t = Math.min(c.heat / HEAT_MAX, 1);
          ctx.fillStyle = `rgba(200,150,60,${(t * 0.30).toFixed(2)})`;
          ctx.fillRect(px, py, CELL, CELL);
        }
        ctx.fillStyle = 'rgba(0,0,0,0.10)';
        ctx.fillRect(px, py, 1, CELL); ctx.fillRect(px, py, CELL, 1);
      } else {
        // True fog — never visited, darkest
        ctx.fillStyle = '#7a7060';
        ctx.fillRect(px, py, CELL, CELL);
        ctx.fillStyle = 'rgba(0,0,0,0.2)';
        ctx.fillRect(px, py, 1, CELL); ctx.fillRect(px, py, CELL, 1);
      }
      continue;
    }

    // ── Revealed ground — base color ──
    let col = '#ece0b8';
    if (c.type === 'hive') col = '#e8a000';
    else if (c.type === 'enemy_hive') col = '#cc2200';
    // Orange: flower type colors
    else if (c.type === 'flower') {
      if (c.pollen > 0) col = (c.flowerType && FLOWER_TYPES[c.flowerType]) ? FLOWER_TYPES[c.flowerType].color : '#4caf50';
      else col = '#8aaa88';
    }
    else if (c.type === 'dead_flower') col = '#5a5248';
    else if (c.type === 'spider') col = '#cc2211';
    // Red: terrain colors
    else if (c.type === 'river') col = '#4488cc';
    else if (c.type === 'bush') col = '#5a8a40';
    else if (c.type === 'rock') col = '#888070';
    else if (c.type === 'mud') col = '#8b6a4a';
    else if (c.type === 'danger') col = '#ffbbcc';
    else if (c.heat > 0) {
      const t = Math.min(c.heat / HEAT_MAX, 1);
      const rr = Math.floor(236 + t * 12);
      const gg = Math.floor(224 - t * 20);
      const bb = Math.floor(184 - t * 60);
      col = `rgb(${rr},${gg},${bb})`;
    }

    ctx.fillStyle = col;
    ctx.fillRect(px, py, CELL, CELL);

    // Mosaic: permanent paint layer — bee color baked into the cell forever
    if (c.paint && isMosaicMode) {
      ctx.fillStyle = isTronMode
        ? `rgb(${c.paint.r},${c.paint.g},${c.paint.b})`
        : `rgba(${c.paint.r},${c.paint.g},${c.paint.b},0.72)`;
      ctx.fillRect(px, py, CELL, CELL);
    }

    if (!c.revealed && debug) {
      ctx.fillStyle = 'rgba(80,70,40,0.4)';
      ctx.fillRect(px, py, CELL, CELL);
    }

    // ── Heat map — 7-band spectral overlay, all translucent ──
    // very low: faint indigo ghost → blue → teal → green → yellow → orange → red
    if (c.heat > 0 && c.type !== 'hive' && c.type !== 'dead_flower') {
      const t = Math.min(c.heat / HEAT_MAX, 1);
      let r, g, b, a;
      if (t < 0.08) {
        // indigo ghost — barely-there trace
        r = 100; g = 60; b = 200; a = 0.06 + t * 0.8;
      } else if (t < 0.2) {
        // blue
        const s = (t - 0.08) / 0.12;
        r = Math.floor(60 + s * 20); g = Math.floor(60 + s * 40); b = 220; a = 0.12 + s * 0.10;
      } else if (t < 0.35) {
        // teal
        const s = (t - 0.2) / 0.15;
        r = 60; g = Math.floor(100 + s * 140); b = Math.floor(220 - s * 80); a = 0.22 + s * 0.10;
      } else if (t < 0.5) {
        // green
        const s = (t - 0.35) / 0.15;
        r = Math.floor(60 + s * 100); g = 240; b = Math.floor(140 - s * 120); a = 0.30 + s * 0.10;
      } else if (t < 0.65) {
        // yellow
        const s = (t - 0.5) / 0.15;
        r = Math.floor(160 + s * 80); g = Math.floor(240 - s * 40); b = Math.floor(20 - s * 10); a = 0.38 + s * 0.10;
      } else if (t < 0.82) {
        // orange
        const s = (t - 0.65) / 0.17;
        r = Math.floor(240 + s * 15); g = Math.floor(200 - s * 100); b = 10; a = 0.46 + s * 0.12;
      } else {
        // deep red — hottest, heaviest routes
        const s = (t - 0.82) / 0.18;
        r = 255; g = Math.floor(100 - s * 90); b = 0; a = 0.58 + s * 0.20;
      }
      ctx.fillStyle = `rgba(${r},${g},${b},${a.toFixed(2)})`;
      ctx.fillRect(px, py, CELL, CELL);
    }

    // Show lives remaining on flowers (small dot indicator)
    if (c.type === 'flower' && c.pollen > 0 && c.lives <= 3 && c.lives < 999) {
      // Red tint warning — few lives left
      ctx.fillStyle = `rgba(200,0,0,${0.1 + (3 - c.lives) * 0.12})`;
      ctx.fillRect(px, py, CELL, CELL);
    }

    ctx.fillStyle = 'rgba(0,0,0,0.04)';
    ctx.fillRect(px, py, 1, CELL); ctx.fillRect(px, py, CELL, 1);
  }

  // Hive footprint grows with colony
  {
    const hiveR = beeCount >= 14 ? 2 : beeCount >= 7 ? 1 : 0;
    if (hiveR > 0) {
      ctx.fillStyle = 'rgba(232,160,0,0.35)';
      for (let dy = -hiveR; dy <= hiveR; dy++) for (let dx = -hiveR; dx <= hiveR; dx++) {
        if (dx === 0 && dy === 0) continue;
        ctx.fillRect((HX + dx) * CELL, (HY + dy) * CELL, CELL, CELL);
      }
    }
  }

  // NPC trails — each bee its own color
  for (const n of npcs) {
    if (!n.alive || !n.trail || n.trail.length < 2) continue;
    const { r, g, b } = n;
    for (let i = 0; i < n.trail.length - 1; i++) {
      const fade = 1 - i / n.trail.length;
      const alpha = fade * 0.65;
      ctx.strokeStyle = `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
      ctx.lineWidth = Math.max(0.4, fade * 1.8);
      ctx.beginPath();
      const a = n.trail[i], b2 = n.trail[i + 1];
      ctx.moveTo(a.x * CELL + CELL / 2, a.y * CELL + CELL / 2);
      ctx.lineTo(b2.x * CELL + CELL / 2, b2.y * CELL + CELL / 2);
      ctx.stroke();
    }
  }

  // NPCs — colored dot matching their trail, role outline if in BvB
  const ROLE_COLORS = { forager: null, scout: '#00ffff', guard: '#4488ff', warrior: '#ff4444', kamikaze: '#ff00ff' };
  for (const n of npcs) {
    if (!n.alive) continue;
    ctx.fillStyle = `rgb(${n.r},${n.g},${n.b})`;
    ctx.fillRect(n.x * CELL + 1, n.y * CELL + 1, CELL - 2, CELL - 2);
    // Blue: role outline
    if (n.role && ROLE_COLORS[n.role]) {
      ctx.strokeStyle = ROLE_COLORS[n.role];
      ctx.lineWidth = 1;
      ctx.strokeRect(n.x * CELL + 0.5, n.y * CELL + 0.5, CELL - 1, CELL - 1);
    }
  }

  // Protagonist trail
  if (proto.trail && proto.trail.length > 1) {
    // Draw in segments so opacity fades from head to tail
    for (let i = 0; i < proto.trail.length - 1; i++) {
      const fade = 1 - i / proto.trail.length;
      const alpha = fade * 0.75;
      ctx.strokeStyle = `rgba(255,220,0,${alpha.toFixed(2)})`;
      ctx.lineWidth = Math.max(0.5, fade * 2);
      ctx.beginPath();
      const a = proto.trail[i], b = proto.trail[i + 1];
      ctx.moveTo(a.x * CELL + CELL / 2, a.y * CELL + CELL / 2);
      ctx.lineTo(b.x * CELL + CELL / 2, b.y * CELL + CELL / 2);
      ctx.stroke();
    }
  }

  // Protagonist — yellow with white core (or team color in BvB)
  {
    const px = proto.x * CELL, py = proto.y * CELL;
    if (proto.team) {
      ctx.fillStyle = `rgb(${proto.r},${proto.g},${proto.b})`;
      ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(px + 2, py + 2, CELL - 4, CELL - 4);
    } else {
      ctx.fillStyle = '#ffdd00'; ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(px + 2, py + 2, CELL - 4, CELL - 4);
    }
  }

  // Enemy NPC trails
  for (const n of enemyNPCs) {
    if (n.alive === false || !n.trail || n.trail.length < 2) continue;
    for (let i = 0; i < n.trail.length - 1; i++) {
      const a = n.trail[i], b = n.trail[i + 1];
      if (!debug && !grid[I(a.x, a.y)]?.revealed) continue;
      const fade = 1 - i / n.trail.length;
      ctx.strokeStyle = `rgba(${n.r},${n.g},${n.b},${(fade * 0.65).toFixed(2)})`;
      ctx.lineWidth = Math.max(0.4, fade * 1.8);
      ctx.beginPath();
      ctx.moveTo(a.x * CELL + CELL / 2, a.y * CELL + CELL / 2);
      ctx.lineTo(b.x * CELL + CELL / 2, b.y * CELL + CELL / 2);
      ctx.stroke();
    }
  }

  // Enemy NPC dots
  for (const n of enemyNPCs) {
    if (n.alive === false) continue;
    if (!debug && !grid[I(n.x, n.y)]?.revealed) continue;
    ctx.fillStyle = `rgb(${n.r},${n.g},${n.b})`;
    ctx.fillRect(n.x * CELL + 1, n.y * CELL + 1, CELL - 2, CELL - 2);
    if (n.bvbState === 'encircle') {
      ctx.strokeStyle = 'rgba(255,50,50,0.8)';
      ctx.lineWidth = 1;
      ctx.strokeRect(n.x * CELL, n.y * CELL, CELL, CELL);
    }
  }

  // Player bee combat state indicator
  const allPlayerBees = [proto, ...npcs.filter(n => n.alive !== false)];
  for (const b of allPlayerBees) {
    if (b.bvbState === 'encircle') {
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1;
      ctx.strokeRect(b.x * CELL, b.y * CELL, CELL, CELL);
    } else if (b.bvbState === 'retreat') {
      ctx.strokeStyle = 'rgba(255,200,0,0.6)';
      ctx.lineWidth = 1;
      ctx.strokeRect(b.x * CELL, b.y * CELL, CELL, CELL);
    }
  }

  // Orange: Queen — gold crown dot at hive, health ring
  if (queen && queen.alive) {
    const qx = queen.x * CELL + CELL / 2, qy = queen.y * CELL + CELL / 2;
    const hp = queen.health / queen.maxHealth;
    ctx.fillStyle = 'rgba(255,215,0,0.9)';
    ctx.beginPath();
    ctx.arc(qx, qy, CELL * 0.9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `hsl(${Math.floor(hp * 120)},100%,50%)`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(qx, qy, CELL * 0.9, -Math.PI/2, -Math.PI/2 + Math.PI * 2 * hp);
    ctx.stroke();
    ctx.fillStyle = '#3a1a00';
    ctx.font = `bold ${CELL}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('♛', qx, qy);
  }

  // Orange: Satellite hives — construction sites and active hives
  for (const sat of satellites) {
    const sx = sat.x * CELL + CELL / 2, sy = sat.y * CELL + CELL / 2;
    if (!sat.active) {
      // Construction site — dashed amber circle with build progress bar
      const progress = Math.min(sat.pollen / SATELLITE_BUILD_COST, 1);
      ctx.strokeStyle = 'rgba(255,180,0,0.7)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(sx, sy, CELL * 1.8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      // Progress arc
      ctx.strokeStyle = 'rgba(255,220,0,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, CELL * 1.8, -Math.PI/2, -Math.PI/2 + Math.PI * 2 * progress);
      ctx.stroke();
      // Label
      ctx.fillStyle = 'rgba(255,200,0,0.9)';
      ctx.font = `${CELL - 1}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🏗', sx, sy);
    } else {
      // Active satellite hive — smaller amber square
      ctx.fillStyle = '#d4890a';
      ctx.fillRect(sat.x * CELL + 1, sat.y * CELL + 1, CELL - 2, CELL - 2);
      ctx.fillStyle = '#fff8e0';
      ctx.fillRect(sat.x * CELL + 2, sat.y * CELL + 2, CELL - 4, CELL - 4);
      // Satellite queen indicator
      if (sat.queen?.alive) {
        ctx.fillStyle = 'rgba(255,215,0,0.85)';
        ctx.font = `${CELL - 2}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('♛', sx, sy);
      }
    }
  }

  // Defense waypoints — cyan diamond dots
  if (defenseZone && defenseZone.length > 0) {
    for (const wp of defenseZone) {
      const px = wp.x * CELL + CELL / 2, py = wp.y * CELL + CELL / 2;
      ctx.fillStyle = 'rgba(100,220,255,0.85)';
      ctx.beginPath();
      ctx.moveTo(px, py - CELL * 0.7);
      ctx.lineTo(px + CELL * 0.5, py);
      ctx.lineTo(px, py + CELL * 0.7);
      ctx.lineTo(px - CELL * 0.5, py);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(60,160,220,0.9)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // Advance waypoints — gold circles with connecting line showing path order
  if (advanceZone && advanceZone.length > 0) {
    // Draw connecting lines first
    if (advanceZone.length > 1) {
      ctx.strokeStyle = 'rgba(255,220,60,0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      advanceZone.forEach((wp, i) => {
        const px = wp.x * CELL + CELL / 2, py = wp.y * CELL + CELL / 2;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (let i = 0; i < advanceZone.length; i++) {
      const wp = advanceZone[i];
      const px = wp.x * CELL + CELL / 2, py = wp.y * CELL + CELL / 2;
      ctx.fillStyle = 'rgba(255,220,60,0.85)';
      ctx.beginPath();
      ctx.arc(px, py, CELL * 0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(180,140,0,0.9)';
      ctx.lineWidth = 1;
      ctx.stroke();
      // Sequence number
      ctx.fillStyle = 'rgba(80,50,0,0.9)';
      ctx.font = `bold ${CELL * 0.7}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(i + 1, px, py);
    }
  }
}


// ─────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────
export default function BeeSim() {
  const canvasRef = useRef(null);
  const stateRef = useRef(null);
  const timerRef = useRef(null);

  const [debug, setDebug] = useState(false);
  const [paused, setPaused] = useState(false);
  const [gameOver, setGameOver] = useState(null);
  const [mode, setMode] = useState(null);
  const [tick, setTick] = useState(0);
  const [zoneTool, setZoneTool] = useState(null);
  const [mapSize, setMapSize] = useState('standard');
  const [zoom, setZoom] = useState(1);
  const [mosaicPattern, setMosaicPattern] = useState('mandala');
  const [menuOpen, setMenuOpen] = useState(false); // 0.5 | 1 | 1.5 // null | 'defense' | 'advance'
  const [hud, setHud] = useState({
    bees: 1, pollen: 40, nextBee: 50, moves: BEE_MOVES, turn: 0,
    tier: 0, spawnCost: NPC_SPAWN_TIER_BASE,
    state: 'SPIRAL', carrying: 0, smelling: 0, distHome: 0, danger: false,
    log: 'Hive established.', deadFlowers: 0, spidersKilled: 0,
  });

  function getTier(turn) { return Math.min(3, Math.floor(turn / TIER_INTERVAL)); }
  function getSpawnCost(tier) { return Math.round(NPC_SPAWN_TIER_BASE * (1 + tier * 0.5)); }
  function getTierMult(tier) { return [1.0, 0.65, 0.4, 0.25][tier] ?? 0.25; }

  function initSim(selectedMode, playerTeam = 'blue', mapSize = 'standard', pattern = 'mandala') {
    applyMapConfig(selectedMode === 'mosaic'
      ? MAP_CONFIGS.epic
      : MAP_CONFIGS[mapSize] || MAP_CONFIGS.standard);
    MEM.flowers = []; MEM.dangers.clear(); MEM.spiders = [];
    Object.keys(CLAIMS).forEach(k => delete CLAIMS[k]);
    Object.keys(ALARMS).forEach(k => delete ALARMS[k]);

    const isBvB = selectedMode === 'bvb';
    const isMosaic = selectedMode === 'mosaic';
    isMosaicMode = isMosaic;
    isFibonacciMode = isMosaic && pattern === 'fibonacci';
    isTronMode = isFibonacciMode;
    POLLEN_CAP = isMosaic ? POLLEN_CAP_MOSAIC : POLLEN_CAP_NORMAL;
    const { P_HX: phx, P_HY: phy, E_HX: ehx, E_HY: ehy } = bvbCorners();
    const playerHX = isBvB ? (playerTeam === 'red' ? ehx : phx) : HX;
    const playerHY = isBvB ? (playerTeam === 'red' ? ehy : phy) : HY;
    const enemyHX  = isBvB ? (playerTeam === 'red' ? phx : ehx) : 0;
    const enemyHY  = isBvB ? (playerTeam === 'red' ? phy : ehy) : 0;

    const grid = isMosaic ? makeMosaicGrid(pattern)
               : isBvB    ? makeBvBGrid(playerHX, playerHY, enemyHX, enemyHY)
               :             makeGrid(1.0);
    reveal(grid, playerHX, playerHY, 8);
    memLearn(grid);

    const endless = selectedMode === 'endless' || selectedMode === 'mosaic';
    const winBees = endless ? Infinity : WIN_BEES_STANDARD + 1;
    const proto = isBvB ? makeBvBProto(playerTeam, playerHX, playerHY) : makeProto();

    if (isBvB) {
      for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
        const nx = enemyHX + dx, ny = enemyHY + dy;
        if (inB(nx, ny) && Math.sqrt(dx*dx+dy*dy) <= 8) grid[I(nx, ny)].eRevealed = true;
      }
    }

    stateRef.current = {
      grid, hive: { pollen: 40 }, proto,
      npcs: [], npcNext: 1, beeCount: 1, turn: 0, spawnCD: 0,
      log: [isBvB ? 'Colony deployed. Find and destroy the enemy hive.' : 'Hive established.'],
      won: false, lastTier: 0, spidersKilled: 0, deadFlowers: 0,
      endless, winBees, isBvB, isMosaic, playerTeam, mapSize,
      // BvB
      enemyHive: { pollen: 40 },
      enemyNPCs: [], enemyNpcNext: 1, enemySpawnCD: 0,
      enemyProto: null,
      defenseZone: [], advanceZone: [],
      enemyDefeated: false,
      playerHX, playerHY, enemyHX, enemyHY,
      // Blue
      playerStance: STANCE.BALANCED,
      hiveHP: 5,
      hiveAlertTick: 0,
      // Orange
      queen: makeQueen(playerHX, playerHY),
      satellites: [],        // array of satellite hive objects
      satelliteNext: 1,      // id counter
      satelliteSiteCD: 0,    // cooldown before queen scouts again
    };
    setTick(0); setGameOver(null); setPaused(false);
    setHud({
      bees: 1, pollen: 40, nextBee: NPC_SPAWN_TIER_BASE, moves: CFG.BEE_MOVES, turn: 0,
      tier: 0, spawnCost: NPC_SPAWN_TIER_BASE,
      state: 'SPIRAL', carrying: 0, smelling: 0, distHome: 0, danger: false,
      log: isBvB ? 'Colony deployed.' : 'Hive established.',
      deadFlowers: 0, spidersKilled: 0, isBvB, enemyBees: 1,
      hiveHP: 5, hiveAlert: false, queenAlive: true, queenDirective: 'auto',
    });
  }

  // initSim is called from mode select, not on mount

  function doTick() {
    const w = stateRef.current;
    if (!w || w.won) return;
    w.turn++;

    // ── Difficulty tier scaling ──
    const tier = getTier(w.turn);
    if (tier > w.lastTier) {
      w.lastTier = tier;
      const spiderMinDist = Math.max(12, CFG.SPIDER_MIN_DIST - tier * 3);
      addSpider(w.grid, spiderMinDist);
      if (tier >= 2) addSpider(w.grid, spiderMinDist);
      // Update flower lives for all existing living flowers
      // Recalculate lives for all living flowers using new tier mult
      // Distance gradient is preserved — close flowers still have more lives than far ones
      const mult = getTierMult(tier);
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
        const c = w.grid[I(x, y)];
        if (c.type === 'flower' && !c.dead) {
          const d = dst(x, y, HX, HY);
          const newMax = flowerLivesByDist(d, mult);
          if (c.lives > newMax) c.lives = newMax;
        }
      }
      memLearn(w.grid);
      w.log.push(`⚠ Tier ${tier} — flowers fragile, spawn costs +${tier * 50}%`);
    }

    // ── Combat: gossip between nearby bees, spread alarm knowledge ──
    const allBees = [w.proto, ...w.npcs.filter(n => n.alive)];
    gossipAlarms(allBees);
    // Also check if any alarm has reached kill threshold from last tick's laps
    for (const k of Object.keys(ALARMS)) {
      const alarm = ALARMS[k];
      if (alarm.beeIds.size >= 3 && alarm.lapCount >= LAPS_TO_KILL) {
        if (w.grid[I(alarm.x, alarm.y)].type === 'spider') {
          executeSpiderKill(alarm.x, alarm.y, allBees, w.grid, w.log);
        }
      }
    }
    w.spidersKilled += pendingSpiderKills;
    pendingSpiderKills = 0;

    // ── Step bees ──
    // Blue: stamp tactician context onto each bee before stepping
    const playerBees = [w.proto, ...w.npcs.filter(n => n.alive !== false && n.team === 'player')];
    const enemyBees  = w.isBvB ? [w.enemyProto, ...w.enemyNPCs.filter(n => n.alive !== false)].filter(Boolean) : [];
    for (const b of [...playerBees, ...enemyBees]) {
      b._tacPlayerBees = playerBees;
      b._tacEnemyBees  = enemyBees;
      b._stance = b.team === 'player' ? (w.playerStance || STANCE.BALANCED) : deriveEnemyStance(w.enemyNPCs, w.enemyHive, playerBees);
      if (b._stance === ROLE.KAMIKAZE && w.isBvB) { b._enemyHX = w.enemyHX; b._enemyHY = w.enemyHY; }
    }
    // Orange: step queen
    if (w.queen) stepQueen(w.queen, w.hive, MEM.spiders, w.log, w.turn);

    // Orange: satellite hive system
    if (!w.isBvB && w.satellites !== undefined) {
      // All existing hive positions
      const allHives = [
        { x: HX, y: HY },
        ...w.satellites.map(s => ({ x: s.x, y: s.y })),
      ];

      // Queen scouts for new site when colony is at cap and no pending site exists
      const atCap = w.beeCount >= w.winBees;
      const hasPendingSite = w.satellites.some(s => !s.active);
      if (atCap && !hasPendingSite && (w.satelliteSiteCD || 0) <= 0) {
        const site = queenChooseSite(w.grid, allHives);
        if (site) {
          const sat = makeSatelliteHive(site.x, site.y, w.satelliteNext++);
          w.satellites.push(sat);
          w.satelliteSiteCD = 500;
          w.log.push(`👑 Queen designated new hive site at (${site.x},${site.y}). Bees: build it!`);
        }
      }
      if (w.satelliteSiteCD > 0) w.satelliteSiteCD--;

      // Returning bees tithe pollen at construction sites and nearest active satellite
      const allBees = [w.proto, ...w.npcs.filter(n => n.alive !== false)];
      for (const bee of allBees) {
        if (!bee.returning || bee.pollen <= 0) continue;
        for (const sat of w.satellites) {
          if (dst(bee.x, bee.y, sat.x, sat.y) > SATELLITE_TITHE_R) continue;
          const tithe = Math.min(bee.pollen, SATELLITE_TITHE);
          if (!sat.active) {
            // Under construction — contribute to build fund
            sat.pollen += tithe;
            bee.pollen -= tithe;
            if (sat.pollen >= SATELLITE_BUILD_COST) {
              sat.active = true;
              sat.hivePollen = 40;
              sat.queen = makeQueen(sat.x, sat.y);
              w.grid[I(sat.x, sat.y)].type = 'hive';
              w.log.push(`🏠 Satellite hive #${sat.id} activated at (${sat.x},${sat.y})!`);
            }
          } else {
            // Active satellite — deposit here instead of traveling all the way home
            sat.hivePollen += tithe;
            bee.pollen -= tithe;
          }
        }
      }

      // Active satellites: transfer pollen to main hive periodically, spawn bees
      for (const sat of w.satellites) {
        if (!sat.active) continue;

        // Step satellite queen
        if (sat.queen) stepQueen(sat.queen, { pollen: sat.hivePollen }, MEM.spiders, w.log, w.turn);

        // Transfer surplus pollen to main hive every 50 turns
        if (w.turn % 50 === 0 && sat.hivePollen > 100) {
          const transfer = Math.floor(sat.hivePollen * 0.3);
          sat.hivePollen -= transfer;
          w.hive.pollen += transfer;
        }

        // Satellite spawns its own bees (cheaper — offset hive)
        sat.beeCount = 1 + (sat.npcs || []).filter(n => n.alive !== false).length;
        const satSpawnCost = NPC_SPAWN_TIER_BASE;
        if (sat.hivePollen >= sat.beeCount * satSpawnCost &&
            sat.beeCount < SATELLITE_SPAWN_CAP &&
            (sat.spawnCD || 0) <= 0) {
          sat.spawnCD = 60;
          const npc = makeNPC(w.npcNext++);
          // Override hive coords to satellite position
          npc.hx = sat.x; npc.hy = sat.y;
          npc.x = sat.x; npc.y = sat.y;
          npc._satId = sat.id;
          if (!sat.npcs) sat.npcs = [];
          sat.npcs.push(npc);
          w.npcs.push(npc); // also in main npcs for rendering/stepping
          sat.beeCount++;
          w.log.push(`🐝 Satellite #${sat.id} spawned bee #${npc.id}`);
        }
        if ((sat.spawnCD || 0) > 0) sat.spawnCD--;

        // Once satellite is at cap, queen scouts another site from here
        if (sat.beeCount >= SATELLITE_SPAWN_CAP && (w.satelliteSiteCD || 0) <= 0) {
          const satHives = [...allHives, { x: sat.x, y: sat.y }];
          const site2 = queenChooseSite(w.grid, satHives);
          if (site2) {
            const sat2 = makeSatelliteHive(site2.x, site2.y, w.satelliteNext++);
            w.satellites.push(sat2);
            w.satelliteSiteCD = 500;
            w.log.push(`👑 Satellite #${sat.id} queen designated site at (${site2.x},${site2.y})`);
          }
        }
      }
    }

    stepProto(w.proto, w.grid, w.hive, w.log, w.turn);
    // NPC batching — on large/epic maps with big colonies, alternate halves each tick for performance
    const aliveNPCs = w.npcs.filter(n => n.alive);
    const batchAll = aliveNPCs.length <= 40 || CFG.COLS <= 128;
    for (let i = 0; i < aliveNPCs.length; i++) {
      if (!batchAll && (i % 2 !== w.turn % 2)) continue; // skip odd/even alternating
      stepNPC(aliveNPCs[i], w.grid, w.hive, w.log, w.turn, w.defenseZone, w.advanceZone);
    }

    // ── Flower regen + resurrection ──
    let deadCount = 0;
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      const c = w.grid[I(x, y)];
      if (c.type === 'flower' && c.pollen === 0 && c.cd > 0 && !c.dead) { c.cd--; if (c.cd === 0) c.pollen = c.max; }
      if (c.dead || c.type === 'dead_flower') {
        // Resurrection: revive after 500 turns from when it died
        if (!c.diedAt) c.diedAt = w.turn; // stamp if missing
        if (w.turn - c.diedAt >= 500) {
          const d = dst(x, y, HX, HY);
          const mult = getTierMult(tier);
          c.type = 'flower';
          c.dead = false;
          c.pollen = c.max;
          c.lives = flowerLivesByDist(d, mult);
          c.diedAt = null;
          c.cd = 0;
          w.log.push(`🌸 Flower at (${x},${y}) bloomed again.`);
        } else {
          deadCount++;
        }
      }
    }
    w.deadFlowers = deadCount;

    // ── Heat decay ──
    if (w.isMosaic) {
      // Mosaic: heat is nearly permanent — only decays when stepped on (overlap-only fade)
      // This preserves the geometric trail pattern — bees painting over themselves slightly brighten, never dim passively
      // A tiny 25% rate decay happens very rarely (every 2000 turns) to prevent total saturation
      if (w.turn % 2000 === 0) {
        for (const c of w.grid) { if (c.heat > 0) c.heat = Math.max(0, c.heat - 1); }
      }
    } else {
      if (w.turn % HEAT_DECAY_EVERY === 0) {
        for (const c of w.grid) { if (c.heat > 0) c.heat = Math.max(0, c.heat - 1); }
      }
    }

    // ── Fog reclaim — cells unvisited for 500+ turns lose revealed status ──
    // but keep c.visited = true so the persistent ghost tint stays.
    // Cells visited 3+ times are permanently memorized — fog can never reclaim them.
    if (w.turn % 20 === 0) {
      for (const c of w.grid) {
        if (c.revealed && c.type !== 'hive' && c.lastVisited > 0) {
          if (c.visitCount >= 3) continue; // permanently memorized
          if (w.turn - c.lastVisited > 500) {
            c.revealed = false;
          }
        }
      }
    }

    if (w.turn % 8 === 0) memLearn(w.grid);

    // ── NPC spawn (milestone uses scaled cost) ──
    w.beeCount = 1 + w.npcs.filter(n => n.alive).length;
    const spawnCost = getSpawnCost(tier);
    const nextMilestone = w.beeCount * spawnCost;
    const queenAlive = !w.queen || w.queen.alive;
    if (w.hive.pollen >= nextMilestone && w.beeCount < w.winBees && w.spawnCD <= 0 && queenAlive) {
      w.spawnCD = 40;
      const npc = w.isBvB ? makeBvBNPC(w.npcNext++, 'player', w.playerHX, w.playerHY, w.playerTeam) : makeNPC(w.npcNext++);
      // Blue: assign role based on stance
      if (w.isBvB) {
        npc.role = pickRole(w.playerStance || STANCE.BALANCED);
        if (npc.role === ROLE.KAMIKAZE) { npc._enemyHX = w.enemyHX; npc._enemyHY = w.enemyHY; }
      }
      // Zone role takes precedence over tactical role for zone bees
      if (w.isBvB && w.defenseZone.length > 0 && w.npcs.filter(n => n.zoneRole === 'patrol').length < 3) {
        npc.zoneRole = 'patrol';
      } else if (w.isBvB && w.advanceZone.length > 0 && w.npcs.filter(n => n.zoneRole === 'advance').length < 2) {
        npc.zoneRole = 'advance';
      }
      let best = null, bestD = Infinity;
      for (const f of MEM.flowers) {
        if (isDanger(f.x, f.y) || f.pollen <= 0 || isClaimed(f.x, f.y, npc.id)) continue;
        const d = dst(w.isBvB ? w.playerHX : HX, w.isBvB ? w.playerHY : HY, f.x, f.y);
        if (d < bestD) { bestD = d; best = f; }
      }
      if (best) claimFlower(npc, best.x, best.y);
      w.npcs.push(npc); w.beeCount++;
      w.log.push(`🐝 Bee #${npc.id} hatched! Colony: ${w.beeCount}`);
      if (!w.endless && !w.isBvB && w.beeCount >= w.winBees) { w.won = true; setGameOver('win'); w.log.push('🏆 Colony complete!'); }
    }
    if (w.spawnCD > 0) w.spawnCD--;

    // ── BvB: enemy colony AI + combat ──────────────────────
    if (w.isBvB) {
      // Enemy has its own memory — swap MEM in/out for enemy steps
      const playerMEM = { flowers: [...MEM.flowers], dangers: new Set(MEM.dangers), spiders: [...MEM.spiders] };

      // Build enemy memory from cells revealed by enemy bees
      MEM.flowers = [];
      MEM.dangers = new Set();
      MEM.spiders = [];
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
        const c = w.grid[I(x, y)];
        if (!c.eRevealed) continue;
        if (c.type === 'flower' && !c.dead) MEM.flowers.push({ x, y, pollen: c.pollen });
        if (c.type === 'spider') {
          MEM.spiders.push({ x, y });
          for (let dy = -(KILL_R+1); dy <= KILL_R+1; dy++)
            for (let dx = -(KILL_R+1); dx <= KILL_R+1; dx++)
              MEM.dangers.add(`${x+dx},${y+dy}`);
        }
      }

      // Enemy proto (first enemy bee acts as protagonist)
      if (!w.enemyProto) {
        w.enemyProto = makeBvBProto(w.playerTeam === 'red' ? 'blue' : 'red', w.enemyHX, w.enemyHY);
        w.enemyProto.isEnemy = true;
      }

      // Reveal cells for enemy proto
      const ereveal = (x, y, r) => reveal(w.grid, x, y, r, w.turn, true);

      // Step enemy proto
      stepProto(w.enemyProto, w.grid, w.enemyHive, w.log, w.turn);
      ereveal(w.enemyProto.x, w.enemyProto.y, REVEAL_PROTO);

      // Enemy spawn
      const enemyAlive = w.enemyNPCs.filter(n => n.alive !== false).length;
      const enemyNextMilestone = (enemyAlive + 1) * NPC_SPAWN_TIER_BASE;
      if (w.enemyHive.pollen >= enemyNextMilestone && w.enemySpawnCD <= 0) {
        w.enemySpawnCD = 50;
        w.enemyNpcNext = spawnEnemyNPC(w.enemyNPCs, w.enemyNpcNext, w.enemyHive, w.log, w.enemyHX, w.enemyHY, w.playerTeam);
        w.log.push(`Enemy colony: ${enemyAlive + 2} bees`);
      }
      if (w.enemySpawnCD > 0) w.enemySpawnCD--;

      // Step enemy NPCs using full stepNPC
      for (const enpc of w.enemyNPCs) {
        if (enpc.alive === false) continue;
        stepNPC(enpc, w.grid, w.enemyHive, w.log, w.turn);
        ereveal(enpc.x, enpc.y, REVEAL_NPC);
      }

      // Restore player MEM
      MEM.flowers = playerMEM.flowers;
      MEM.dangers = playerMEM.dangers;
      MEM.spiders = playerMEM.spiders;

      // BvB combat resolution — all bees
      const playerBees = [w.proto, ...w.npcs.filter(n => n.alive !== false)];
      const enemyBees = [w.enemyProto, ...w.enemyNPCs.filter(n => n.alive !== false)];
      const allBvBBees = [...playerBees, ...enemyBees];
      const killed = resolveBvBCombat(allBvBBees, w.grid, w.log);
      killed.forEach(bee => { bee.alive = false; });

      // Check hive kill win
      if (checkHiveKill(playerBees, w.grid, w.log, w.enemyHX, w.enemyHY)) {
        w.won = true; w.enemyDefeated = true;
        setGameOver('win');
      }

      // Blue: hive HP drain — enemy bees adjacent to player hive deal damage
      const enemyOnHive = enemyBees.filter(e => dst(e.x, e.y, w.playerHX, w.playerHY) <= BVB_HIVE_KILL_R).length;
      if (enemyOnHive >= 2) {
        w.hiveHP = Math.max(0, (w.hiveHP ?? 5) - 1);
        w.log.push(`🔥 Hive under attack — integrity ${w.hiveHP}/5`);
        if (w.hiveHP <= 0 && !w.won) { w.won = true; setGameOver('loss'); w.log.push('💀 Hive destroyed. Colony lost.'); }
      } else if ((w.hiveHP ?? 5) < 5 && enemyOnHive === 0) {
        if (w.turn % 80 === 0) w.hiveHP = Math.min(5, (w.hiveHP ?? 5) + 1);
      }

      // Blue: hive alert — enemy within 15 cells
      const enemyNearHive = enemyBees.some(e => dst(e.x, e.y, w.playerHX, w.playerHY) <= 15);
      if (enemyNearHive) w.hiveAlertTick = w.turn;

      // Reveal enemy hive if player bee gets close
      for (const pb of playerBees) {
        if (dst(pb.x, pb.y, w.enemyHX, w.enemyHY) <= REVEAL_PROTO) {
          w.grid[I(w.enemyHX, w.enemyHY)].revealed = true;
        }
      }
    }

    if (w.log.length > 60) w.log = w.log.slice(-40);

    // ── Sensor ──
    const p = w.proto;
    const phx2 = w.isBvB ? w.playerHX : HX;
    const phy2 = w.isBvB ? w.playerHY : HY;
    const nearFlowers = MEM.flowers.filter(f => dst(p.x, p.y, f.x, f.y) <= 10 && f.pollen > 0).length;
    const dangerNear = [...MEM.dangers].some(k => {
      if (k.startsWith('alarm:')) return false;
      const [dx, dy] = k.split(',').map(Number);
      return dst(p.x, p.y, dx, dy) <= 3;
    });
    const enemyAliveCount = w.isBvB ? w.enemyNPCs.filter(n => n.alive !== false).length + 1 : 0;

    setHud({
      bees: w.beeCount, pollen: w.hive.pollen, nextBee: nextMilestone,
      moves: p.moves, turn: w.turn, tier, spawnCost,
      state: p.bvbState === 'retreat' ? 'RETREAT' : p.bvbState === 'encircle' ? 'COMBAT' :
             p.state === 'alarm' ? 'ALARM🚨' : p.returning ? 'RETURN' :
             p.phase === 'spiral' ? 'SPIRAL' : 'FORAGE',
      carrying: p.pollen, smelling: nearFlowers,
      distHome: Math.ceil(dst(p.x, p.y, phx2, phy2)),
      danger: dangerNear,
      log: w.log[w.log.length - 1] || '',
      deadFlowers: w.deadFlowers, spidersKilled: w.spidersKilled,
      isBvB: w.isBvB, enemyBees: enemyAliveCount,
      hiveHP: w.hiveHP ?? 5,
      hiveAlert: w.isBvB && (w.turn - (w.hiveAlertTick || 0) < 10),
      queenAlive: !w.queen || w.queen.alive,
      queenDirective: w.queen?.directive || 'auto',
      playerStance: w.playerStance || STANCE.BALANCED,
      satellites: (w.satellites || []).length,
      activeSatellites: (w.satellites || []).filter(s => s.active).length,
    });

    setTick(t => t + 1);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !stateRef.current) return;
    const w = stateRef.current;
    try {
      render(canvas.getContext('2d'), w.grid, w.proto, w.npcs, debug, w.beeCount,
        w.isBvB ? [w.enemyProto, ...w.enemyNPCs].filter(Boolean) : [],
        w.defenseZone || [], w.advanceZone || [], w.queen, w.satellites || []);
    } catch (err) { console.error('render error:', err); }
  }, [tick, debug]);

  useEffect(() => {
    if (!paused && !gameOver && mode && stateRef.current) { timerRef.current = setInterval(doTick, TICK_MS); }
    else { clearInterval(timerRef.current); }
    return () => clearInterval(timerRef.current);
  }, [paused, gameOver, mode]);

  function handleReset() {
    clearInterval(timerRef.current);
    setMode(null); setGameOver(null); setPaused(false);
    setZoneTool(null);
    stateRef.current = null;
  }

  function canvasToGrid(e) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = (canvas.width / rect.width) / zoom;
    const scaleY = (canvas.height / rect.height) / zoom;
    const cx = Math.floor((e.clientX - rect.left) * scaleX / CELL);
    const cy = Math.floor((e.clientY - rect.top) * scaleY / CELL);
    if (!inB(cx, cy)) return null;
    return { x: cx, y: cy };
  }

  function handleCanvasClick(e) {
    if (!zoneTool || !stateRef.current) return;
    const pos = canvasToGrid(e);
    if (!pos) return;
    const w = stateRef.current;
    const arr = zoneTool === 'defense' ? w.defenseZone : w.advanceZone;
    // Toggle: if a waypoint already exists within 3 cells, remove it; otherwise add
    const nearIdx = arr.findIndex(wp => dst(wp.x, wp.y, pos.x, pos.y) <= 3);
    if (nearIdx >= 0) arr.splice(nearIdx, 1);
    else arr.push({ x: pos.x, y: pos.y });
    setTick(t => t + 1);
  }

  function startMode(selectedMode, team = 'player', size = null, pattern = null) {
    setMode(selectedMode);
    setGameOver(null); setPaused(false); setZoneTool(null); setMenuOpen(false);
    initSim(selectedMode, team, size || mapSize, pattern || mosaicPattern);
    setTimeout(() => {
      const c = canvasRef.current;
      if (!c || !stateRef.current) return;
      const w = stateRef.current;
      try {
        render(c.getContext('2d'), w.grid, w.proto, w.npcs, false, w.beeCount,
          w.isBvB ? [w.enemyProto, ...w.enemyNPCs].filter(Boolean) : [], w.defenseZone || [], w.advanceZone || [], w.queen, w.satellites || []);
      } catch (err) { console.error('render error:', err); }
      setTick(1);
    }, 50);
  }

  const sep = <span style={{ color: '#b07000', opacity: 0.4, padding: '0 2px' }}>│</span>;
  const tierColors = ['#3a1a00', '#7a4400', '#b06000', '#cc2000'];
  const tierLabels = ['STABLE', 'STRESS', 'SCARCE', 'CRISIS'];

  // ── MODE SELECT SCREEN ──
  if (!mode) {
    return (
      <div style={{
        fontFamily: "'Courier New', monospace",
        background: '#1a1400', height: '100vh',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        color: '#f5a800', overflow: 'hidden',
      }}>
        {/* Fixed header */}
        <div style={{ textAlign: 'center', padding: '12px 0 8px', flexShrink: 0 }}>
          <span style={{ fontSize: '20px' }}>🐝</span>
          <span style={{ fontSize: '18px', fontWeight: 'bold', letterSpacing: '0.15em', margin: '0 8px' }}>BEE-SIM</span>
          <span style={{ fontSize: '10px', color: '#b07000', letterSpacing: '0.1em' }}>COLONY INTELLIGENCE SIMULATOR</span>
        </div>

        {/* Map size picker */}
        <div style={{ display: 'flex', gap: '5px', marginBottom: '8px', justifyContent: 'center', flexShrink: 0 }}>
          {Object.entries(MAP_CONFIGS).map(([key, cfg]) => (
            <button key={key} onClick={() => setMapSize(key)} style={{
              padding: '3px 8px', fontFamily: "'Courier New', monospace",
              fontSize: '9px', fontWeight: 'bold', cursor: 'pointer',
              border: `2px solid ${mapSize === key ? '#f5a800' : key === 'epic' ? '#aa4400' : '#5a3a00'}`,
              background: mapSize === key ? 'rgba(245,168,0,0.2)' : key === 'epic' ? 'rgba(100,30,0,0.3)' : 'transparent',
              color: mapSize === key ? '#f5a800' : key === 'epic' ? '#ff8844' : '#b07000',
              borderRadius: '2px',
            }}>
              {cfg.label} <span style={{ opacity: 0.7 }}>{cfg.COLS}²</span>
              {key === 'epic' && <span style={{ color: '#ff6622' }}> ⚠</span>}
            </button>
          ))}
        </div>

        {/* Scrollable cards */}
        <div style={{ flex: 1, overflowY: 'auto', width: '100%', padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', maxWidth: '320px' }}>
          <ModeCard
            title="STANDARD"
            subtitle="Grow colony to 20 bees"
            detail="Difficulty scales every 300 turns. Flowers die. Spiders encroach. Build a full colony to win."
            color="#d4890a"
            onClick={() => startMode('standard')}
          />
          <ModeCard
            title="ENDLESS"
            subtitle="No win condition"
            detail="Grow beyond 20 bees. The world gets harder indefinitely. How long can the colony survive?"
            color="#2e7d32"
            onClick={() => startMode('endless')}
          />
          <div style={{ border: '2px solid #8b0000', borderRadius: '4px', overflow: 'hidden' }}>
            <div style={{ background: 'rgba(139,0,0,0.15)', padding: '12px 16px 8px' }}>
              <div style={{ fontSize: '14px', fontWeight: 'bold', letterSpacing: '0.12em', marginBottom: '3px', color: '#ff6060' }}>BEE VS BEE</div>
              <div style={{ fontSize: '11px', color: '#f5a800', marginBottom: '6px' }}>Destroy the enemy hive</div>
              <div style={{ fontSize: '10px', color: '#b07000', lineHeight: '1.5', marginBottom: '10px' }}>Two colonies. Opposing corners. Neutral pollen. Draw defense and advance zones. Surround the enemy hive with 3 bees to win.</div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={() => startMode('bvb', 'player')} style={{
                  flex: 1, padding: '8px', fontFamily: "'Courier New', monospace",
                  fontSize: '11px', fontWeight: 'bold', cursor: 'pointer', border: '2px solid #4444ff',
                  background: 'rgba(60,60,200,0.2)', color: '#8888ff', borderRadius: '2px',
                }}>🔵 PLAY BLUE</button>
                <button onClick={() => startMode('bvb', 'red')} style={{
                  flex: 1, padding: '8px', fontFamily: "'Courier New', monospace",
                  fontSize: '11px', fontWeight: 'bold', cursor: 'pointer', border: '2px solid #ff4444',
                  background: 'rgba(200,60,60,0.2)', color: '#ff8888', borderRadius: '2px',
                }}>🔴 PLAY RED</button>
              </div>
            </div>
          </div>

          {/* MOSAIC mode */}
          <div style={{ border: '2px solid #4a2a6a', borderRadius: '4px', overflow: 'hidden' }}>
            <div style={{ background: 'rgba(74,42,106,0.2)', padding: '12px 16px 10px' }}>
              <div style={{ fontSize: '14px', fontWeight: 'bold', letterSpacing: '0.12em', marginBottom: '3px', color: '#cc88ff' }}>MOSAIC</div>
              <div style={{ fontSize: '11px', color: '#f5a800', marginBottom: '4px' }}>Geometric pattern — bees paint the map</div>
              <div style={{ fontSize: '10px', color: '#b07000', lineHeight: '1.4', marginBottom: '10px' }}>Flowers arranged in a mathematical pattern. Your colony traces it with heat trails over time, revealing the geometry. Epic map, endless mode.</div>
              {/* Pattern picker */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '10px' }}>
                {Object.entries(MOSAIC_PATTERNS).map(([key, p]) => (
                  <button key={key} onClick={() => setMosaicPattern(key)} style={{
                    padding: '4px 8px', fontFamily: "'Courier New', monospace",
                    fontSize: '10px', fontWeight: 'bold', cursor: 'pointer',
                    border: `2px solid ${mosaicPattern === key ? '#cc88ff' : '#4a2a6a'}`,
                    background: mosaicPattern === key ? 'rgba(180,100,255,0.25)' : 'transparent',
                    color: mosaicPattern === key ? '#ee99ff' : '#8866aa',
                    borderRadius: '2px', textAlign: 'left',
                  }}>
                    {p.emoji} {p.label}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: '9px', color: '#8866aa', marginBottom: '10px', fontStyle: 'italic' }}>
                {MOSAIC_PATTERNS[mosaicPattern]?.desc}
              </div>
              <button onClick={() => startMode('mosaic')} style={{
                width: '100%', padding: '8px', fontFamily: "'Courier New', monospace",
                fontSize: '12px', fontWeight: 'bold', cursor: 'pointer',
                border: '2px solid #cc88ff', background: 'rgba(180,100,255,0.2)',
                color: '#ee99ff', borderRadius: '2px',
              }}>✦ PAINT THE MAP</button>
            </div>
          </div>

        </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'Courier New', monospace", background: '#1a1400', height: '100vh', display: 'flex', flexDirection: 'column' }}>

      {/* ── HUD: two compact fixed-width rows ── */}
      <div style={{
        background: '#f5a800', borderBottom: '2px solid #b07000',
        fontSize: '9.5px', fontWeight: 'bold', color: '#3a1a00',
        fontFamily: "'Courier New', monospace", userSelect: 'none',
      }}>
        {/* Row 1 */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '2px 6px', gap: '0', whiteSpace: 'nowrap', overflow: 'visible' }}>
          <span style={{ minWidth: '52px' }}>🐝 BEE-SIM</span>
          <span style={{ color: '#b07000', padding: '0 3px' }}>│</span>
          <span style={{ minWidth: '72px', overflow: 'hidden' }}>COL <strong>{hud.bees}</strong>{mode === 'endless' || mode === 'mosaic' ? '+' : `/${WIN_BEES_STANDARD+1}`}</span>
          <span style={{ color: '#b07000', padding: '0 3px' }}>│</span>
          <span style={{ minWidth: '80px', overflow: 'hidden' }}>POL <strong>{hud.pollen}</strong></span>
          <span style={{ color: '#b07000', padding: '0 3px' }}>│</span>
          <span style={{ minWidth: '72px', overflow: 'hidden' }}>NEXT <strong>{hud.nextBee}</strong></span>
          <span style={{ color: '#b07000', padding: '0 3px' }}>│</span>
          <span style={{ minWidth: '64px', overflow: 'hidden' }}>T <strong>{hud.turn}</strong></span>
          <span style={{ color: '#b07000', padding: '0 3px' }}>│</span>
          <span style={{ minWidth: '68px', overflow: 'hidden', color: tierColors[hud.tier] || '#cc2000' }}>T{hud.tier} {tierLabels[hud.tier] || 'CRISIS'}</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: '4px', alignItems: 'center' }}>
            <button onClick={() => setZoom(z => z === 0.5 ? 1 : z === 1 ? 1.5 : 0.5)} style={{
              background: '#fff8e8', border: '1px solid #b07000', padding: '1px 5px',
              fontFamily: "'Courier New', monospace", fontSize: '9px', cursor: 'pointer',
              fontWeight: 'bold', color: '#3a1a00', borderRadius: '2px',
            }}>{zoom === 0.5 ? '−' : zoom === 1 ? '🔍' : '+'}</button>
            <button
              onClick={() => setMenuOpen(m => !m)}
              style={{
                background: menuOpen ? '#b07000' : '#fff8e8',
                border: '2px solid #b07000', padding: '1px 7px',
                fontFamily: "'Courier New', monospace", fontSize: '11px',
                cursor: 'pointer', fontWeight: 'bold',
                color: menuOpen ? '#fff' : '#3a1a00', borderRadius: '2px',
              }}
            >☰</button>
          </span>
        </div>

        {/* Dropdown — fixed so it's never clipped by overflow:hidden parents */}
        {menuOpen && (
          <div style={{
            position: 'fixed', top: '80px', right: '8px', zIndex: 9999,
            background: '#1a1400', border: '2px solid #b07000',
            borderRadius: '4px', minWidth: '180px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.8)',
            fontFamily: "'Courier New', monospace",
            overflow: 'hidden',
          }}>
            <div style={{ padding: '6px 14px', fontSize: '9px', color: '#b07000', borderBottom: '1px solid rgba(176,112,0,0.3)', letterSpacing: '0.1em' }}>
              🐝 BEE-SIM
            </div>
            {[
              { label: paused ? '▶  RESUME' : '⏸  PAUSE',    action: () => { setPaused(p => !p); setMenuOpen(false); } },
              { label: '⏭  STEP',                             action: () => { if (paused) doTick(); setMenuOpen(false); } },
              { label: debug ? '🌫  FOG: OFF' : '🌫  FOG: ON', action: () => { setDebug(d => !d); setMenuOpen(false); } },
              { label: '↺  RESTART',                          action: () => { setMenuOpen(false); if (stateRef.current) { const w = stateRef.current; startMode(mode, w.playerTeam, w.mapSize, mosaicPattern); } } },
              { label: '⌂  MAIN MENU',                        action: () => { setMenuOpen(false); handleReset(); } },
            ].map(item => (
              <button key={item.label} onClick={item.action} style={{
                display: 'block', width: '100%', padding: '11px 16px',
                background: 'transparent', border: 'none', borderBottom: '1px solid rgba(176,112,0,0.25)',
                fontFamily: "'Courier New', monospace", fontSize: '12px',
                fontWeight: 'bold', color: '#f5a800', cursor: 'pointer',
                textAlign: 'left', letterSpacing: '0.05em',
              }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(176,112,0,0.2)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >{item.label}</button>
            ))}
          </div>
        )}
        {/* Row 2 */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '1px 6px 3px', gap: '0', whiteSpace: 'nowrap', overflow: 'hidden', borderTop: '1px solid rgba(180,120,0,0.3)' }}>
          <span style={{ minWidth: '52px', display: 'flex', alignItems: 'center', gap: '3px' }}>
            SPAWN
            <span style={{ display: 'inline-block', width: '36px', height: '5px', background: '#c8a030', borderRadius: '2px', overflow: 'hidden', border: '1px solid #8b6000', verticalAlign: 'middle' }}>
              <span style={{ display: 'block', height: '100%', width: `${Math.min(100, (hud.pollen % Math.max(1,hud.spawnCost)) / Math.max(1,hud.spawnCost) * 100)}%`, background: '#3a1a00', borderRadius: '2px' }} />
            </span>
          </span>
          <span style={{ color: '#b07000', padding: '0 3px' }}>│</span>
          <span style={{ minWidth: '60px', color: '#5a3000' }}>🌸 <strong>{hud.deadFlowers}</strong> 💀</span>
          <span style={{ color: '#b07000', padding: '0 3px' }}>│</span>
          <span style={{ minWidth: '60px', color: '#005500' }}>⚔ <strong>{hud.spidersKilled}</strong> kills</span>
        </div>
      </div>

      {/* ── SENSOR BAR — single compact line ── */}
      <div style={{
        background: '#f5c842', borderBottom: '1px solid #b07000',
        padding: '2px 8px', display: 'flex', alignItems: 'center',
        gap: '0', fontSize: '10px', fontFamily: "'Courier New', monospace",
        color: '#3a1a00', whiteSpace: 'nowrap', overflow: 'hidden',
        lineHeight: '1.2',
      }}>
        {/* State pill */}
        <span style={{
          background: hud.state === 'ALARM🚨' ? '#cc0000' : hud.state === 'RETREAT' ? '#884400' : hud.state === 'COMBAT' ? '#660066' : hud.state === 'RETURN' ? '#004400' : '#b07000',
          color: '#fff', padding: '1px 5px', borderRadius: '2px', fontWeight: 'bold',
          fontSize: '9px', letterSpacing: '0.05em', marginRight: '6px',
        }}>{hud.state}</span>

        {/* Move budget bar */}
        <span style={{ marginRight: '6px', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
          <span style={{ color: '#7a4400' }}>♟</span>
          <span style={{
            display: 'inline-block', width: '36px', height: '5px',
            background: '#c09000', borderRadius: '2px', overflow: 'hidden', verticalAlign: 'middle',
          }}>
            <span style={{
              display: 'block', height: '100%', borderRadius: '2px',
              width: `${Math.round((hud.moves / CFG.BEE_MOVES) * 100)}%`,
              background: hud.moves < 60 ? '#cc2200' : hud.moves < 120 ? '#ff8800' : '#22aa44',
            }} />
          </span>
          <span style={{ color: hud.moves < 60 ? '#cc0000' : '#3a1a00' }}>{hud.moves}</span>
        </span>

        <span style={{ color: '#9a6000', margin: '0 4px' }}>·</span>

        {/* Carry */}
        <span style={{ marginRight: '6px' }}>
          🍯<strong style={{ color: hud.carrying > 0 ? '#884400' : '#b09060' }}>{hud.carrying}</strong><span style={{ color: '#b09060' }}>/{POLLEN_CAP}</span>
        </span>

        <span style={{ color: '#9a6000', margin: '0 4px' }}>·</span>

        {/* Distance home */}
        <span style={{ marginRight: '6px' }}>🏠<strong>{hud.distHome}</strong></span>

        <span style={{ color: '#9a6000', margin: '0 4px' }}>·</span>

        {/* Flowers near */}
        <span style={{ marginRight: '6px' }}>
          🌸<strong style={{ color: hud.smelling > 0 ? '#006600' : '#b09060' }}>{hud.smelling}</strong>
        </span>

        {/* Danger */}
        {hud.danger && <span style={{ color: '#cc0000', fontWeight: 'bold', marginRight: '6px' }}>⚠</span>}

        <span style={{ color: '#9a6000', margin: '0 4px' }}>·</span>

        {/* Queen */}
        {hud.queenAlive === false
          ? <span style={{ color: '#ff6600', fontWeight: 'bold', marginRight: '6px' }}>👑✕</span>
          : hud.queenDirective && hud.queenDirective !== 'auto'
            ? <span style={{ color: '#cc8800', fontWeight: 'bold', marginRight: '6px' }}>👑{hud.queenDirective.slice(0,3).toUpperCase()}</span>
            : null
        }
        {hud.activeSatellites > 0 && (
          <span style={{ color: '#d4890a', fontWeight: 'bold', marginRight: '6px' }}>🏠×{hud.activeSatellites}</span>
        )}
        {hud.satellites > hud.activeSatellites && (
          <span style={{ color: '#ffaa00', marginRight: '6px' }}>🏗</span>
        )}

        {/* BvB: enemy count + hive HP */}
        {hud.isBvB && <>
          <span style={{ color: '#9a6000', margin: '0 4px' }}>·</span>
          <span style={{ marginRight: '4px' }}>
            <span style={{ color: '#aa2200' }}>⚔</span><strong style={{ color: '#cc3300' }}>{hud.enemyBees}</strong>
          </span>
          <span style={{ display: 'inline-flex', gap: '1px', marginRight: '4px' }}>
            {Array.from({ length: 5 }).map((_, i) => (
              <span key={i} style={{
                display: 'inline-block', width: '4px', height: '8px', borderRadius: '1px',
                background: i < (hud.hiveHP ?? 5) ? '#22aa44' : '#442200',
              }} />
            ))}
          </span>
          {hud.hiveAlert && <span style={{ color: '#ff2200', fontWeight: 'bold' }}>!</span>}
        </>}

        {/* Tier */}
        {hud.tier > 0 && <>
          <span style={{ color: '#9a6000', margin: '0 4px' }}>·</span>
          <span style={{ color: ['#3a1a00','#7a4400','#b06000','#cc2000'][hud.tier] || '#cc2000', fontWeight: 'bold' }}>
            T{hud.tier}
          </span>
        </>}

        {/* Log message — takes remaining space */}
        <span style={{ color: '#9a6000', margin: '0 4px' }}>·</span>
        <span style={{
          color: '#5a3a00', fontStyle: 'italic', flex: 1,
          overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{hud.log}</span>
      </div>

      {/* ── WIN/LOSS BANNERS ── */}
      {gameOver === 'win' && (
        <div style={{ background: '#2e7d32', color: '#fff', textAlign: 'center', padding: '6px', fontSize: '13px', fontWeight: 'bold', letterSpacing: '0.1em' }}>
          ★ VICTORY — {hud.bees} BEES — TURN {hud.turn} — {hud.spidersKilled} SPIDERS SLAIN ★
        </div>
      )}
      {gameOver === 'loss' && (
        <div style={{ background: '#8b0000', color: '#fff', textAlign: 'center', padding: '6px', fontSize: '13px', fontWeight: 'bold', letterSpacing: '0.1em' }}>
          ✕ COLONY DESTROYED — TURN {hud.turn} — PRESS RESET
        </div>
      )}
      {/* Orange: queen status */}
      {!hud.queenAlive && (
        <div style={{ background: '#4a1a00', color: '#ffaa44', textAlign: 'center', padding: '4px', fontSize: '11px', fontWeight: 'bold' }}>
          👑 QUEEN DEAD — SPAWNING HALTED — REBUILD COSTS 200 POLLEN
        </div>
      )}

      {/* ── BvB ZONE TOOLBAR ── */}
      {hud.isBvB && (
        <div style={{
          background: '#1a1a2e', borderBottom: '2px solid #333388',
          padding: '4px 10px', display: 'flex', gap: '6px', alignItems: 'center',
          fontSize: '10px', fontWeight: 'bold', flexWrap: 'wrap',
        }}>
          <span style={{ color: '#8888ff', letterSpacing: '0.08em' }}>ZONES</span>
          <button onClick={() => setZoneTool(t => t === 'defense' ? null : 'defense')} style={{
            background: zoneTool === 'defense' ? 'rgba(100,200,255,0.3)' : 'transparent',
            color: '#88ddff', border: '1px solid #4488aa', padding: '2px 8px',
            fontFamily: "'Courier New', monospace", fontSize: '10px', cursor: 'pointer', borderRadius: '2px',
          }}>🛡 DEFENSE {zoneTool === 'defense' ? '— click map' : `(${stateRef.current?.defenseZone?.length || 0})`}</button>
          <button onClick={() => setZoneTool(t => t === 'advance' ? null : 'advance')} style={{
            background: zoneTool === 'advance' ? 'rgba(255,220,80,0.3)' : 'transparent',
            color: '#ffdd66', border: '1px solid #aa8800', padding: '2px 8px',
            fontFamily: "'Courier New', monospace", fontSize: '10px', cursor: 'pointer', borderRadius: '2px',
          }}>⚡ ADVANCE {zoneTool === 'advance' ? '— click map' : `(${stateRef.current?.advanceZone?.length || 0})`}</button>
          <button onClick={() => { if (stateRef.current) { stateRef.current.defenseZone = []; stateRef.current.advanceZone = []; setTick(t => t + 1); }}} style={{
            background: 'transparent', color: '#888', border: '1px solid #444',
            padding: '2px 8px', fontFamily: "'Courier New', monospace", fontSize: '10px', cursor: 'pointer', borderRadius: '2px',
          }}>✕</button>
          {/* Blue: Stance selector */}
          <span style={{ color: '#666', marginLeft: '4px' }}>│</span>
          {[STANCE.DEFENSIVE, STANCE.BALANCED, STANCE.AGGRESSIVE].map(s => (
            <button key={s} onClick={() => { if (stateRef.current) { stateRef.current.playerStance = s; setTick(t => t+1); }}} style={{
              background: hud.playerStance === s ? 'rgba(255,255,255,0.15)' : 'transparent',
              color: s === STANCE.AGGRESSIVE ? '#ff8888' : s === STANCE.DEFENSIVE ? '#88ddff' : '#aaffaa',
              border: `1px solid ${hud.playerStance === s ? 'currentColor' : '#444'}`,
              padding: '2px 6px', fontFamily: "'Courier New', monospace", fontSize: '9px', cursor: 'pointer', borderRadius: '2px',
            }}>{s.toUpperCase().slice(0,3)}</button>
          ))}
          <span style={{ color: '#666', marginLeft: '4px' }}>
            ENEMY: <strong style={{ color: '#ff8888' }}>{hud.enemyBees}</strong>
          </span>
          {hud.hiveAlert && <span style={{ color: '#ff4444', animation: 'none', marginLeft: '4px' }}>⚠ HIVE ALERT</span>}
          {hud.isBvB && <span style={{ color: '#ffcc44', marginLeft: '4px' }}>HP: {'█'.repeat(hud.hiveHP ?? 5)}{'░'.repeat(5-(hud.hiveHP??5))}</span>}
        </div>
      )}

      {/* ── CANVAS ── */}
      <div style={{ flex: 1, overflow: 'auto', background: '#1a1400' }} onClick={() => menuOpen && setMenuOpen(false)}>
        <div style={{
          transformOrigin: 'top left',
          transform: `scale(${zoom})`,
          width: `${CFG.COLS * CFG.CELL}px`,
          height: `${CFG.ROWS * CFG.CELL}px`,
        }}>
        <canvas
          ref={canvasRef} width={CFG.COLS * CFG.CELL} height={CFG.ROWS * CFG.CELL}
          style={{
            display: 'block', imageRendering: 'pixelated',
            cursor: zoneTool ? 'crosshair' : 'default',
          }}
          onClick={handleCanvasClick}
        />
        </div>
      </div>
    </div>
  );
}

function Btn({ label, onClick, active }) {
  return (
    <button onClick={onClick} style={{
      background: active ? '#b07000' : '#fff8e8',
      color: active ? '#fff' : '#3a1a00',
      border: '2px solid #b07000',
      padding: '2px 8px', fontFamily: "'Courier New', monospace",
      fontSize: '10px', fontWeight: 'bold', cursor: 'pointer', borderRadius: '2px',
    }}>{label}</button>
  );
}

function ModeCard({ title, subtitle, detail, color, onClick }) {
  return (
    <div onClick={onClick} style={{
      border: `2px solid ${color}`,
      borderRadius: '4px',
      padding: '10px 14px',
      cursor: 'pointer',
      background: 'rgba(255,255,255,0.04)',
      transition: 'background 0.15s',
    }}
      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.10)'}
      onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.04)'}
    >
      <div style={{ fontSize: '13px', fontWeight: 'bold', color, letterSpacing: '0.12em', marginBottom: '2px' }}>{title}</div>
      <div style={{ fontSize: '10px', color: '#f5a800', marginBottom: '4px' }}>{subtitle}</div>
      <div style={{ fontSize: '9px', color: '#b07000', lineHeight: '1.4' }}>{detail}</div>
    </div>
  );
}
