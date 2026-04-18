/* =============================================================
   BREACH COMMAND — content.js
   -------------------------------------------------------------
   All game content lives here as pure data + small pure functions.
   Adding new units, enemies, abilities, hazards or relics means
   adding an entry to the relevant table — core/game.js should
   not need to change.

   Conventions:
     - Every entry has a stable string `id` used in save files.
     - Ability `effect` is a function (battle, caster, target) => void
       that mutates battle state via the battle API.
     - Enemy `plan(battle, self)` returns an "intent" object which
       the engine then executes in the enemy phase.

   Extension points are tagged with  EXT:  comments.
   ============================================================= */

'use strict';

/* -------------------------------------------------------------
   DIRECTIONS & helpers shared with game.js via global BC
   ------------------------------------------------------------- */
const BC = window.BC = window.BC || {};

BC.DIRS = [
  { dx:  0, dy: -1, name: 'N' },
  { dx:  1, dy:  0, name: 'E' },
  { dx:  0, dy:  1, name: 'S' },
  { dx: -1, dy:  0, name: 'W' },
];

/* -------------------------------------------------------------
   HAZARDS / TILES
   Each tile type defines its rules declaratively.
   EXT: add new tile types here; the engine reads these fields.
   ------------------------------------------------------------- */
BC.TILES = {
  floor: {
    id: 'floor',
    name: 'Floor',
    blocks: false,        // blocks line of sight / movement
    solid: false,         // units cannot enter
    onEnter: null,        // (battle, unit) => void
    onEndTurn: null,      // (battle, unit) => void, unit ending turn on tile
  },
  wall: {
    id: 'wall',
    name: 'Wall',
    blocks: true,
    solid: true,
  },
  pit: {
    id: 'pit',
    name: 'Pit',
    blocks: false,
    solid: false,         // you can be pushed in; you die
    onEnter(battle, unit) {
      battle.log(`${unit.name} falls into the pit.`, 'hit');
      battle.killUnit(unit, 'pit');
    },
  },
  spike: {
    id: 'spike',
    name: 'Spikes',
    blocks: false,
    solid: false,
    onEnter(battle, unit) {
      battle.damageUnit(unit, 2, 'spikes');
    },
  },
  vent: {
    id: 'vent',
    name: 'Vent',
    blocks: false,
    solid: false,
    // vents push anything that ends its turn on them in a set direction
    onEndTurn(battle, unit, tile) {
      const d = BC.DIRS[tile.dir ?? 1]; // default East
      battle.push(unit, d.dx, d.dy, 1, 'vent');
    },
  },
};

/* -------------------------------------------------------------
   ABILITY EFFECTS
   Pure-ish helpers. They mutate battle state via battle methods
   (damageUnit, push, moveUnit, etc.) — never touch rendering.
   ------------------------------------------------------------- */
BC.ABILITIES = {

  /* ---------- VANGUARD ---------- */
  shield_bash: {
    id: 'shield_bash',
    name: 'Shield Bash',
    desc: 'Melee. 2 dmg, push 1.',
    range: 1,
    needsLoS: false,
    targetType: 'enemy',
    cooldown: 0,
    effect(battle, caster, target) {
      battle.damageUnit(target, 2, caster.name);
      const d = battle.dirFromTo(caster, target);
      battle.push(target, d.dx, d.dy, 1, caster.name);
    }
  },
  brace: {
    id: 'brace',
    name: 'Brace',
    desc: 'Gain 3 shield until next turn.',
    range: 0,
    targetType: 'self',
    cooldown: 2,
    effect(battle, caster) {
      caster.shield = Math.max(caster.shield, 3);
      battle.log(`${caster.name} braces (+3 shield).`, 'ok');
    }
  },

  /* ---------- INFILTRATOR ---------- */
  pulse_shot: {
    id: 'pulse_shot',
    name: 'Pulse Shot',
    desc: 'Ranged 4. 2 dmg.',
    range: 4,
    needsLoS: true,
    targetType: 'enemy',
    cooldown: 0,
    effect(battle, caster, target) {
      battle.damageUnit(target, 2, caster.name);
    }
  },
  grapple: {
    id: 'grapple',
    name: 'Grapple',
    desc: 'Pull target 2 tiles toward you (range 4).',
    range: 4,
    needsLoS: true,
    targetType: 'any',
    cooldown: 2,
    effect(battle, caster, target) {
      const d = battle.dirFromTo(target, caster);
      battle.push(target, d.dx, d.dy, 2, 'grapple');
    }
  },

  /* ---------- ENGINEER ---------- */
  arc_welder: {
    id: 'arc_welder',
    name: 'Arc Welder',
    desc: 'Adjacent. 1 dmg or repair 2 to ally.',
    range: 1,
    targetType: 'any',
    cooldown: 0,
    effect(battle, caster, target) {
      if (target.team === caster.team) {
        battle.healUnit(target, 2, caster.name);
      } else {
        battle.damageUnit(target, 1, caster.name);
      }
    }
  },
  mine: {
    id: 'mine',
    name: 'Deploy Mine',
    desc: 'Place spike tile on empty square (range 3).',
    range: 3,
    needsLoS: false,
    targetType: 'empty',
    cooldown: 3,
    effect(battle, caster, target) {
      battle.setTile(target.x, target.y, { type: 'spike' });
      battle.log(`${caster.name} deploys a mine.`, 'ok');
    }
  },
};

