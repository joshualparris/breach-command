/* =============================================================
   BREACH COMMAND — game.js
   -------------------------------------------------------------
   Architecture map:
     1. RNG          — seeded PRNG, deterministic for saves
     2. SaveIO       — localStorage read/write + schema version
     3. RunState     — branching map, squad, relics, scrap
     4. Battle       — pure state + API methods for abilities
     5. PhaseMachine — explicit turn phase resolver
     6. AI           — enemy intent execution
     7. Renderer     — reads state, never mutates
     8. Input        — pointer/touch, translates to Battle actions
     9. UI           — screen transitions, HUD, overlays
     10. Bootstrap   — wire everything on DOMContentLoaded

   Key architectural commitments:
     - Battle.data is a plain JS object (no methods). All battle
       actions go through Battle API methods which mutate data and
       push log lines. This keeps state cloneable for undo/save.
     - Undo is a single structured-clone snapshot stored at the
       top of each player commit. It is invalidated at end-of-turn.
     - The phase machine is the ONLY thing that advances turns.
     - Enemy intents are computed at end-of-enemy-phase for the
       next player turn, and stored on each enemy as unit.intent.
   ============================================================= */

'use strict';

(() => {

const BC = window.BC;

/* =============================================================
   1. RNG — mulberry32
   ============================================================= */
function makeRng(seed) {
  let s = seed >>> 0;
  return {
    get seed() { return s; },
    set seed(v) { s = v >>> 0; },
    next() {
      s |= 0; s = s + 0x6D2B79F5 | 0;
      let t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    },
    int(n)     { return Math.floor(this.next() * n); },
    range(a,b) { return a + this.int(b - a + 1); },
    pick(arr)  { return arr[this.int(arr.length)]; },
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = this.int(i + 1);
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }
  };
}

/* =============================================================
   2. SAVE / LOAD
   Key: 'breach_command_save_v1'
   Saves the full RunState + optional active Battle snapshot.
   ============================================================= */
const SAVE_KEY = 'breach_command_save_v1';
const SAVE_VERSION = 1;

const SaveIO = {
  has() { try { return !!localStorage.getItem(SAVE_KEY); } catch { return false; } },
  load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (obj.v !== SAVE_VERSION) return null;
      return obj;
    } catch { return null; }
  },
  save(run, battle) {
    try {
      const payload = {
        v: SAVE_VERSION,
        savedAt: Date.now(),
        run: run ? run.serialize() : null,
        battle: battle ? battle.serialize() : null,
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
      return true;
    } catch { return false; }
  },
  clear() { try { localStorage.removeItem(SAVE_KEY); } catch {} }
};

/* =============================================================
   3. RUN STATE
   ============================================================= */
class RunState {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.rng = makeRng(seed);
    this.scrap = 0;
    this.relics = [];          // ids of owned relics
    this.squad = [];           // array of unit templates (classId, hp, maxHp)
    this.map = null;           // { nodes: [...], edges: [...], rows: [[id,...], ...] }
    this.currentNodeId = null; // current location on map (null until first pick)
    this.visitedNodeIds = [];
    this.completed = false;
    this.defeated = false;
  }

  static initial(seed) {
    const r = new RunState(seed);
    r.squad = [
      { classId: 'vanguard',    id: 'p1', hp: BC.CLASSES.vanguard.maxHp,    maxHp: BC.CLASSES.vanguard.maxHp,    move: BC.CLASSES.vanguard.move },
      { classId: 'infiltrator', id: 'p2', hp: BC.CLASSES.infiltrator.maxHp, maxHp: BC.CLASSES.infiltrator.maxHp, move: BC.CLASSES.infiltrator.move },
      { classId: 'engineer',    id: 'p3', hp: BC.CLASSES.engineer.maxHp,    maxHp: BC.CLASSES.engineer.maxHp,    move: BC.CLASSES.engineer.move },
    ];
    r.map = MapGen.generate(r.rng);
    return r;
  }

  serialize() {
    return {
      seed: this.seed,
      rngState: this.rng.seed,
      scrap: this.scrap,
      relics: this.relics.slice(),
      squad: this.squad.map(u => ({ ...u })),
      map: this.map,
      currentNodeId: this.currentNodeId,
      visitedNodeIds: this.visitedNodeIds.slice(),
      completed: this.completed,
      defeated: this.defeated,
    };
  }

  static deserialize(data) {
    const r = new RunState(data.seed);
    r.rng.seed = data.rngState;
    r.scrap = data.scrap;
    r.relics = data.relics.slice();
    r.squad = data.squad.map(u => ({ ...u }));
    r.map = data.map;
    r.currentNodeId = data.currentNodeId;
    r.visitedNodeIds = data.visitedNodeIds.slice();
    r.completed = !!data.completed;
    r.defeated = !!data.defeated;
    return r;
  }

  // Which nodes are selectable right now?
  availableNodes() {
    if (!this.currentNodeId) {
      // first row
      return this.map.rows[0].map(id => this.map.nodes.find(n => n.id === id));
    }
    const cur = this.map.nodes.find(n => n.id === this.currentNodeId);
    return this.map.edges
      .filter(e => e.from === cur.id)
      .map(e => this.map.nodes.find(n => n.id === e.to));
  }

  visitNode(nodeId) {
    this.currentNodeId = nodeId;
    this.visitedNodeIds.push(nodeId);
  }

  aliveSquad() { return this.squad.filter(u => u.hp > 0); }
}

/* =============================================================
   MAP GENERATOR
   Produces rows of 2-3 nodes, connected forward 1-2.
   Ensures every row is reachable.
   ============================================================= */
const MapGen = {
  generate(rng) {
    const params = BC.MAP_PARAMS;
    const nodes = [];
    const edges = [];
    const rows = [];

    let nodeCounter = 0;
    const makeId = () => `n${nodeCounter++}`;

    // Start (row -1, conceptual) — we just pick first row as starts
    for (let r = 0; r <= params.rows - 1; r++) {
      const isBoss = r === params.rows - 1;
      const cols = isBoss ? 1 : rng.range(params.minCols, params.maxCols);
      const row = [];
      for (let c = 0; c < cols; c++) {
        const id = makeId();
        let kind = 'battle';
        if (isBoss) kind = 'boss';
        else kind = MapGen.pickKind(rng, r);
        const node = { id, row: r, col: c, kind, template: null };
        MapGen.assignTemplate(node, rng);
        nodes.push(node);
        row.push(id);
      }
      rows.push(row);
    }

    // Edges: each non-last-row node connects to 1-2 nodes in next row
    for (let r = 0; r < rows.length - 1; r++) {
      const curr = rows[r];
      const next = rows[r + 1];
      const reached = new Set();

      curr.forEach((fromId, i) => {
        // Connect to 1-2 next-row nodes biased by column index
        const numConn = rng.range(1, Math.min(2, next.length));
        const picks = new Set();
        // bias: nearest index first
        const order = next
          .map((id, j) => ({ id, j, dist: Math.abs(j - Math.floor(i * next.length / curr.length)) }))
          .sort((a, b) => a.dist - b.dist || rng.next() - 0.5)
          .slice(0, numConn);
        order.forEach(o => picks.add(o.id));
        picks.forEach(toId => {
          edges.push({ from: fromId, to: toId });
          reached.add(toId);
        });
      });

      // Guarantee every next-row node is reachable
      next.forEach(id => {
        if (!reached.has(id)) {
          const from = curr[rng.int(curr.length)];
          edges.push({ from, to: id });
        }
      });
    }

    return { nodes, edges, rows };
  },

  pickKind(rng, r) {
    const profile = BC.MAP_PARAMS.rowProfiles[r] || BC.MAP_PARAMS.rowProfiles[BC.MAP_PARAMS.rowProfiles.length - 1];
    const total = profile.battle + profile.elite + profile.rest + profile.reward;
    let roll = rng.int(total);
    if ((roll -= profile.battle) < 0) return 'battle';
    if ((roll -= profile.elite)  < 0) return 'elite';
    if ((roll -= profile.rest)   < 0) return 'rest';
    return 'reward';
  },

  assignTemplate(node, rng) {
    switch (node.kind) {
      case 'battle': node.template = rng.pick(BC.MAP_PARAMS.battleTemplates); break;
      case 'elite':  node.template = rng.pick(BC.MAP_PARAMS.eliteTemplates); break;
      case 'boss':   node.template = BC.MAP_PARAMS.bossTemplate; break;
      default:       node.template = null;
    }
  }
};

