// ---------------------------------------------------------------------------
//  Fun Dash — realtime PvP server (Phase 1).
//
//  Authoritative game server: clients connect over WebSocket, get matched into
//  rooms, then send ONLY jump inputs. The server runs the deterministic sim
//  (sim.js), broadcasts snapshots, decides the winner, and — for staked rooms —
//  settles on-chain as the contract operator (settle.js). Clients render; they
//  never decide outcomes, so wins can't be faked.
//
//  Two modes:
//   • casual  — fills with deterministic bots up to a 4-racer field; no money.
//   • staked  — 2 humans, both staked into one on-chain RaceRoom; winner-take-pot.
//
//  Run:  OPERATOR_KEY=suiprivkey... node server.js      (settles on-chain)
//        node server.js                                 (realtime only, no chain)
// ---------------------------------------------------------------------------
const http = require('http');
const { WebSocketServer } = require('ws');
const { Race, DT, THEME_KEYS } = require('./sim');
const settle = require('./settle');

const PORT       = process.env.PORT || 8125;
const FIELD      = 4;                 // casual field size (humans + bots)
const CASUAL_WAIT= +process.env.CASUAL_WAIT || 6000;   // ms to wait for more humans before filling bots
const STAKE_WAIT = +process.env.STAKE_WAIT || 45000;   // ms a staked match has to complete its on-chain handshake
const TICK_HZ    = +process.env.TICK_HZ || 30;         // sim+broadcast rate (fixed-dt, so determinism is unaffected)
const BOT_NAMES  = ['BoltBunny','TurboTuna','MetaMutt','PixelPaws','SnaccMan','NovaPaws','FrostFang','Zoomer','GG_Wolf','Krillin22'];
const NUM_CHARS  = 12;                // sprite indices 0..11 (must match CHARS in index.html)

let nextCid = 1, nextGid = 1;
const clients = new Map();            // cid -> client
const rooms   = new Map();            // gid -> room
let casualQ   = [];                   // cids waiting for a casual match
const stakedQ = new Map();            // stakeTier(string) -> [cids]
let casualTimer = null;

const now = () => Date.now();
function send(c, msg){ try { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); } catch(e){} }
function bcast(room, msg){ for (const e of room.entrants){ const c = clients.get(e.id); if (c) send(c, msg); } }

// ---- matchmaking ---------------------------------------------------------
function enterCasual(c){
  c.state = 'queue'; c.mode = 'casual';
  if (!casualQ.includes(c.id)) casualQ.push(c.id);
  for (const id of casualQ){ const cc = clients.get(id); if (cc) send(cc, { t:'queued', mode:'casual', n: casualQ.length, need: 2 }); }
  if (casualQ.length >= FIELD){ formCasual(); }
  else if (!casualTimer){ casualTimer = setTimeout(formCasual, CASUAL_WAIT); }
}

function formCasual(){
  clearTimeout(casualTimer); casualTimer = null;
  const humans = casualQ.map(id => clients.get(id)).filter(c => c && c.ws.readyState === 1).slice(0, FIELD);
  casualQ = casualQ.filter(id => !humans.find(h => h.id === id));
  if (humans.length === 0) return;

  const used = new Set(humans.map(h => h.char));
  const entrants = humans.map(h => ({ id: h.id, name: h.name, char: h.char, bot: false, addr: h.addr }));
  let bi = 0;
  while (entrants.length < FIELD){
    let ch = (Math.random()*NUM_CHARS)|0; let guard=0;
    while (used.has(ch) && guard++ < NUM_CHARS) ch = (ch+1)%NUM_CHARS;
    used.add(ch);
    entrants.push({ id: 'bot'+(nextGid)+'_'+bi, name: BOT_NAMES[(Math.random()*BOT_NAMES.length)|0], char: ch, bot: true });
    bi++;
  }
  startRoom('casual', entrants, { stake: 0 });
}