/* -------------------------------------------------------------
   PLAYER CLASSES
   EXT: new classes register here. Each class lists two abilities
   plus basic move allowance and hp.
   ------------------------------------------------------------- */
BC.CLASSES = {
  vanguard: {
    id: 'vanguard',
    name: 'Vanguard',
    role: 'Front-line bruiser. Push specialist.',
    maxHp: 8,
    move: 3,
    colour: '#64d2ff',
    glyph: 'V',
    abilities: ['shield_bash', 'brace'],
  },
  infiltrator: {
    id: 'infiltrator',
    name: 'Infiltrator',
    role: 'Ranged striker. Repositions targets.',
    maxHp: 5,
    move: 4,
    colour: '#b9a6ff',
    glyph: 'I',
    abilities: ['pulse_shot', 'grapple'],
  },
  engineer: {
    id: 'engineer',
    name: 'Engineer',
    role: 'Support and terrain control.',
    maxHp: 6,
    move: 3,
    colour: '#7bdc9c',
    glyph: 'E',
    abilities: ['arc_welder', 'mine'],
  },
};

/* -------------------------------------------------------------
   ENEMY PLAN FUNCTIONS
   Every enemy's plan() returns an intent object describing what
   it *will* do next turn. The engine displays it, then executes.

   Intent shape:
     { kind: 'move' | 'attack' | 'push' | 'wait',
       targetId?: string,       // unit id
       path?: [{x,y}, ...],     // movement steps (inclusive of target tile)
       dmg?: number,
       pushDir?: {dx,dy},
       pushDist?: number,
       desc: string }           // short UI string
   ------------------------------------------------------------- */