/* =============================================================
   4. BATTLE
   Battle.data holds all state. Methods mutate data.
   data is plain JSON so structuredClone works for undo/save.
   ============================================================= */
class Battle {
  constructor(data) { this.data = data; }

  /* ---------- Construction ---------- */
  static create(template, squad, relics, seed) {
    const rng = makeRng(seed);
    const size = template.size;

    // Build grid
    const grid = [];
    for (let y = 0; y < size; y++) {
      const row = [];
      for (let x = 0; x < size; x++) row.push({ type: 'floor' });
      grid.push(row);
    }

    // Place hazards in random non-overlapping positions, avoiding player spawn column (x=0)
    const used = new Set();
    const key = (x,y) => `${x},${y}`;
    const spawnCols = [0];
    const enemyCols = [size - 1];

    function placeTile(type, count, dir) {
      let tries = 0;
      while (count > 0 && tries < 200) {
        tries++;
        const x = rng.int(size);
        const y = rng.int(size);
        if (spawnCols.includes(x) || enemyCols.includes(x)) continue;
        if (used.has(key(x,y))) continue;
        const tile = { type };
        if (type === 'vent') tile.dir = rng.int(4);
        grid[y][x] = tile;
        used.add(key(x,y));
        count--;
      }
    }
    template.hazards.forEach(h => placeTile(h.type, h.count));

    // Place player units on x=0, spread across y
    const squadAlive = squad.filter(u => u.hp > 0);
    const playerYs = Battle.spreadYs(size, squadAlive.length, rng);
    const units = [];
    squadAlive.forEach((u, i) => {
      const cls = BC.CLASSES[u.classId];
      units.push({
        id: u.id,
        team: 'player',
        classId: u.classId,
        name: cls.name,
        x: 0, y: playerYs[i],
        hp: u.hp,
        maxHp: u.maxHp,
        move: u.move,
        shield: 0,
        hasMoved: false,
        hasActed: false,
        cooldowns: {},
        statuses: [],
      });
    });

    // Place enemies on x=size-1, spread
    const enemyYs = Battle.spreadYs(size, template.enemies.length, rng);
    template.enemies.forEach((eid, i) => {
      const e = BC.ENEMIES[eid];
      units.push({
        id: `e${i}`,
        team: 'enemy',
        kindId: eid,
        name: e.name,
        x: size - 1, y: enemyYs[i],
        hp: e.maxHp, maxHp: e.maxHp,
        move: e.move,
        shield: 0,
        statuses: [],
        intent: null,
      });
    });

    // Apply relic stat hooks that modify max hp / move
    relics.forEach(rid => {
      const relic = BC.RELICS[rid];
      if (relic && typeof relic.apply === 'function') {
        units.filter(u => u.team === 'player').forEach(u => relic.apply(u));
      }
    });

    const data = {
      size,
      grid,
      units,
      turn: 1,
      phase: 'start_of_turn',
      seed,
      rngState: rng.seed,
      relics: relics.slice(),
      templateId: template.id,
      log: [],
      result: null,            // 'victory' | 'defeat' | null
      endOfPlayerActionsQueued: false,
    };

    const b = new Battle(data);
    // Compute initial intents for turn 1
    b.recomputeIntents();
    // Enter the first phase via the PhaseMachine so state is immediately playable.
    // (PhaseMachine is defined below; we defer via microtask? No — it's defined
    //  in the same IIFE, at load time. We can reference it directly.)
    PhaseMachine.enter(b, Phases.START_OF_TURN);
    return b;
  }

  static spreadYs(size, n, rng) {
    const step = Math.floor(size / (n + 1));
    const ys = [];
    for (let i = 0; i < n; i++) ys.push(step * (i + 1));
    // slight jitter
    return ys.map(y => Math.max(0, Math.min(size - 1, y + (rng.int(3) - 1))));
  }

  /* ---------- Serialization ---------- */
  serialize() { return structuredClone(this.data); }
  static deserialize(obj) { return new Battle(structuredClone(obj)); }

  snapshot() { return structuredClone(this.data); }
  restore(snap) { this.data = structuredClone(snap); }

  /* ---------- Accessors ---------- */
  get turn() { return this.data.turn; }
  get phase() { return this.data.phase; }
  get units() { return this.data.units; }
  get size() { return this.data.size; }

