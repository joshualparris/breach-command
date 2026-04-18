// Minimal harness — stubs out window, loads content.js + game.js logic classes by re-reading them
// We can't cleanly load game.js because it's IIFE DOM-bound; we re-evaluate only Content + a tiny manual test.

global.window = {};
global.structuredClone = (o) => JSON.parse(JSON.stringify(o));
require('./content.js');
const BC = global.window.BC;

// Quick sanity checks on content tables
const classIds = Object.keys(BC.CLASSES);
console.assert(classIds.length === 3, 'expected 3 classes, got ' + classIds.length);

const enemyIds = Object.keys(BC.ENEMIES);
console.assert(enemyIds.length >= 5, 'expected >= 5 enemies, got ' + enemyIds.length);

for (const cid of classIds) {
  const c = BC.CLASSES[cid];
  for (const abId of c.abilities) {
    if (!BC.ABILITIES[abId]) throw new Error('missing ability: ' + abId);
  }
}

for (const eid of enemyIds) {
  const e = BC.ENEMIES[eid];
  if (!BC.ENEMY_PLANS[e.plan]) throw new Error('missing plan fn for: ' + eid);
}

// Encounter templates reference valid enemies
for (const [id, enc] of Object.entries(BC.ENCOUNTERS)) {
  for (const eid of enc.enemies) {
    if (!BC.ENEMIES[eid]) throw new Error(`encounter ${id} references missing enemy ${eid}`);
  }
}

// Map gen params reference valid templates
for (const tid of BC.MAP_PARAMS.battleTemplates) {
  if (!BC.ENCOUNTERS[tid]) throw new Error('missing battle template: ' + tid);
}
for (const tid of BC.MAP_PARAMS.eliteTemplates) {
  if (!BC.ENCOUNTERS[tid]) throw new Error('missing elite template: ' + tid);
}
if (!BC.ENCOUNTERS[BC.MAP_PARAMS.bossTemplate]) throw new Error('missing boss template');

console.log('Content sanity OK.');
console.log('Classes:', classIds.join(', '));
console.log('Enemies:', enemyIds.join(', '));
console.log('Abilities:', Object.keys(BC.ABILITIES).join(', '));
console.log('Encounters:', Object.keys(BC.ENCOUNTERS).join(', '));
