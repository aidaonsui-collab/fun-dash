// ---------------------------------------------------------------------------
//  Headless verification of the Phase-1 PvP core (no browser, no wallet).
//
//  1) DETERMINISM  — the same seed + same scripted jump inputs reproduces a
//     byte-identical finish order (so any result is re-simulatable / auditable).
//  2) AUTHORITY    — two real WS clients get matched, race, and BOTH receive the
//     exact same server-decided winner + order; a 4-racer field forms (2 humans
//     + 2 bots); and a client spamming junk can't dictate the outcome (the only
//     accepted input is "jump").
//
//  Run:  node test-clients.mjs
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const { Race } = require('./sim.js');

const PORT = 8199;
let fails = 0;
const ok  = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const bad = (m) => { console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- 1) determinism (pure sim) ------------------------------------------
function scriptedRace(){
  const entrants = [
    { id:'p1', name:'Alice', char:0, isBot:false },
    { id:'p2', name:'Bob',   char:1, isBot:false },
    { id:'b1', name:'Bot',   char:2, isBot:true  },
  ];
  const r = new Race(12345, entrants);
  let step = 0;
  while (!r.over && step < 60*30){
    // deterministic input scripts: p1 jumps every 14 steps, p2 every 18
    if (step % 14 === 0) r.input('p1');
    if (step % 18 === 0) r.input('p2');
    r.step(); step++;
  }
  return { order: r.finishOrder.slice(), t: r.t, winner: r.winnerId() };
}
function testDeterminism(){
  console.log('\n[1] determinism / reproducibility');
  const a = scriptedRace(), b = scriptedRace();
  if (JSON.stringify(a.order) === JSON.stringify(b.order)) ok('identical finish order across two runs: [' + a.order.join(', ') + ']');
  else bad('finish order diverged: ' + JSON.stringify(a.order) + ' vs ' + JSON.stringify(b.order));
  if (a.winner && a.order.length === 3) ok(`race completed, winner=${a.winner}, t=${a.t.toFixed(1)}s`);
  else bad('race did not complete cleanly: ' + JSON.stringify(a));
}

// ---- 2) authority (real WS clients) -------------------------------------
function mkClient(name, char, { junk=false } = {}){
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const c = { ws, name, char, id:null, you:null, match:null, result:null, states:0, junk };
  ws.on('open', () => { ws.send(JSON.stringify({ t:'hello', name, char })); ws.send(JSON.stringify({ t:'find', mode:'casual' })); });
  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.t === 'welcome') c.id = m.id;
    else if (m.t === 'you') c.you = m.id;
    else if (m.t === 'match') c.match = m;
    else if (m.t === 'countdown' && m.n <= 0){
      // race begins — jump on a timer; the junk client also fires garbage the server must ignore
      c._jump = setInterval(() => {
        ws.send(JSON.stringify({ t:'input' }));
        if (junk){
          ws.send(JSON.stringify({ t:'input', x: 999999, win: true, place: 1 }));     // bogus fields
          ws.send(JSON.stringify({ t:'result', winner: c.you }));                      // try to declare self winner
          ws.send(JSON.stringify({ t:'setpos', id: c.you, x: 99999 }));                // unknown opcode
        }
      }, 120);
    }
    else if (m.t === 'state') c.states++;
    else if (m.t === 'result'){ c.result = m; clearInterval(c._jump); }
  });
  return c;
}

async function testAuthority(){
  console.log('\n[2] server authority (2 live WS clients + bots)');
  const a = mkClient('Alice', 0);
  const b = mkClient('Bob',   1, { junk:true });   // Bob tries to cheat
  // wait for match + result (casual fills bots after CASUAL_WAIT=6s; race ~ up to 90s but usually faster)
  const deadline = Date.now() + 120000;
  while ((!a.result || !b.result) && Date.now() < deadline) await sleep(250);

  if (a.match && a.match.racers.length === 4) ok(`4-racer field formed: ${a.match.racers.map(r=>r.name+(r.bot?'(bot)':'')).join(', ')}`);
  else bad('expected a 4-racer field, got ' + (a.match ? a.match.racers.length : 'no match'));

  if (a.match && b.match && a.match.room === b.match.room && a.match.seed === b.match.seed)
    ok(`both clients in the same room/seed (room=${a.match.room}, seed=${a.match.seed}, theme=${a.match.theme})`);
  else bad('clients not in the same room/seed');

  if (a.states > 30 && b.states > 30) ok(`snapshot stream flowing (Alice ${a.states}, Bob ${b.states} states)`);
  else bad(`too few state snapshots (Alice ${a.states}, Bob ${b.states})`);

  if (a.result && b.result){
    if (a.result.winner === b.result.winner) ok(`both clients agree on winner: ${a.result.winner}`);
    else bad(`winner disagreement: Alice=${a.result.winner} Bob=${b.result.winner}`);
    if (JSON.stringify(a.result.order) === JSON.stringify(b.result.order)) ok('both clients see identical finish order');
    else bad('finish order disagreement between clients');
    const win = a.result.order.find(o => o.place === 1);
    // Bob spammed "I won" junk — the result must come from the sim, not his claims
    if (a.result.winner && a.result.order.length === 4) ok(`server-decided result stands despite cheat spam (winner=${win?win.name:'?'})`);
    else bad('result malformed: ' + JSON.stringify(a.result));
  } else bad('did not receive a result from both clients in time');

  a.ws.close(); b.ws.close();
}