BC.ENEMY_PLANS = {

  // Moves toward nearest player, attacks adjacent for 2
  grunt(battle, self) {
    const target = battle.nearestPlayer(self);
    if (!target) return { kind: 'wait', desc: 'Wait' };
    const adj = battle.chebyshev(self, target) === 1 && battle.manhattan(self, target) === 1;
    if (adj) {
      return { kind: 'attack', targetId: target.id, dmg: 2, desc: `Strike ${target.name} (2)` };
    }
    const path = battle.pathToward(self, target, self.move);
    const last = path[path.length - 1] || self;
    // After moving, can it attack?
    if (battle.manhattan(last, target) === 1) {
      return { kind: 'move_attack', targetId: target.id, path, dmg: 2, desc: `Advance & strike (2)` };
    }
    return { kind: 'move', path, desc: 'Advance' };
  },

  // Stays at range 2-3. Shoots for 2. Retreats if adjacent.
  sniper(battle, self) {
    const target = battle.nearestPlayer(self);
    if (!target) return { kind: 'wait', desc: 'Wait' };
    const d = battle.manhattan(self, target);
    if (d === 1) {
      // retreat one step away from target
      const away = battle.stepAway(self, target);
      if (away) return { kind: 'move_attack', targetId: target.id, path: [away], dmg: 2, desc: 'Retreat & snipe (2)' };
    }
    if (d >= 2 && d <= 4 && battle.hasLine(self, target)) {
      return { kind: 'attack', targetId: target.id, dmg: 2, ranged: true, desc: `Snipe ${target.name} (2)` };
    }
    // otherwise reposition toward range 3
    const path = battle.pathToward(self, target, self.move);
    return { kind: 'move', path, desc: 'Reposition' };
  },

  // Rushes player, headbutts for 1 and pushes 2. Dangerous near hazards.
  brute(battle, self) {
    const target = battle.nearestPlayer(self);
    if (!target) return { kind: 'wait', desc: 'Wait' };
    const adj = battle.manhattan(self, target) === 1;
    if (adj) {
      const dir = battle.dirFromTo(self, target);
      return { kind: 'push_attack', targetId: target.id, dmg: 1, pushDir: dir, pushDist: 2, desc: `Slam ${target.name} (1, push 2)` };
    }
    const path = battle.pathToward(self, target, self.move);
    const last = path[path.length - 1] || self;
    if (battle.manhattan(last, target) === 1) {
      const dir = battle.dirFromTo(last, target);
      return { kind: 'move_push', targetId: target.id, path, dmg: 1, pushDir: dir, pushDist: 2, desc: 'Charge & slam' };
    }
    return { kind: 'move', path, desc: 'Charge' };
  },

  // Drops a spike tile under its chosen player target location; then runs.
  sapper(battle, self) {
    const target = battle.nearestPlayer(self);
    if (!target) return { kind: 'wait', desc: 'Wait' };
    // Drop spike on target's current tile (telegraphed — player can move off!)
    return { kind: 'hazard_drop', targetId: target.id, tile: 'spike', desc: `Drop spike at ${target.name}'s tile` };
  },

  // AoE pulse: hits all players adjacent to it, 2 dmg. Doesn't move if anyone adjacent.
  pulser(battle, self) {
    const adjPlayers = battle.playersAdjacent(self);
    if (adjPlayers.length > 0) {
      return { kind: 'aoe_adjacent', dmg: 2, desc: `Pulse (all adjacent, 2)` };
    }
    const target = battle.nearestPlayer(self);
    if (!target) return { kind: 'wait', desc: 'Wait' };
    const path = battle.pathToward(self, target, self.move);
    return { kind: 'move', path, desc: 'Close in' };
  },

  // BOSS: Warden. Alternates: big push-slam (turn odd) / summon/heal (turn even).
  warden(battle, self) {
    const target = battle.nearestPlayer(self);
    const turn = battle.turn;
    if (!target) return { kind: 'wait', desc: 'Wait' };
    if (turn % 2 === 1) {
      // move to adjacent, slam for 3 + push 2
      if (battle.manhattan(self, target) === 1) {
        const dir = battle.dirFromTo(self, target);
        return { kind: 'push_attack', targetId: target.id, dmg: 3, pushDir: dir, pushDist: 2, desc: 'Warden Slam (3, push 2)' };
      }
      const path = battle.pathToward(self, target, self.move);
      const last = path[path.length - 1] || self;
      if (battle.manhattan(last, target) === 1) {
        const dir = battle.dirFromTo(last, target);
        return { kind: 'move_push', targetId: target.id, path, dmg: 3, pushDir: dir, pushDist: 2, desc: 'Advance & Slam' };
      }
      return { kind: 'move', path, desc: 'Advance' };
    } else {
      // summon: spawn a grunt adjacent if possible
      return { kind: 'summon', summonKind: 'grunt', desc: 'Summon Grunt' };
    }
  },
};

/* -------------------------------------------------------------
   ENEMY ARCHETYPES
   EXT: new enemies register here.
   ------------------------------------------------------------- */
BC.ENEMIES = {
  grunt:   { id: 'grunt',   name: 'Grunt',   maxHp: 3, move: 2, plan: 'grunt',   glyph: 'g', colour: '#ffb347' },
  sniper:  { id: 'sniper',  name: 'Sniper',  maxHp: 2, move: 2, plan: 'sniper',  glyph: 's', colour: '#ff8a5c' },
  brute:   { id: 'brute',   name: 'Brute',   maxHp: 5, move: 2, plan: 'brute',   glyph: 'B', colour: '#ff6b6b' },
  sapper:  { id: 'sapper',  name: 'Sapper',  maxHp: 2, move: 3, plan: 'sapper',  glyph: 'p', colour: '#d88bff' },
  pulser:  { id: 'pulser',  name: 'Pulser',  maxHp: 3, move: 1, plan: 'pulser',  glyph: 'o', colour: '#ffd166' },
  warden:  { id: 'warden',  name: 'Warden',  maxHp: 10, move: 2, plan: 'warden', glyph: 'W', colour: '#ff5d73', boss: true },
};

/* -------------------------------------------------------------
   RELICS / RUN UPGRADES
   Applied to run.mods; engine reads them when computing effective
   unit stats or on specific hooks.
   EXT: add relic ids here, then add handling in game.js where the
   corresponding hook lives. A small number are implemented now.
   ------------------------------------------------------------- */
