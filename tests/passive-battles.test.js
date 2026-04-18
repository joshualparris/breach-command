// Play many battles to completion by forcing end-turns, to ensure
// there are no infinite loops and that results are reached.
const fs = require('fs');
const path = require('path');

const el = () => ({
  hidden: false, innerHTML: '', textContent: '', classList: { toggle(){}, add(){}, remove(){}, contains(){return false;} },
  addEventListener(){}, removeEventListener(){}, appendChild(){}, querySelectorAll(){ return []; },
  getContext() { return { setTransform(){}, fillRect(){}, strokeRect(){}, clearRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, arc(){}, fill(){}, stroke(){}, fillText(){}, setLineDash(){}, save(){}, restore(){}, fillStyle:'', strokeStyle:'', lineWidth:0, font:'', textAlign:'', textBaseline:'' }; },
  getBoundingClientRect() { return { left:0, top:0, width:480, height:480 }; },
  dataset:{}, parentElement:{ clientWidth:480, clientHeight:480 }, style:{}, width:0, height:0,
});
global.document = { getElementById: () => el(), addEventListener: () => {}, readyState: 'complete' };
global.window = { addEventListener: () => {}, devicePixelRatio: 1 };
global.localStorage = { _s:{}, getItem(k){return this._s[k]||null;}, setItem(k,v){this._s[k]=v;}, removeItem(k){delete this._s[k];} };
global.structuredClone = (o) => JSON.parse(JSON.stringify(o));
global.setInterval = () => 0;
global.setTimeout = () => 0;
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.confirm = () => true;

require('./content.js');
let src = fs.readFileSync(path.join(__dirname, 'game.js'), 'utf8');
src = src.replace('})();', 'global.__TEST = { Battle, RunState, PhaseMachine, Phases, SaveIO };\n})();');
eval(src);

const { Battle, RunState, PhaseMachine, Phases } = global.__TEST;
const BC = global.window.BC;

const run = RunState.initial(42);
const encIds = Object.keys(BC.ENCOUNTERS);
let results = { victory: 0, defeat: 0, timeout: 0 };

for (let i = 0; i < 30; i++) {
  const encId = encIds[i % encIds.length];
  const b = Battle.create(BC.ENCOUNTERS[encId], run.squad.map(u => ({...u, hp: u.maxHp})), [], i * 31 + 7);
  let turns = 0;
  while (!b.data.result && turns < 40) {
    // Player does nothing — just end turn each time.
    // Some encounters: force random player attack in melee range to inject variety
    // Actually, we just end turn. Enemies should still eventually kill squad.
    PhaseMachine.playerEndTurn(b);
    turns++;
  }
  if (b.data.result === 'victory') results.victory++;
  else if (b.data.result === 'defeat') results.defeat++;
  else results.timeout++;
}
console.log('30 passive battles (player never acts):', results);
// With no player input, we expect mostly defeats and no timeouts.
console.assert(results.timeout === 0, 'no timeouts expected');

console.log('Extended sim OK.');