// ---- 3) staked PvP matchmaking: 4-player pot (settlement OFF, fake chain acks) ----
function mkStakedClient(name, char, addr){
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const c = { ws, name, addr, id:null, match:null, result:null, wasHost:false, staked:false };
  ws.on('open', () => { ws.send(JSON.stringify({ t:'hello', name, char, addr }));
    ws.send(JSON.stringify({ t:'find', mode:'staked', stake:0.1, addr })); });
  ws.on('message', (buf) => { const m = JSON.parse(buf.toString());
    if (m.t === 'welcome') c.id = m.id;
    else if (m.t === 'stake_host'){ c.wasHost = true; c.hostFor = m.players;   // host "creates" the room
      ws.send(JSON.stringify({ t:'staked_room', room:'0xFAKEROOM' })); }
    else if (m.t === 'stake_join'){ c.staked = true;                            // guest "joins" the room
      ws.send(JSON.stringify({ t:'staked_joined' })); }
    else if (m.t === 'match') c.match = m;
    else if (m.t === 'countdown' && m.n <= 0) c._jump = setInterval(() => ws.send(JSON.stringify({ t:'input' })), 140);
    else if (m.t === 'result'){ c.result = m; clearInterval(c._jump); }
  });
  return c;
}
async function testStaked(){
  console.log('\n[3] staked PvP — 4-player pot (settlement off; fake on-chain acks)');
  const cs = [0,1,2,3].map(i => mkStakedClient('Staker'+i, i, '0xstaker'+i));
  const deadline = Date.now() + 120000;
  while (cs.some(c => !c.result) && Date.now() < deadline) await sleep(250);

  const m0 = cs[0].match;
  if (m0 && m0.mode === 'staked' && m0.racers.length === 4) ok(`4-player staked room formed: ${m0.racers.map(r=>r.name).join(', ')}`);
  else bad('expected a 4-player staked room, got ' + (m0 ? m0.mode+'/'+m0.racers.length : 'no match'));

  if (cs.every(c => c.match && c.match.room === (m0&&m0.room))) ok('all 4 stakers share one room (one on-chain pot)');
  else bad('stakers were split across rooms');

  const hosts = cs.filter(c => c.wasHost).length;
  if (hosts === 1) ok(`exactly one host created the room (for ${cs.find(c=>c.wasHost).hostFor} players)`);
  else bad(`${hosts} hosts (expected exactly 1)`);

  if (cs.every(c => c.result)){
    const w = cs[0].result.winner;
    if (cs.every(c => c.result.winner === w)) ok('all 4 stakers agree on the winner: ' + w);
    else bad('winner disagreement among stakers');
  } else bad('not all stakers received a result');
  cs.forEach(c => c.ws.close());
}

// ---- run -----------------------------------------------------------------
(async () => {
  console.log('Starting test server on :' + PORT + ' ...');
  const srv = spawn('node', ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore','pipe','pipe'] });
  await new Promise((res) => { srv.stdout.on('data', d => { if (/server on/.test(d.toString())) res(); }); setTimeout(res, 2000); });

  try {
    testDeterminism();
    await testAuthority();
    await testStaked();
  } finally {
    srv.kill();
  }
  console.log(fails === 0 ? '\n\x1b[32mALL CHECKS PASSED\x1b[0m' : `\n\x1b[31m${fails} CHECK(S) FAILED\x1b[0m`);
  process.exit(fails === 0 ? 0 : 1);
})();