  tileAt(x, y) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return null;
    return this.data.grid[y][x];
  }
  setTile(x, y, tile) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    this.data.grid[y][x] = tile;
  }
  tileRule(tile) { return BC.TILES[tile.type] || BC.TILES.floor; }

  unitAt(x, y) { return this.units.find(u => u.hp > 0 && u.x === x && u.y === y); }
  unitById(id) { return this.units.find(u => u.id === id); }
  alivePlayers() { return this.units.filter(u => u.team === 'player' && u.hp > 0); }
  aliveEnemies() { return this.units.filter(u => u.team === 'enemy' && u.hp > 0); }

  isPassable(x, y, forUnit) {
    const t = this.tileAt(x, y);
    if (!t) return false;
    if (this.tileRule(t).solid) return false;
    const u = this.unitAt(x, y);
    if (u && u !== forUnit) return false;
    return true;
  }
  // For LoS / ranged — walls block, pits don't
  blocksLine(x, y) {
    const t = this.tileAt(x, y);
    if (!t) return true;
    return !!this.tileRule(t).blocks;
  }

  manhattan(a, b) { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }
  chebyshev(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }

  /* ---------- Line of sight (Bresenham) ---------- */
  hasLine(a, b) {
    let x0 = a.x, y0 = a.y, x1 = b.x, y1 = b.y;
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    while (!(x0 === x1 && y0 === y1)) {
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 <  dx) { err += dx; y0 += sy; }
      if (x0 === x1 && y0 === y1) break;
      if (this.blocksLine(x0, y0)) return false;
    }
    return true;
  }

  /* ---------- Direction helpers ---------- */
  dirFromTo(a, b) {
    const dx = Math.sign(b.x - a.x);
    const dy = Math.sign(b.y - a.y);
    // prefer cardinal direction with larger delta
    if (Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)) return { dx, dy: 0 };
    return { dx: 0, dy };
  }

  /* ---------- Pathfinding (BFS respecting solids & hazards) ---------- */
  // Returns a path (list of {x,y}) up to maxSteps long toward target, avoiding pits/spikes if possible.
  pathToward(from, target, maxSteps) {
    const size = this.size;
    const start = { x: from.x, y: from.y };
    const goal  = { x: target.x, y: target.y };
    const visited = new Map();
    const prev = new Map();
    const scoreOf = (t) => {
      if (t.type === 'pit') return 50;
      if (t.type === 'spike') return 6;
      return 1;
    };
    const k = (x,y) => `${x},${y}`;
    const queue = [[start, 0]];
    visited.set(k(start.x, start.y), 0);

    while (queue.length) {
      queue.sort((a,b) => a[1] - b[1]);
      const [cur, cost] = queue.shift();
      if (cur.x === goal.x && cur.y === goal.y) break;
      for (const d of BC.DIRS) {
        const nx = cur.x + d.dx, ny = cur.y + d.dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const t = this.tileAt(nx, ny);
        if (!t) continue;
        if (this.tileRule(t).solid) continue;
        const u = this.unitAt(nx, ny);
        if (u && u !== from && u !== target) continue; // blocked by other units
        // treat goal tile as passable even if target on it
        const nc = cost + scoreOf(t);
        const key = k(nx, ny);
        if (visited.has(key) && visited.get(key) <= nc) continue;
        visited.set(key, nc);
        prev.set(key, cur);
        queue.push([{ x: nx, y: ny }, nc]);
      }
    }

    // Reconstruct
    const path = [];
    let cur = goal;
    if (!visited.has(k(goal.x, goal.y))) {
      // unreachable — step toward with best-effort
      return this.bestEffortStep(from, target, maxSteps);
    }
    while (!(cur.x === start.x && cur.y === start.y)) {
      path.unshift(cur);
      const p = prev.get(k(cur.x, cur.y));
      if (!p) break;
      cur = p;
    }
    // Truncate to maxSteps. Stop one tile before target if target occupied.
    const occupiedGoal = this.unitAt(goal.x, goal.y) && this.unitAt(goal.x, goal.y) !== from;
    let out = path.slice(0, maxSteps);
    if (occupiedGoal && out.length && out[out.length - 1].x === goal.x && out[out.length - 1].y === goal.y) {
      out.pop();
    }
    return out;
  }

  bestEffortStep(from, target, maxSteps) {
    // Just greedily step toward, for ornamental "tried to move" behavior.
    const out = [];
    let cur = { x: from.x, y: from.y };
    for (let i = 0; i < maxSteps; i++) {
      const d = this.dirFromTo(cur, target);
      const nx = cur.x + d.dx, ny = cur.y + d.dy;
      if (nx === cur.x && ny === cur.y) break;
      if (!this.isPassable(nx, ny, from)) break;
      cur = { x: nx, y: ny };
      out.push(cur);
    }
    return out;
  }

  stepAway(from, target) {
    // Try cardinal moves away from target, pick first passable safe one.
    const candidates = BC.DIRS
      .map(d => ({ x: from.x + d.dx, y: from.y + d.dy, d }))
      .filter(c => this.isPassable(c.x, c.y, from))
      .sort((a, b) => this.manhattan(b, target) - this.manhattan(a, target));
    return candidates[0] || null;
  }

  nearestPlayer(enemy) {
    const players = this.alivePlayers();
    let best = null, bestD = 1e9;
    for (const p of players) {
      const d = this.manhattan(enemy, p);
      if (d < bestD) { best = p; bestD = d; }
    }
    return best;
  }

  playersAdjacent(enemy) {
    return this.alivePlayers().filter(p => this.manhattan(p, enemy) === 1);
  }

  /* ---------- Tiles in range (for ability targeting) ---------- */
  tilesInRange(unit, range, needsLoS) {
    const out = [];
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (x === unit.x && y === unit.y) continue;
        const d = this.manhattan({x,y}, unit);
        if (d === 0 || d > range) continue;
        if (needsLoS && !this.hasLine(unit, {x,y})) continue;
        out.push({ x, y });
      }
    }
    return out;
  }

  reachableTiles(unit) {
    // BFS move
    const size = this.size;
    const visited = new Map();
    visited.set(`${unit.x},${unit.y}`, 0);
    const q = [{ x: unit.x, y: unit.y, d: 0 }];
    while (q.length) {
      const cur = q.shift();
      if (cur.d >= unit.move) continue;
      for (const dir of BC.DIRS) {
        const nx = cur.x + dir.dx, ny = cur.y + dir.dy;
        const key = `${nx},${ny}`;
        if (visited.has(key)) continue;
        if (!this.isPassable(nx, ny, unit)) continue;
        // Players shouldn't auto-walk onto pits/spikes via normal movement.
        const t = this.tileAt(nx, ny);
        const rule = this.tileRule(t);
        if (rule.id === 'pit') continue;
        visited.set(key, cur.d + 1);
        q.push({ x: nx, y: ny, d: cur.d + 1 });
      }
    }
    const out = [];
    for (const [k, d] of visited) {
      if (d === 0) continue;
      const [x, y] = k.split(',').map(Number);
      out.push({ x, y, cost: d });
    }
    return out;
  }

  /* ---------- Mutations ---------- */
  log(msg, cls = '') {
    this.data.log.push({ msg, cls, t: this.data.turn });
    if (this.data.log.length > 60) this.data.log.shift();
  }

  damageUnit(unit, amount, source) {
    if (unit.hp <= 0) return;
    let dmg = amount;
    if (unit.shield > 0) {
      const absorbed = Math.min(unit.shield, dmg);
      unit.shield -= absorbed;
      dmg -= absorbed;
      if (absorbed > 0) this.log(`${unit.name} absorbs ${absorbed} (shield).`, 'ok');
    }
    if (dmg > 0) {
      unit.hp -= dmg;
      this.log(`${unit.name} takes ${dmg} from ${source}.`, 'hit');
    }
    if (unit.hp <= 0) {
      unit.hp = 0;
      this.log(`${unit.name} is down.`, 'hit');
    }
  }

  healUnit(unit, amount, source) {
    if (unit.hp <= 0) return;
    const before = unit.hp;
    unit.hp = Math.min(unit.maxHp, unit.hp + amount);
    this.log(`${unit.name} repaired +${unit.hp - before} by ${source}.`, 'ok');
  }

  killUnit(unit, source) {
    unit.hp = 0;
    this.log(`${unit.name} eliminated by ${source}.`, 'hit');
  }

  moveUnit(unit, path) {
    // path: list of {x,y} tiles the unit steps through in order
    for (const step of path) {
      unit.x = step.x; unit.y = step.y;
      const tile = this.tileAt(step.x, step.y);
      const rule = this.tileRule(tile);
      if (rule.onEnter) rule.onEnter(this, unit);
      if (unit.hp <= 0) break;
    }
  }

  /* ---------- Push / pull ---------- */
  push(unit, dx, dy, dist, source) {
    if (unit.hp <= 0) return;
    for (let i = 0; i < dist; i++) {
      const nx = unit.x + dx, ny = unit.y + dy;
      const t = this.tileAt(nx, ny);
      // off-grid = wall (blocked, take 1 dmg)
      if (!t) {
        this.damageUnit(unit, 1, `${source} (wall)`);
        return;
      }
      const rule = this.tileRule(t);
      if (rule.solid) {
        this.damageUnit(unit, 1, `${source} (wall)`);
        return;
      }
      const occupant = this.unitAt(nx, ny);
      if (occupant) {
        // collision — both take 1
        this.damageUnit(unit, 1, `${source} (collision)`);
        this.damageUnit(occupant, 1, `${source} (collision)`);
        return;
      }
      unit.x = nx; unit.y = ny;
      if (rule.onEnter) rule.onEnter(this, unit);
      if (unit.hp <= 0) return;
    }
  }

  /* ---------- Intents ---------- */
  recomputeIntents() {
    const enemies = this.aliveEnemies();
    for (const e of enemies) {
      const kind = BC.ENEMIES[e.kindId];
      const planFn = BC.ENEMY_PLANS[kind.plan];
      e.intent = planFn ? planFn(this, e) : { kind: 'wait', desc: 'Wait' };
    }
  }

  /* ---------- Player action commits ---------- */
  resetPlayerFlags() {
    for (const u of this.alivePlayers()) {
      u.hasMoved = false;
      u.hasActed = false;
      // decrement cooldowns at start of each player turn
      for (const k of Object.keys(u.cooldowns)) {
        if (u.cooldowns[k] > 0) u.cooldowns[k]--;
      }
      // shield decays
      u.shield = 0;
    }
  }

  /* ---------- Victory / defeat ---------- */
  checkResult() {
    if (this.alivePlayers().length === 0) this.data.result = 'defeat';
    else if (this.aliveEnemies().length === 0) this.data.result = 'victory';
  }
}

/* =============================================================
   5. PHASE MACHINE
   Explicit enumerated phases drive the turn.
   ============================================================= */
const Phases = Object.freeze({
  START_OF_TURN:   'start_of_turn',
  PLAYER_INPUT:    'player_input',
  ENEMY_MOVE:      'enemy_move',
  ENEMY_ATTACK:    'enemy_attack',
  END_OF_TURN:     'end_of_turn',
  DEATH_CLEANUP:   'death_cleanup',
  RESULT:          'result',
});

const PhaseMachine = {
  enter(battle, phase) {
    battle.data.phase = phase;
    switch (phase) {
      case Phases.START_OF_TURN:
        // Start of turn effects (shield, cooldowns, etc.) and reset flags.
        battle.resetPlayerFlags();
        battle.log(`-- Turn ${battle.turn} --`);
        // Transition to player input
        return this.enter(battle, Phases.PLAYER_INPUT);

      case Phases.PLAYER_INPUT:
        // Wait for player to end turn. UI layer drives this.
        return;

      case Phases.ENEMY_MOVE:
        AI.executeMoves(battle);
        return this.enter(battle, Phases.ENEMY_ATTACK);

      case Phases.ENEMY_ATTACK:
        AI.executeAttacks(battle);
        return this.enter(battle, Phases.END_OF_TURN);

      case Phases.END_OF_TURN:
        // Tiles with onEndTurn trigger for units standing on them (vent, etc.)
        for (const u of battle.units.slice()) {
          if (u.hp <= 0) continue;
          const t = battle.tileAt(u.x, u.y);
          const rule = battle.tileRule(t);
          if (rule.onEndTurn) rule.onEndTurn(battle, u, t);
        }
        return this.enter(battle, Phases.DEATH_CLEANUP);

      case Phases.DEATH_CLEANUP:
        battle.checkResult();
        if (battle.data.result) return this.enter(battle, Phases.RESULT);
        // Next turn
        battle.data.turn++;
        battle.recomputeIntents();
        return this.enter(battle, Phases.START_OF_TURN);

      case Phases.RESULT:
        return;
    }
  },

  // Called by UI when player clicks End Turn
  playerEndTurn(battle) {
    // Player forced-movement and hazards already resolved during actions.
    // Enter enemy phase.
    this.enter(battle, Phases.ENEMY_MOVE);
  }
};