function enterStaked(c, stake){
  c.state = 'queue'; c.mode = 'staked'; c.stake = stake;
  const key = String(stake);
  if (!stakedQ.has(key)) stakedQ.set(key, []);
  const q = stakedQ.get(key);
  if (!q.includes(c.id)) q.push(c.id);
  send(c, { t:'queued', mode:'staked', stake, n: q.length, need: 2 });
  // pair the first two live humans
  const live = q.map(id => clients.get(id)).filter(x => x && x.ws.readyState === 1);
  if (live.length >= 2){
    const [host, guest] = live;
    stakedQ.set(key, q.filter(id => id !== host.id && id !== guest.id));
    beginStakedHandshake(host, guest, stake);
  }
}

// Staked rooms need a shared on-chain RaceRoom: host creates+joins, guest joins,
// server verifies the escrow, then operates the race.
function beginStakedHandshake(host, guest, stake){
  const hs = { id: 'sh'+nextGid++, host, guest, stake, onchainRoom: null, hostJoined:false, guestJoined:false, ts: now() };
  host.handshake = hs; guest.handshake = hs;
  host.state = guest.state = 'handshake';
  send(host,  { t:'stake_host', stake });                 // host: create_race + join, reply staked_room
  send(guest, { t:'stake_wait', stake });                 // guest: hold for the room id
  hs.timer = setTimeout(() => failHandshake(hs, 'handshake timed out'), STAKE_WAIT);
}
function failHandshake(hs, msg){
  clearTimeout(hs.timer);
  for (const c of [hs.host, hs.guest]){ if (c){ c.handshake=null; c.state='idle'; send(c, { t:'error', msg }); } }
}
async function tryStartStaked(hs){
  if (!(hs.onchainRoom && hs.hostJoined && hs.guestJoined)) return;
  clearTimeout(hs.timer);
  // verify the escrow on-chain before anyone races for it
  if (settle.settlementEnabled()){
    try {
      const room = await settle.readRoom(hs.onchainRoom);
      const want = new Set([hs.host.addr, hs.guest.addr].map(a => a.toLowerCase()));
      const have = new Set(room.players.map(a => a.toLowerCase()));
      if (room.state !== 0 || want.size !== 2 || ![...want].every(a => have.has(a)))
        return failHandshake(hs, 'on-chain room not ready (both players must be staked)');
      await settle.startRace(hs.onchainRoom);            // operator flips WAITING -> IN_PROGRESS
    } catch(e){ return failHandshake(hs, 'on-chain verify/start failed: ' + e.message); }
  }
  const entrants = [
    { id: hs.host.id,  name: hs.host.name,  char: hs.host.char,  bot:false, addr: hs.host.addr },
    { id: hs.guest.id, name: hs.guest.name, char: hs.guest.char, bot:false, addr: hs.guest.addr },
  ];
  hs.host.handshake = hs.guest.handshake = null;
  startRoom('staked', entrants, { stake: hs.stake, onchainRoom: hs.onchainRoom });
}

// ---- room lifecycle ------------------------------------------------------
function startRoom(mode, entrants, opts){
  const gid = 'g'+nextGid++;
  const seed = (Math.random()*1e9)|0;
  const race = new Race(seed, entrants);
  const room = { id: gid, mode, seed, race, entrants, stake: opts.stake||0, onchainRoom: opts.onchainRoom||null,
                 interval: null, finalized:false, countdown: 3 };
  rooms.set(gid, room);
  for (const e of entrants){ const c = clients.get(e.id); if (c){ c.room = gid; c.state = 'racing'; } }

  bcast(room, {
    t:'match', room: gid, mode, seed, theme: race.theme, stake: room.stake,
    onchainRoom: room.onchainRoom,
    racers: entrants.map(e => ({ id:e.id, name:e.name, char:e.char, bot:e.bot })),
  });
  // tell each human which racer is theirs
  for (const e of entrants){ const c = clients.get(e.id); if (c && !e.bot) send(c, { t:'you', id:e.id }); }

  // 3-2-1 countdown, then tick
  let n = 3;
  bcast(room, { t:'countdown', n });
  const cd = setInterval(() => {
    n--;
    bcast(room, { t:'countdown', n });
    if (n <= 0){ clearInterval(cd); runRoom(room); }
  }, 1000);
}

function runRoom(room){
  room.interval = setInterval(() => {
    room.race.step();
    bcast(room, { t:'state', snap: room.race.snapshot() });
    if (room.race.over) finalizeRoom(room);
  }, 1000 / TICK_HZ);
}