BC.RELICS = {
  plate_armour:   { id: 'plate_armour',   name: 'Plate Armour',   desc: 'Vanguard +3 max HP.', apply: (u) => { if (u.classId === 'vanguard') { u.maxHp += 3; u.hp += 3; } } },
  long_barrel:    { id: 'long_barrel',    name: 'Long Barrel',    desc: 'Infiltrator Pulse Shot +1 dmg.', tag: 'infil_shot_bonus' },
  reinforced_kit: { id: 'reinforced_kit', name: 'Reinforced Kit', desc: 'Engineer +2 max HP.', apply: (u) => { if (u.classId === 'engineer') { u.maxHp += 2; u.hp += 2; } } },
  boosters:       { id: 'boosters',       name: 'Boosters',       desc: 'All units +1 move.', apply: (u) => { u.move += 1; } },
  medkit:         { id: 'medkit',         name: 'Medkit',         desc: 'Heal full squad now.', oneShot: true },
  overclock:      { id: 'overclock',      name: 'Overclock',      desc: 'Cooldowns start 1 lower each battle.', tag: 'cooldown_reduce' },
};

/* -------------------------------------------------------------
   ENCOUNTER TEMPLATES
   A template is a description of a battle: size, hazards, and
   enemy list. The map module picks one per node.
   EXT: add new templates for new map biomes.
   ------------------------------------------------------------- */
BC.ENCOUNTERS = {
  corridor_easy: {
    id: 'corridor_easy',
    size: 6,
    hazards: [
      { type: 'wall',  count: 3 },
      { type: 'pit',   count: 1 },
    ],
    enemies: ['grunt', 'grunt', 'sapper'],
    kind: 'battle',
  },
  corridor_mid: {
    id: 'corridor_mid',
    size: 7,
    hazards: [
      { type: 'wall', count: 4 },
      { type: 'pit',  count: 2 },
      { type: 'spike', count: 1 },
    ],
    enemies: ['grunt', 'sniper', 'brute'],
    kind: 'battle',
  },
  vent_room: {
    id: 'vent_room',
    size: 7,
    hazards: [
      { type: 'wall',  count: 3 },
      { type: 'vent',  count: 2 },
      { type: 'pit',   count: 1 },
    ],
    enemies: ['grunt', 'pulser', 'sapper'],
    kind: 'battle',
  },
  elite_brutes: {
    id: 'elite_brutes',
    size: 7,
    hazards: [
      { type: 'wall',  count: 4 },
      { type: 'pit',   count: 2 },
      { type: 'spike', count: 2 },
    ],
    enemies: ['brute', 'brute', 'sniper', 'sapper'],
    kind: 'elite',
  },
  elite_gauntlet: {
    id: 'elite_gauntlet',
    size: 8,
    hazards: [
      { type: 'wall',  count: 5 },
      { type: 'pit',   count: 2 },
      { type: 'spike', count: 2 },
      { type: 'vent',  count: 1 },
    ],
    enemies: ['grunt', 'grunt', 'sniper', 'pulser', 'brute'],
    kind: 'elite',
  },
  boss_warden: {
    id: 'boss_warden',
    size: 8,
    hazards: [
      { type: 'wall',  count: 6 },
      { type: 'pit',   count: 3 },
      { type: 'spike', count: 1 },
    ],
    enemies: ['warden', 'grunt', 'sniper', 'pulser'],
    kind: 'boss',
  },
};

/* -------------------------------------------------------------
   MAP / RUN STRUCTURE
   Compact branching map: rows of nodes, each row has 2-3 nodes,
   edges connect to 1-2 in the next row. Final row is boss.
   ------------------------------------------------------------- */
BC.MAP_PARAMS = {
  rows: 6,              // including boss row
  minCols: 2,
  maxCols: 3,
  // node type weights per row index (0 is first playable row)
  rowProfiles: [
    { battle: 4, elite: 0, rest: 0, reward: 0 }, // row 0
    { battle: 3, elite: 1, rest: 1, reward: 1 }, // row 1
    { battle: 2, elite: 2, rest: 1, reward: 2 }, // row 2
    { battle: 2, elite: 2, rest: 1, reward: 2 }, // row 3
    { battle: 0, elite: 0, rest: 1, reward: 3 }, // row 4 — pre-boss
    // row 5 is always boss (handled specially)
  ],
  battleTemplates: ['corridor_easy', 'corridor_mid', 'vent_room'],
  eliteTemplates:  ['elite_brutes', 'elite_gauntlet'],
  bossTemplate:    'boss_warden',
};

/* -------------------------------------------------------------
   REWARDS
   After victories, 3 options are offered. This is a simple pool;
   Prompt 2 can add rarity weights, etc.
   ------------------------------------------------------------- */
BC.REWARD_POOL = {
  battle: ['plate_armour', 'long_barrel', 'reinforced_kit', 'boosters', 'overclock'],
  elite:  ['medkit', 'plate_armour', 'long_barrel', 'reinforced_kit', 'boosters', 'overclock'],
};