/* =============================================================
   6. AI — enemy intent execution
   ============================================================= */
const AI = {
  executeMoves(battle) {
    for (const e of battle.aliveEnemies()) {
      const it = e.intent;
      if (!it) continue;
      if (it.kind === 'move' || it.kind === 'move_attack' || it.kind === 'move_push' || it.kind === 'hazard_drop') {
        if (it.path && it.path.length) {
          // trim path to valid (re-check because player actions may have changed world)
          const validPath = [];
          let cur = { x: e.x, y: e.y };
          for (const step of it.path) {
            if (battle.isPassable(step.x, step.y, e)) {
              const t = battle.tileAt(step.x, step.y);
              if (battle.tileRule(t).id === 'pit') break; // don't walk into pit
              cur = step;
              validPath.push(step);
            } else break;
          }
          battle.moveUnit(e, validPath);
        }
      }
    }
  },

  executeAttacks(battle) {
    for (const e of battle.aliveEnemies().slice()) {
      const it = e.intent;
      if (!it) continue;
      const target = it.targetId ? battle.unitById(it.targetId) : null;

      switch (it.kind) {
        case 'attack':
        case 'move_attack': {
          if (target && target.hp > 0) {
            // For ranged, still need LoS; for melee, must be adjacent
            if (it.ranged && !battle.hasLine(e, target)) {
              battle.log(`${e.name} loses sight of ${target.name}.`, 'enemy');
            } else if (!it.ranged && battle.manhattan(e, target) !== 1) {
              battle.log(`${e.name} can't reach ${target.name}.`, 'enemy');
            } else {
              battle.log(`${e.name} attacks ${target.name}.`, 'enemy');
              battle.damageUnit(target, it.dmg || 1, e.name);
            }
          }
          break;
        }
        case 'push_attack':
        case 'move_push': {
          if (target && target.hp > 0 && battle.manhattan(e, target) === 1) {
            battle.log(`${e.name} slams ${target.name}.`, 'enemy');
            battle.damageUnit(target, it.dmg || 1, e.name);
            if (it.pushDir) battle.push(target, it.pushDir.dx, it.pushDir.dy, it.pushDist || 1, e.name);
          }
          break;
        }
        case 'aoe_adjacent': {
          const hits = battle.playersAdjacent(e);
          if (hits.length) {
            battle.log(`${e.name} pulses.`, 'enemy');
            for (const h of hits) battle.damageUnit(h, it.dmg || 1, e.name);
          }
          break;
        }
        case 'hazard_drop': {
          // Drop on target's CURRENT tile (so player could move away to dodge).
          // The spike activates on NEXT entry, so a player sitting there now
          // isn't punished this turn but will be if they step back.
          if (target) {
            const t = battle.tileAt(target.x, target.y);
            if (t && t.type === 'floor') {
              battle.setTile(target.x, target.y, { type: it.tile || 'spike' });
              battle.log(`${e.name} drops ${it.tile} on ${target.name}'s tile.`, 'enemy');
            } else {
              battle.log(`${e.name}'s drop fails (blocked tile).`, 'enemy');
            }
          }
          break;
        }
        case 'summon': {
          // spawn adjacent
          const kind = BC.ENEMIES[it.summonKind];
          if (!kind) break;
          const spots = BC.DIRS
            .map(d => ({ x: e.x + d.dx, y: e.y + d.dy }))
            .filter(p => battle.tileAt(p.x, p.y) && !battle.tileRule(battle.tileAt(p.x,p.y)).solid && !battle.unitAt(p.x,p.y));
          if (spots.length) {
            const s = spots[0];
            const newId = `e_s${battle.data.turn}_${battle.units.length}`;
            battle.units.push({
              id: newId, team: 'enemy', kindId: it.summonKind, name: kind.name,
              x: s.x, y: s.y, hp: kind.maxHp, maxHp: kind.maxHp, move: kind.move,
              shield: 0, statuses: [], intent: null
            });
            battle.log(`${e.name} summons a ${kind.name}.`, 'enemy');
          }
          break;
        }
      }
    }
  }
};

/* =============================================================
   7. RENDERER — pure reader
   ============================================================= */