async function finalizeRoom(room){
  if (room.finalized) return; room.finalized = true;
  clearInterval(room.interval);
  const winId = room.race.winnerId();
  const order = room.race.finishOrder.map((id, i) => {
    const e = room.entrants.find(x => x.id === id) || {};
    return { id, name: e.name, char: e.char, place: i+1, bot: !!e.bot };
  });

  let settleResult = null;
  if (room.mode === 'staked' && room.onchainRoom && settle.settlementEnabled()){
    const win = room.entrants.find(e => e.id === winId);
    if (win && win.addr){
      try { settleResult = await settle.finishRace(room.onchainRoom, win.addr); }
      catch(e){ settleResult = { error: e.message }; }
    } else settleResult = { error: 'winner had no wallet address' };
  }

  bcast(room, { t:'result', winner: winId, order, settle: settleResult });
  for (const e of room.entrants){ const c = clients.get(e.id); if (c){ c.room = null; c.state = 'idle'; } }
  setTimeout(() => rooms.delete(room.id), 10000);
}

// ---- per-connection handling --------------------------------------------
function dropFromQueues(c){
  casualQ = casualQ.filter(id => id !== c.id);
  for (const [k, q] of stakedQ) stakedQ.set(k, q.filter(id => id !== c.id));
}

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health'){ res.writeHead(200, {'content-type':'application/json'});
    return res.end(JSON.stringify({ ok:true, clients: clients.size, rooms: rooms.size,
      settle: settle.settlementEnabled() })); }
  res.writeHead(200, {'content-type':'text/plain'}); res.end('Fun Dash PvP server\n');
});
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  const c = { id: 'c'+nextCid++, ws, name:'Racer', char:0, addr:null, room:null, state:'idle', handshake:null };
  clients.set(c.id, c);
  send(c, { t:'welcome', id: c.id, field: FIELD });

  ws.on('message', async (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch(e){ return; }
    switch (m.t){
      case 'hello':
        c.name = String(m.name || 'Racer').slice(0, 14);
        c.char = Math.max(0, Math.min(NUM_CHARS-1, m.char|0));
        if (m.addr) c.addr = String(m.addr);
        break;
      case 'find':
        if (c.state !== 'idle') break;
        if (m.addr) c.addr = String(m.addr);
        if (m.mode === 'staked'){
          if (!c.addr){ send(c, { t:'error', msg:'connect a wallet before a staked race' }); break; }
          enterStaked(c, Number(m.stake) || 0.1);
        } else enterCasual(c);
        break;
      case 'staked_room':                 // host reports the on-chain RaceRoom it created+joined
        if (c.handshake && c.handshake.host === c){ c.handshake.onchainRoom = String(m.room); c.handshake.hostJoined = true;
          send(c.handshake.guest, { t:'stake_join', room: String(m.room), stake: c.handshake.stake });
          tryStartStaked(c.handshake); }
        break;
      case 'staked_joined':               // guest confirms it joined the host's room on-chain
        if (c.handshake && c.handshake.guest === c){ c.handshake.guestJoined = true; tryStartStaked(c.handshake); }
        break;
      case 'input':
        if (c.room){ const room = rooms.get(c.room); if (room && !room.finalized) room.race.input(c.id); }
        break;
      case 'cancel':
        dropFromQueues(c); if (c.handshake) failHandshake(c.handshake, 'opponent cancelled'); c.state = 'idle';
        send(c, { t:'cancelled' });
        break;
      case 'ping': send(c, { t:'pong' }); break;
    }
  });

  ws.on('close', () => {
    dropFromQueues(c);
    if (c.handshake) failHandshake(c.handshake, 'opponent disconnected');
    // if mid-race, the sim keeps running (their racer just stops getting inputs)
    clients.delete(c.id);
  });
  ws.on('error', () => {});
});

httpServer.listen(PORT, () => {
  console.log(`Fun Dash PvP server on :${PORT}  (settle=${settle.settlementEnabled()?'ON':'off'}, themes=${THEME_KEYS.length})`);
  if (settle.settlementEnabled()) settle.operatorAddress().then(a => console.log('  operator address:', a)).catch(()=>{});
});
