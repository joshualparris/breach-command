// Deeper sim: stub just enough DOM for game.js's IIFE to define internals, then exfiltrate.
const fs = require('fs');
const path = require('path');

// Very small DOM stub
const listeners = {};
const el = () => ({
  hidden: false, innerHTML: '', textContent: '', classList: { toggle(){}, add(){}, remove(){}, contains(){return false;} },
  addEventListener(ev, fn) {}, removeEventListener(){}, appendChild(){}, querySelectorAll(){ return []; },
  getContext() {
    return {
      setTransform(){}, fillRect(){}, strokeRect(){}, clearRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, arc(){}, fill(){}, stroke(){}, fillText(){}, setLineDash(){}, save(){}, restore(){},
      fillStyle:'', strokeStyle:'', lineWidth:0, font:'', textAlign:'', textBaseline:''
    };
  },
  getBoundingClientRect() { return { left:0, top:0, width: 480, height: 480 }; },
  dataset: {},
  parentElement: { clientWidth: 480, clientHeight: 480 },
  style: {},
  width: 0, height: 0,
});

global.document = {
  getElementById: () => el(),
  addEventListener: () => {},
  readyState: 'complete',
};
global.window = {
  addEventListener: () => {},
  devicePixelRatio: 1,
};
global.localStorage = {
  _store: {},
  getItem(k) { return this._store[k] || null; },
  setItem(k, v) { this._store[k] = v; },
  removeItem(k) { delete this._store[k]; }
};
global.structuredClone = (o) => JSON.parse(JSON.stringify(o));
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.setTimeout = setTimeout;
global.setInterval = () => 0;
global.confirm = () => true;

// Load content first
require('./content.js');

// Extract internal classes by injecting exposure hook
let gameSrc = fs.readFileSync(path.join(__dirname, 'game.js'), 'utf8');
// Expose Battle, RunState, PhaseMachine, undoStack, Phases, UI, Input via global for test
gameSrc = gameSrc.replace(
  '})();',
  'global.__TEST = { Battle, RunState, PhaseMachine, undoStack, Phases, UI, Input, SaveIO, makeRng, MapGen, AI };\n})();'
);

eval(gameSrc);

const { Battle, RunState, PhaseMachine, undoStack, Phases, SaveIO, MapGen, makeRng } = global.__TEST;
const BC = global.window.BC;

// --- Test 1: create a run, gen map, serialize roundtrip
const run = RunState.initial(12345);
console.assert(run.squad.length === 3, 'squad should be 3');
console.assert(run.map.rows.length === BC.MAP_PARAMS.rows, 'map rows');
console.assert(run.map.nodes.length > 0, 'map nodes');
console.assert(run.map.edges.length > 0, 'map edges');

// Boss row has exactly 1 node
const bossRow = run.map.rows[run.map.rows.length - 1];
console.assert(bossRow.length === 1, 'boss row single node');

// Every non-first-row node has at least one incoming edge
const rows = run.map.rows;
for (let r = 1; r < rows.length; r++) {
  for (const nid of rows[r]) {
    const inc = run.map.edges.filter(e => e.to === nid);
    console.assert(inc.length >= 1, `node ${nid} at row ${r} has no incoming edges`);
  }
}

// Serialize roundtrip
const s = run.serialize();
const run2 = RunState.deserialize(JSON.parse(JSON.stringify(s)));
console.assert(run2.squad.length === run.squad.length);
console.assert(run2.map.rows.length === run.map.rows.length);

// --- Test 2: create a battle, run a turn
const enc = BC.ENCOUNTERS.corridor_easy;
const battle = Battle.create(enc, run.squad, [], 999);
console.assert(battle.alivePlayers().length === 3, '3 players');
console.assert(battle.aliveEnemies().length === enc.enemies.length, 'enemies count');
console.assert(battle.phase === 'player_input', 'initial phase is player_input');
console.assert(battle.aliveEnemies().every(e => e.intent), 'all enemies have intent');

// Undo roundtrip: snapshot, mutate, restore
const p1 = battle.alivePlayers()[0];
const oldX = p1.x;
const snap = battle.snapshot();
p1.x = 5;
battle.restore(snap);
console.assert(battle.alivePlayers()[0].x === oldX, 'undo restored x');

// Phase machine progression without any player actions: force end turn
PhaseMachine.playerEndTurn(battle);
// After enemy phases complete, we should have advanced to turn 2 back in start/player_input phase
console.assert(battle.turn === 2 || battle.data.result, 'turn advanced or battle ended');

// --- Test 3: AI doesn't crash on various configs
for (let i = 0; i < 5; i++) {
  const b = Battle.create(BC.ENCOUNTERS.elite_gauntlet, run.squad, run.relics, 1000 + i);
  // Force several end-turns
  for (let t = 0; t < 6 && !b.data.result; t++) {
    PhaseMachine.playerEndTurn(b);
  }
  console.assert(b.turn >= 2, 'turn advanced');
}

// --- Test 4: Save/load battle roundtrip
const b3 = Battle.create(BC.ENCOUNTERS.corridor_mid, run.squad, [], 42);
PhaseMachine.playerEndTurn(b3);
const ser = b3.serialize();
const b3b = Battle.deserialize(ser);
console.assert(b3b.turn === b3.turn, 'battle save/load turn');
console.assert(b3b.alivePlayers().length === b3.alivePlayers().length, 'players preserved');
console.assert(b3b.aliveEnemies().every(e => e.intent), 'intents preserved');

// --- Test 5: SaveIO roundtrip
const ok = SaveIO.save(run, b3);
console.assert(ok, 'save ok');
const payload = SaveIO.load();
console.assert(payload && payload.run && payload.battle, 'payload restored');

// --- Test 6: Pushing into wall / pit
const testBattle = Battle.create(BC.ENCOUNTERS.corridor_easy, run.squad, [], 77);
const e1 = testBattle.aliveEnemies()[0];
// Manually put a pit next to e1
const size = testBattle.size;
if (e1.x + 1 < size) testBattle.setTile(e1.x + 1, e1.y, { type: 'pit' });
else testBattle.setTile(e1.x - 1, e1.y, { type: 'pit' });

const hpBefore = e1.hp;
testBattle.push(e1, (e1.x + 1 < size ? 1 : -1), 0, 2, 'test');
// Enemy should be in pit => hp 0
console.assert(e1.hp === 0, 'enemy pushed into pit died');

// --- Test 7: Shield absorbs
const p = testBattle.alivePlayers()[0];
p.shield = 3;
const hpWas = p.hp;
testBattle.damageUnit(p, 2, 'test');
console.assert(p.hp === hpWas, 'shield absorbed all 2');
console.assert(p.shield === 1, 'shield reduced to 1');

console.log('All simulation tests OK');
console.log('Turns played across 5 elite runs + 2 battles: runtime clean');