const Renderer = {
  boardCanvas: null,
  mapCanvas: null,
  ctx: null,
  mctx: null,
  cellPx: 48,
  boardOffset: { x: 0, y: 0 },

  initBoard(canvas) {
    this.boardCanvas = canvas;
    this.ctx = canvas.getContext('2d');
  },
  initMap(canvas) {
    this.mapCanvas = canvas;
    this.mctx = canvas.getContext('2d');
  },

  resizeBoard(battle) {
    const c = this.boardCanvas;
    const parent = c.parentElement;
    const pw = parent.clientWidth;
    const ph = parent.clientHeight;
    const size = battle.size;
    const maxCell = Math.floor(Math.min(pw, ph) / size) - 2;
    this.cellPx = Math.max(24, maxCell);
    const boardPx = this.cellPx * size;
    const dpr = window.devicePixelRatio || 1;
    c.width = boardPx * dpr;
    c.height = boardPx * dpr;
    c.style.width = boardPx + 'px';
    c.style.height = boardPx + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  },

  drawBattle(battle, selection) {
    if (!this.ctx) return;
    this.resizeBoard(battle);
    const ctx = this.ctx;
    const cp = this.cellPx;
    const size = battle.size;
    const px = size * cp;

    // background
    ctx.fillStyle = '#0a1120';
    ctx.fillRect(0, 0, px, px);

    // Grid + tiles
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const t = battle.tileAt(x, y);
        const X = x * cp, Y = y * cp;
        // base cell
        ctx.fillStyle = (x + y) % 2 === 0 ? '#10192c' : '#0e1526';
        ctx.fillRect(X, Y, cp, cp);
        ctx.strokeStyle = '#1a2540';
        ctx.lineWidth = 1;
        ctx.strokeRect(X + 0.5, Y + 0.5, cp - 1, cp - 1);
        // tile type
        this.drawTile(ctx, t, X, Y, cp);
      }
    }

    // Highlights: movable tiles
    if (selection && selection.kind === 'move' && selection.tiles) {
      ctx.fillStyle = 'rgba(100,210,255,0.18)';
      ctx.strokeStyle = 'rgba(100,210,255,0.6)';
      for (const t of selection.tiles) {
        ctx.fillRect(t.x * cp + 3, t.y * cp + 3, cp - 6, cp - 6);
        ctx.strokeRect(t.x * cp + 3.5, t.y * cp + 3.5, cp - 7, cp - 7);
      }
    }
    // Highlights: ability targets
    if (selection && selection.kind === 'ability' && selection.tiles) {
      ctx.fillStyle = 'rgba(255,179,71,0.14)';
      ctx.strokeStyle = 'rgba(255,179,71,0.7)';
      for (const t of selection.tiles) {
        ctx.fillRect(t.x * cp + 3, t.y * cp + 3, cp - 6, cp - 6);
        ctx.strokeRect(t.x * cp + 3.5, t.y * cp + 3.5, cp - 7, cp - 7);
      }
    }

    // Selected unit outline
    if (selection && selection.unit) {
      const u = selection.unit;
      ctx.strokeStyle = '#64d2ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(u.x * cp + 2, u.y * cp + 2, cp - 4, cp - 4);
    }

    // Enemy intents first (under units)
    for (const e of battle.aliveEnemies()) {
      this.drawIntent(ctx, battle, e, cp);
    }

    // Units
    for (const u of battle.units) {
      if (u.hp <= 0) continue;
      this.drawUnit(ctx, u, cp);
    }
  },

  drawTile(ctx, t, X, Y, cp) {
    if (t.type === 'floor') return;
    const pad = 4;
    switch (t.type) {
      case 'wall':
        ctx.fillStyle = '#2d3a5c';
        ctx.fillRect(X + 2, Y + 2, cp - 4, cp - 4);
        ctx.strokeStyle = '#4b5c8a';
        ctx.strokeRect(X + 2.5, Y + 2.5, cp - 5, cp - 5);
        // cross hatch
        ctx.strokeStyle = '#3e4f7a';
        ctx.beginPath();
        ctx.moveTo(X + pad, Y + pad); ctx.lineTo(X + cp - pad, Y + cp - pad);
        ctx.moveTo(X + cp - pad, Y + pad); ctx.lineTo(X + pad, Y + cp - pad);
        ctx.stroke();
        break;
      case 'pit':
        ctx.fillStyle = '#050810';
        ctx.fillRect(X + 4, Y + 4, cp - 8, cp - 8);
        ctx.strokeStyle = '#1a2540';
        ctx.strokeRect(X + 4.5, Y + 4.5, cp - 9, cp - 9);
        break;
      case 'spike':
        ctx.fillStyle = '#2a1020';
        ctx.fillRect(X + 2, Y + 2, cp - 4, cp - 4);
        ctx.strokeStyle = '#ff6b6b';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const n = 3;
        for (let i = 0; i < n; i++) {
          const bx = X + pad + i * ((cp - pad * 2) / n);
          const tip = bx + ((cp - pad * 2) / n) / 2;
          ctx.moveTo(bx, Y + cp - pad);
          ctx.lineTo(tip, Y + pad + 2);
          ctx.lineTo(bx + (cp - pad * 2) / n, Y + cp - pad);
        }
        ctx.stroke();
        break;
      case 'vent':
        ctx.fillStyle = '#102033';
        ctx.fillRect(X + 2, Y + 2, cp - 4, cp - 4);
        ctx.strokeStyle = '#64d2ff';
        ctx.lineWidth = 1;
        // arrow indicating direction
        const d = BC.DIRS[t.dir ?? 1];
        const cx = X + cp / 2, cy = Y + cp / 2;
        ctx.beginPath();
        ctx.moveTo(cx - d.dx * cp * 0.25, cy - d.dy * cp * 0.25);
        ctx.lineTo(cx + d.dx * cp * 0.25, cy + d.dy * cp * 0.25);
        // arrow head
        const hx = cx + d.dx * cp * 0.25;
        const hy = cy + d.dy * cp * 0.25;
        const perpX = -d.dy, perpY = d.dx;
        ctx.moveTo(hx, hy);
        ctx.lineTo(hx - d.dx * 6 + perpX * 4, hy - d.dy * 6 + perpY * 4);
        ctx.moveTo(hx, hy);
        ctx.lineTo(hx - d.dx * 6 - perpX * 4, hy - d.dy * 6 - perpY * 4);
        ctx.stroke();
        break;
    }
  },

  drawUnit(ctx, u, cp) {
    const X = u.x * cp, Y = u.y * cp;
    const cx = X + cp / 2, cy = Y + cp / 2;
    const r = cp * 0.36;
    const isPlayer = u.team === 'player';
    const tpl = isPlayer ? BC.CLASSES[u.classId] : BC.ENEMIES[u.kindId];
    // outer glow
    ctx.beginPath();
    ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
    ctx.fillStyle = tpl.colour + '22';
    ctx.fill();
    // body
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = isPlayer ? '#0e1526' : '#1a1020';
    ctx.fill();
    ctx.strokeStyle = tpl.colour;
    ctx.lineWidth = 2;
    ctx.stroke();
    // glyph
    ctx.fillStyle = tpl.colour;
    ctx.font = `bold ${Math.floor(cp * 0.4)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tpl.glyph, cx, cy + 1);

    // HP bar
    const bw = cp * 0.7, bh = 4;
    const bx = cx - bw / 2, by = Y + cp - 8;
    ctx.fillStyle = '#050810';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = isPlayer ? '#7bdc9c' : '#ff6b6b';
    ctx.fillRect(bx, by, bw * (u.hp / u.maxHp), bh);
    ctx.strokeStyle = '#1a2540';
    ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);

    // shield indicator
    if (u.shield > 0) {
      ctx.fillStyle = '#64d2ff';
      ctx.font = `bold ${Math.floor(cp * 0.22)}px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillText(`+${u.shield}`, X + 4, Y + cp * 0.22);
    }
  },

  drawIntent(ctx, battle, e, cp) {
    const it = e.intent;
    if (!it) return;
    ctx.save();
    ctx.strokeStyle = '#ffb347';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);

    // Draw movement path
    if (it.path && it.path.length) {
      ctx.beginPath();
      ctx.moveTo(e.x * cp + cp/2, e.y * cp + cp/2);
      for (const step of it.path) {
        ctx.lineTo(step.x * cp + cp/2, step.y * cp + cp/2);
      }
      ctx.stroke();
    }

    ctx.setLineDash([]);

    // Draw target marker
    const target = it.targetId ? battle.unitById(it.targetId) : null;
    if (target && target.hp > 0 && (it.kind === 'attack' || it.kind === 'move_attack' ||
                                     it.kind === 'push_attack' || it.kind === 'move_push' ||
                                     it.kind === 'hazard_drop')) {
      // crosshair
      const tx = target.x * cp, ty = target.y * cp;
      ctx.strokeStyle = '#ffb347';
      ctx.lineWidth = 2;
      ctx.strokeRect(tx + 2, ty + 2, cp - 4, cp - 4);
      // damage label
      if (it.dmg) {
        ctx.fillStyle = 'rgba(255,179,71,0.9)';
        ctx.font = `bold ${Math.floor(cp * 0.28)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        const label = (it.pushDist ? `${it.dmg}↗` : `${it.dmg}`);
        ctx.fillText(label, tx + cp / 2, ty + cp * 0.3);
      }
    }

    if (it.kind === 'aoe_adjacent') {
      // ring around self
      ctx.strokeStyle = '#ffb34777';
      for (const d of BC.DIRS) {
        const nx = e.x + d.dx, ny = e.y + d.dy;
        if (battle.tileAt(nx, ny)) {
          ctx.strokeRect(nx * cp + 3, ny * cp + 3, cp - 6, cp - 6);
        }
      }
    }

    ctx.restore();
  },

  /* ---------- Run map ---------- */
  resizeMap() {
    const c = this.mapCanvas;
    const parent = c.parentElement;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = h * dpr;
    c.style.width = w + 'px'; c.style.height = h + 'px';
    this.mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  },

  drawMap(run) {
    if (!this.mctx) return;
    this.resizeMap();
    const ctx = this.mctx;
    const c = this.mapCanvas;
    const w = c.clientWidth, h = c.clientHeight;

    ctx.clearRect(0, 0, w, h);

    // Layout nodes by row/col
    const map = run.map;
    const rows = map.rows.length;
    const marginY = 40;
    const rowStep = (h - marginY * 2) / Math.max(1, rows - 1);
    const positions = {};
    map.rows.forEach((row, rIdx) => {
      const cols = row.length;
      const marginX = 40;
      const colStep = (w - marginX * 2) / Math.max(1, cols);
      row.forEach((nid, cIdx) => {
        const x = marginX + colStep * (cIdx + 0.5);
        const y = h - (marginY + rIdx * rowStep); // row 0 at bottom
        positions[nid] = { x, y };
      });
    });

    // Edges
    const available = new Set(run.availableNodes().map(n => n.id));
    ctx.lineWidth = 2;
    for (const e of map.edges) {
      const a = positions[e.from], b = positions[e.to];
      if (!a || !b) continue;
      const isLive = available.has(e.to) && (run.currentNodeId === e.from || (!run.currentNodeId && run.map.rows[0].includes(e.to)));
      ctx.strokeStyle = isLive ? 'rgba(100,210,255,0.55)' : 'rgba(100,130,180,0.2)';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Nodes
    for (const n of map.nodes) {
      const p = positions[n.id];
      if (!p) continue;
      const isAvail = available.has(n.id);
      const isVisited = run.visitedNodeIds.includes(n.id);
      const isCurrent = run.currentNodeId === n.id;

      const r = 20;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      let fill = '#131c2f', stroke = '#2e3e63';
      if (isCurrent)       { fill = '#0e2a3c'; stroke = '#64d2ff'; }
      else if (isAvail)    { fill = '#103247'; stroke = '#64d2ff'; }
      else if (isVisited)  { fill = '#0a1120'; stroke = '#8a97b4'; }
      ctx.fillStyle = fill; ctx.fill();
      ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke();

      ctx.fillStyle = isAvail || isCurrent ? '#eafaff' : '#8a97b4';
      ctx.font = 'bold 14px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const iconMap = { battle: '⚔', elite: '★', rest: '+', reward: '◆', boss: '☠' };
      ctx.fillText(iconMap[n.kind] || '?', p.x, p.y + 1);
    }

    this._mapPositions = positions;
  }
};

/* =============================================================
   8. INPUT
   ============================================================= */
const Input = {
  battle: null,
  selection: null,           // { unit, kind: 'move'|'ability', abilityId?, tiles:[] }

  bindBoard(canvas, getBattle, onChange) {
    this.getBattle = getBattle;
    this.onChange = onChange;
    const handler = (evt) => {
      evt.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const pt = evt.touches ? evt.touches[0] : evt;
      const px = pt.clientX - rect.left;
      const py = pt.clientY - rect.top;
      const cp = Renderer.cellPx;
      const x = Math.floor(px / cp);
      const y = Math.floor(py / cp);
      this.onBoardTap(x, y);
    };
    canvas.addEventListener('click', handler);
    canvas.addEventListener('touchend', handler);
  },

  onBoardTap(x, y) {
    const battle = this.getBattle();
    if (!battle) return;
    if (battle.phase !== Phases.PLAYER_INPUT) return;
    const unitAtTile = battle.unitAt(x, y);

    // If an ability is selected, try to resolve on target tile
    if (this.selection && this.selection.kind === 'ability') {
      const ok = this.selection.tiles.some(t => t.x === x && t.y === y);
      if (ok) {
        this.commitAbility(x, y);
        return;
      }
      // Tapping non-target cancels ability back to unit selection
      this.setSelectionUnit(this.selection.unit);
      this.onChange();
      return;
    }

    // If a move is ongoing and tapped a movable tile
    if (this.selection && this.selection.kind === 'move') {
      const ok = this.selection.tiles.some(t => t.x === x && t.y === y);
      if (ok) {
        this.commitMove(x, y);
        return;
      }
    }

    // Otherwise, select a unit on the tile
    if (unitAtTile) {
      if (unitAtTile.team === 'player') {
        this.setSelectionUnit(unitAtTile);
      } else {
        // inspect enemy
        UI.showEnemyInfo(unitAtTile);
        return;
      }
    } else {
      this.selection = null;
      UI.showEmptyPanel();
    }
    this.onChange();
  },

  setSelectionUnit(unit) {
    const battle = this.getBattle();
    // Show move highlights if unit hasn't moved; otherwise just show unit info
    const tiles = unit.hasMoved ? [] : battle.reachableTiles(unit);
    this.selection = { unit, kind: 'move', tiles };
    UI.showUnitInfo(unit);
    UI.showAbilities(unit);
  },

  selectAbility(abilityId) {
    if (!this.selection) return;
    const unit = this.selection.unit;
    const battle = this.getBattle();
    if (unit.hasActed) return;
    if ((unit.cooldowns[abilityId] || 0) > 0) return;
    const ab = BC.ABILITIES[abilityId];
    if (!ab) return;

    if (ab.targetType === 'self' && ab.range === 0) {
      // resolve immediately
      this._resolveAbility(ab, unit, { x: unit.x, y: unit.y });
      return;
    }

    // compute legal target tiles
    const all = battle.tilesInRange(unit, ab.range, !!ab.needsLoS);
    const tiles = all.filter(t => {
      const occ = battle.unitAt(t.x, t.y);
      if (ab.targetType === 'enemy')  return occ && occ.team === 'enemy';
      if (ab.targetType === 'ally')   return occ && occ.team === 'player' && occ !== unit;
      if (ab.targetType === 'any')    return !!occ;
      if (ab.targetType === 'empty')  return !occ && battle.tileAt(t.x, t.y).type === 'floor';
      return true;
    });

    this.selection = { unit, kind: 'ability', abilityId, tiles };
    UI.markAbilitySelected(abilityId);
    this.onChange();
  },

  commitMove(x, y) {
    const battle = this.getBattle();
    const unit = this.selection.unit;
    // Save undo snapshot FIRST — before mutation
    undoStack.push(battle.snapshot());
    // Build path from unit to target using reachable BFS to get a real route
    const path = this._bfsPath(battle, unit, x, y);
    battle.moveUnit(unit, path);
    unit.hasMoved = true;
    battle.checkResult();
    // After move, re-select unit to show abilities; no move tiles now
    this.selection = { unit, kind: 'move', tiles: [] };
    UI.showUnitInfo(unit);
    UI.showAbilities(unit);
    UI.refreshUndo();
    this.onChange();
  },

  _bfsPath(battle, unit, tx, ty) {
    // Full BFS from unit to target respecting reachable rules
    const size = battle.size;
    const prev = new Map();
    const visited = new Set();
    const start = `${unit.x},${unit.y}`;
    visited.add(start);
    const q = [{ x: unit.x, y: unit.y }];
    while (q.length) {
      const cur = q.shift();
      if (cur.x === tx && cur.y === ty) break;
      for (const d of BC.DIRS) {
        const nx = cur.x + d.dx, ny = cur.y + d.dy;
        const key = `${nx},${ny}`;
        if (visited.has(key)) continue;
        if (!battle.isPassable(nx, ny, unit)) continue;
        const t = battle.tileAt(nx, ny);
        if (battle.tileRule(t).id === 'pit') continue;
        visited.add(key); prev.set(key, cur);
        q.push({ x: nx, y: ny });
      }
    }
    // Reconstruct
    const path = [];
    let cur = { x: tx, y: ty };
    while (!(cur.x === unit.x && cur.y === unit.y)) {
      path.unshift(cur);
      const p = prev.get(`${cur.x},${cur.y}`);
      if (!p) return [];
      cur = p;
    }
    return path;
  },

  _resolveAbility(ab, unit, tile) {
    const battle = this.getBattle();
    // Save undo snapshot FIRST
    undoStack.push(battle.snapshot());
    const target = battle.unitAt(tile.x, tile.y) || { x: tile.x, y: tile.y };
    ab.effect(battle, unit, target);
    unit.hasActed = true;
    unit.cooldowns[ab.id] = ab.cooldown || 0;
    battle.checkResult();
    // after acting, keep unit selected but no more actions
    this.selection = { unit, kind: 'move', tiles: [] };
    UI.showUnitInfo(unit);
    UI.showAbilities(unit);
    UI.refreshUndo();
    this.onChange();
    // If all player units are fully used, hint to end turn
    if (battle.alivePlayers().every(u => u.hasMoved && u.hasActed)) {
      UI.toast('All units acted. End turn when ready.');
    }
  },

  commitAbility(x, y) {
    const ab = BC.ABILITIES[this.selection.abilityId];
    this._resolveAbility(ab, this.selection.unit, { x, y });
  },
};

/* =============================================================
   UNDO STACK
   A single-step undo for the current player turn. Cleared when
   the enemy phase begins.
   ============================================================= */
const undoStack = {
  _stack: [],
  push(snap) {
    // depth 1: replace, don't grow.
    this._stack = [snap];
  },
  canUndo() { return this._stack.length > 0; },
  pop() { return this._stack.pop(); },
  clear() { this._stack = []; },
};

/* =============================================================
   9. UI — screen manager + HUD
   ============================================================= */
const UI = {
  run: null,
  battle: null,
  screen: 'title',

  elems: {},

  init() {
    this.elems.title    = document.getElementById('screen-title');
    this.elems.map      = document.getElementById('screen-map');
    this.elems.reward   = document.getElementById('screen-reward');
    this.elems.rest     = document.getElementById('screen-rest');
    this.elems.battle   = document.getElementById('screen-battle');
    this.elems.toast    = document.getElementById('toast');
    this.elems.turnNum  = document.getElementById('turn-num');
    this.elems.phaseBadge = document.getElementById('phase-badge');
    this.elems.unitPanel  = document.getElementById('unit-panel');
    this.elems.abilityBar = document.getElementById('ability-bar');
    this.elems.log       = document.getElementById('log');
    this.elems.squad     = document.getElementById('squad-summary');
    this.elems.scrap     = document.getElementById('map-scrap');
    this.elems.sector    = document.getElementById('map-sector');
    this.elems.mapHint   = document.getElementById('map-hint');
    this.elems.btnUndo   = document.getElementById('btn-undo');
    this.elems.btnEnd    = document.getElementById('btn-end-turn');
    this.elems.btnContinue = document.getElementById('btn-continue');
  },

  showScreen(name) {
    for (const k of ['title','map','reward','rest','battle']) {
      this.elems[k].classList.toggle('active', k === name);
    }
    this.screen = name;
  },

  toast(msg) {
    const t = this.elems.toast;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
  },

  /* ---------- Title ---------- */
  refreshTitle() {
    this.elems.btnContinue.hidden = !SaveIO.has();
  },

  /* ---------- Map ---------- */
  refreshMap() {
    const run = this.run;
    if (!run) return;
    this.elems.scrap.textContent = run.scrap;
    // Sector = highest row of visited nodes + 1 (1-indexed display)
    const maxRow = run.visitedNodeIds.length
      ? Math.max(...run.visitedNodeIds.map(id => run.map.nodes.find(n => n.id === id).row))
      : -1;
    this.elems.sector.textContent = (maxRow + 1);

    // Squad summary
    this.elems.squad.innerHTML = '';
    for (const u of run.squad) {
      const cls = BC.CLASSES[u.classId];
      const chip = document.createElement('div');
      chip.className = 'squad-chip' + (u.hp <= 0 ? ' dead' : '');
      chip.innerHTML = `<span class="dot" style="background:${cls.colour}"></span>${cls.glyph} ${u.hp}/${u.maxHp}`;
      this.elems.squad.appendChild(chip);
    }

    Renderer.drawMap(run);

    const avail = run.availableNodes();
    if (!avail.length) this.elems.mapHint.textContent = 'No path forward.';
    else this.elems.mapHint.textContent = `Choose your next node (${avail.length} option${avail.length>1?'s':''}).`;
  },

  bindMapTap() {
    const c = Renderer.mapCanvas;
    const handler = (evt) => {
      evt.preventDefault();
      const rect = c.getBoundingClientRect();
      const pt = evt.touches ? evt.changedTouches[0] : evt;
      const px = pt.clientX - rect.left;
      const py = pt.clientY - rect.top;
      const positions = Renderer._mapPositions || {};
      const avail = new Set(this.run.availableNodes().map(n => n.id));
      for (const [id, p] of Object.entries(positions)) {
        const dx = p.x - px, dy = p.y - py;
        if (Math.sqrt(dx*dx + dy*dy) <= 24 && avail.has(id)) {
          this.pickNode(id);
          return;
        }
      }
    };
    c.addEventListener('click', handler);
    c.addEventListener('touchend', handler);
  },

  pickNode(nodeId) {
    const run = this.run;
    run.visitNode(nodeId);
    const node = run.map.nodes.find(n => n.id === nodeId);
    SaveIO.save(run, null);
    if (node.kind === 'battle' || node.kind === 'elite' || node.kind === 'boss') {
      this.startBattle(node);
    } else if (node.kind === 'rest') {
      this.showRest();
    } else if (node.kind === 'reward') {
      this.showRewards('battle', node);
    }
  },

  /* ---------- Rest ---------- */
  showRest() {
    const container = document.getElementById('rest-options');
    container.innerHTML = '';
    const actions = [
      { title: 'Repair Squad', desc: 'Heal each unit by 4 HP.', act: () => {
          for (const u of this.run.squad) if (u.hp > 0) u.hp = Math.min(u.maxHp, u.hp + 4);
        }
      },
      { title: 'Overhaul', desc: 'Fully heal one unit to max HP.', act: () => {
          const u = this.run.squad.find(s => s.hp > 0 && s.hp < s.maxHp);
          if (u) u.hp = u.maxHp;
        }
      },
      { title: 'Push on', desc: 'Skip. Nothing gained.', act: () => {} },
    ];
    actions.forEach(a => {
      const card = document.createElement('div');
      card.className = 'reward-card';
      card.innerHTML = `<h3>${a.title}</h3><p>${a.desc}</p><span class="tag">Rest</span>`;
      card.addEventListener('click', () => {
        a.act();
        SaveIO.save(this.run, null);
        this.showScreen('map');
        this.refreshMap();
      });
      container.appendChild(card);
    });
    this.showScreen('rest');
  },

  /* ---------- Rewards ---------- */
  showRewards(kind, node) {
    const pool = BC.REWARD_POOL[kind === 'elite' ? 'elite' : 'battle'];
    // Pick 3 distinct relics
    const rng = makeRng((this.run.rng.seed ^ node.id.length) >>> 0);
    const options = rng.shuffle(pool.filter(id => !this.run.relics.includes(id))).slice(0, 3);
    const container = document.getElementById('reward-options');
    container.innerHTML = '';
    if (options.length === 0) {
      const card = document.createElement('div');
      card.className = 'reward-card';
      card.innerHTML = `<h3>Scrap</h3><p>No new upgrades available. Take 10 scrap.</p><span class="tag">Consolation</span>`;
      card.addEventListener('click', () => { this.run.scrap += 10; this.afterReward(); });
      container.appendChild(card);
    } else {
      options.forEach(rid => {
        const relic = BC.RELICS[rid];
        const card = document.createElement('div');
        card.className = 'reward-card';
        card.innerHTML = `<h3>${relic.name}</h3><p>${relic.desc}</p><span class="tag">Upgrade</span>`;
        card.addEventListener('click', () => {
          if (relic.oneShot) {
            // one-shot effect: apply immediately (medkit heals squad)
            if (relic.id === 'medkit') {
              for (const u of this.run.squad) if (u.hp > 0) u.hp = u.maxHp;
              this.toast('Squad fully repaired.');
            }
          } else {
            this.run.relics.push(rid);
            // Also apply persistent stat changes to squad
            if (typeof relic.apply === 'function') {
              for (const u of this.run.squad) relic.apply(u);
            }
          }
          this.afterReward();
        });
        container.appendChild(card);
      });
    }
    document.getElementById('reward-title').textContent = 'Choose an Upgrade';
    document.getElementById('reward-sub').textContent = 'Pick one. The rest are lost.';
    this.showScreen('reward');
  },

  afterReward() {
    SaveIO.save(this.run, null);
    this.showScreen('map');
    this.refreshMap();
  },

  /* ---------- Battle ---------- */
  startBattle(node) {
    const template = BC.ENCOUNTERS[node.template];
    const seed = (this.run.rng.seed ^ node.id.length * 7919) >>> 0;
    const battle = Battle.create(template, this.run.squad, this.run.relics, seed);
    this.battle = battle;
    undoStack.clear();
    Input.selection = null;
    Input.battle = battle;
    this.showScreen('battle');
    // Battle.create already entered the initial phase.
    this.refreshBattle();
    SaveIO.save(this.run, battle);
  },

  resumeBattle(battle) {
    this.battle = battle;
    Input.battle = battle;
    Input.selection = null;
    undoStack.clear();
    this.showScreen('battle');
    this.refreshBattle();
  },

  refreshBattle() {
    const b = this.battle;
    if (!b) return;
    this.elems.turnNum.textContent = b.turn;
    const phaseName = b.phase === Phases.PLAYER_INPUT ? 'Your Turn' :
                      b.phase === Phases.ENEMY_MOVE || b.phase === Phases.ENEMY_ATTACK ? 'Enemy Phase' :
                      b.phase === Phases.END_OF_TURN ? 'End of Turn' :
                      b.phase === Phases.RESULT ? (b.data.result === 'victory' ? 'Victory' : 'Defeat') :
                      'Processing';
    this.elems.phaseBadge.textContent = phaseName;
    this.elems.phaseBadge.classList.toggle('enemy', b.phase !== Phases.PLAYER_INPUT && b.phase !== Phases.START_OF_TURN);

    Renderer.drawBattle(b, Input.selection);
    this.refreshLog();
    this.refreshUndo();
    this.refreshSquadTop();

    if (b.data.result) this.onBattleResult();
  },

  refreshSquadTop() {
    // Reuse squad chip area for in-battle squad health
    const list = document.getElementById('squad-summary');
    if (!list) return;
    list.innerHTML = '';
    for (const u of this.battle.alivePlayers().concat(this.battle.units.filter(x => x.team==='player' && x.hp<=0))) {
      const cls = BC.CLASSES[u.classId];
      const chip = document.createElement('div');
      chip.className = 'squad-chip' + (u.hp <= 0 ? ' dead' : '');
      chip.innerHTML = `<span class="dot" style="background:${cls.colour}"></span>${cls.glyph} ${u.hp}/${u.maxHp}`;
      list.appendChild(chip);
    }
  },

  refreshLog() {
    const el = this.elems.log;
    const lines = this.battle.data.log.slice(-12);
    el.innerHTML = lines.map(l => `<div class="entry ${l.cls || ''}">${escapeHtml(l.msg)}</div>`).join('');
    el.scrollTop = el.scrollHeight;
  },

  refreshUndo() {
    this.elems.btnUndo.disabled = !undoStack.canUndo() || (this.battle && this.battle.phase !== Phases.PLAYER_INPUT);
  },

  showUnitInfo(u) {
    const cls = BC.CLASSES[u.classId];
    const hpPct = Math.round(100 * u.hp / u.maxHp);
    this.elems.unitPanel.innerHTML = `
      <h3>${cls.name} <span class="muted small">${cls.role}</span></h3>
      <div class="row"><span>HP</span><span>${u.hp} / ${u.maxHp}</span></div>
      <div class="bar ${hpPct < 50 ? 'hurt' : ''}"><div style="width:${hpPct}%"></div></div>
      <div class="row"><span>Move</span><span>${u.hasMoved ? 'used' : u.move}</span></div>
      <div class="row"><span>Action</span><span>${u.hasActed ? 'used' : 'ready'}</span></div>
      ${u.shield ? `<div class="row"><span>Shield</span><span>+${u.shield}</span></div>` : ''}
    `;
  },

  showEnemyInfo(e) {
    const k = BC.ENEMIES[e.kindId];
    const hpPct = Math.round(100 * e.hp / e.maxHp);
    this.elems.unitPanel.innerHTML = `
      <h3 style="color:${k.colour}">${k.name}</h3>
      <div class="row"><span>HP</span><span>${e.hp} / ${e.maxHp}</span></div>
      <div class="bar hurt"><div style="width:${hpPct}%"></div></div>
      <div class="row"><span>Intent</span><span style="color:var(--warn)">${e.intent?.desc || '—'}</span></div>
    `;
    this.elems.abilityBar.innerHTML = '<p class="muted small">Enemy selected. Tap a squad unit to plan.</p>';
  },

  showEmptyPanel() {
    this.elems.unitPanel.innerHTML = `<p class="muted small">Tap a unit to inspect.</p>`;
    this.elems.abilityBar.innerHTML = '';
  },

  showAbilities(u) {
    const cls = BC.CLASSES[u.classId];
    const bar = this.elems.abilityBar;
    bar.innerHTML = '';
    for (const abId of cls.abilities) {
      const ab = BC.ABILITIES[abId];
      const cd = u.cooldowns[abId] || 0;
      const btn = document.createElement('button');
      btn.className = 'ability-btn';
      btn.dataset.id = abId;
      btn.innerHTML = `<span><span class="ab-name">${ab.name}</span><br><span class="ab-meta">${ab.desc}</span></span>
                       <span class="ab-meta">${cd > 0 ? `CD ${cd}` : (ab.cooldown ? `CD ${ab.cooldown}` : 'Ready')}</span>`;
      btn.disabled = u.hasActed || cd > 0;
      btn.addEventListener('click', () => Input.selectAbility(abId));
      bar.appendChild(btn);
    }
  },

  markAbilitySelected(id) {
    this.elems.abilityBar.querySelectorAll('.ability-btn').forEach(b => {
      b.classList.toggle('selected', b.dataset.id === id);
    });
  },

  onBattleResult() {
    const b = this.battle;
    setTimeout(() => {
      if (b.data.result === 'victory') {
        // Persist squad HP back to run
        for (const u of b.alivePlayers()) {
          const runUnit = this.run.squad.find(s => s.id === u.id);
          if (runUnit) runUnit.hp = u.hp;
        }
        for (const u of b.units.filter(x => x.team === 'player' && x.hp <= 0)) {
          const runUnit = this.run.squad.find(s => s.id === u.id);
          if (runUnit) runUnit.hp = 0;
        }
        // award scrap
        const reward = b.data.templateId.startsWith('elite') ? 25 : (b.data.templateId.startsWith('boss') ? 50 : 10);
        this.run.scrap += reward;
        this.battle = null;

        const node = this.run.map.nodes.find(n => n.id === this.run.currentNodeId);
        if (node.kind === 'boss') {
          this.run.completed = true;
          this.showResult('victory', `You cleared the sector. +${reward} scrap.`, () => {
            SaveIO.clear();
            this.showScreen('title');
            this.refreshTitle();
          });
        } else {
          this.showResult('victory', `Enemies neutralised. +${reward} scrap.`, () => {
            this.showRewards(node.kind === 'elite' ? 'elite' : 'battle', node);
          });
        }
      } else if (b.data.result === 'defeat') {
        SaveIO.clear();
        this.showResult('defeat', 'Squad lost. Run over.', () => {
          this.run = null;
          this.battle = null;
          this.showScreen('title');
          this.refreshTitle();
        });
      }
    }, 350);
  },

  showResult(kind, msg, onContinue) {
    const overlay = document.getElementById('overlay-result');
    document.getElementById('result-title').textContent = kind === 'victory' ? 'Victory' : 'Defeat';
    document.getElementById('result-body').textContent = msg;
    document.getElementById('result-rewards').innerHTML = '';
    overlay.hidden = false;
    const btn = document.getElementById('btn-result-next');
    const handler = () => {
      overlay.hidden = true;
      btn.removeEventListener('click', handler);
      onContinue();
    };
    btn.addEventListener('click', handler);
  },

  endTurn() {
    const b = this.battle;
    if (!b || b.phase !== Phases.PLAYER_INPUT) return;
    undoStack.clear();
    PhaseMachine.playerEndTurn(b);
    this.refreshBattle();
  },

  undo() {
    const b = this.battle;
    if (!b || b.phase !== Phases.PLAYER_INPUT) return;
    if (!undoStack.canUndo()) return;
    const snap = undoStack.pop();
    b.restore(snap);
    Input.selection = null;
    this.showEmptyPanel();
    this.refreshBattle();
    this.toast('Undone.');
  },

  /* ---------- Overlays ---------- */
  showMenu() {
    document.getElementById('overlay-menu').hidden = false;
  },
  hideMenu() {
    document.getElementById('overlay-menu').hidden = true;
  },
  showHelp() {
    document.getElementById('overlay-help').hidden = false;
  },
  hideHelp() {
    document.getElementById('overlay-help').hidden = true;
  },
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/* =============================================================
   10. BOOTSTRAP
   ============================================================= */
function start() {
  UI.init();

  // Renderer setup
  Renderer.initBoard(document.getElementById('board-canvas'));
  Renderer.initMap(document.getElementById('map-canvas'));

  // Input binding
  Input.bindBoard(document.getElementById('board-canvas'),
    () => UI.battle,
    () => UI.refreshBattle()
  );
  UI.bindMapTap();

  // Title screen buttons
  document.getElementById('btn-new-run').addEventListener('click', () => {
    SaveIO.clear();
    UI.run = RunState.initial(Date.now() >>> 0);
    SaveIO.save(UI.run, null);
    UI.showScreen('map');
    UI.refreshMap();
  });
  document.getElementById('btn-continue').addEventListener('click', () => {
    const payload = SaveIO.load();
    if (!payload || !payload.run) { UI.toast('No save found.'); return; }
    UI.run = RunState.deserialize(payload.run);
    if (payload.battle) {
      const b = Battle.deserialize(payload.battle);
      UI.resumeBattle(b);
    } else {
      UI.showScreen('map');
      UI.refreshMap();
    }
  });
  document.getElementById('btn-help').addEventListener('click', () => UI.showHelp());
  document.getElementById('btn-help-2').addEventListener('click', () => UI.showHelp());
  document.getElementById('btn-close-help').addEventListener('click', () => UI.hideHelp());

  // Map menu
  document.getElementById('btn-map-menu').addEventListener('click', () => UI.showMenu());
  document.getElementById('btn-battle-menu').addEventListener('click', () => UI.showMenu());
  document.getElementById('btn-resume').addEventListener('click', () => UI.hideMenu());
  document.getElementById('btn-save').addEventListener('click', () => {
    const ok = SaveIO.save(UI.run, UI.battle);
    UI.toast(ok ? 'Saved.' : 'Save failed.');
  });
  document.getElementById('btn-abandon').addEventListener('click', () => {
    if (!confirm('Abandon this run? Your save will be erased.')) return;
    SaveIO.clear();
    UI.run = null; UI.battle = null;
    UI.hideMenu();
    UI.showScreen('title');
    UI.refreshTitle();
  });

  // Battle buttons
  document.getElementById('btn-end-turn').addEventListener('click', () => UI.endTurn());
  document.getElementById('btn-undo').addEventListener('click', () => UI.undo());

  // Resize handling
  const onResize = () => {
    if (UI.battle) UI.refreshBattle();
    if (UI.run && UI.screen === 'map') UI.refreshMap();
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  // Autosave periodically
  setInterval(() => {
    if (UI.run) SaveIO.save(UI.run, UI.battle);
  }, 10000);

  // Startup state
  UI.showScreen('title');
  UI.refreshTitle();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}

})();
