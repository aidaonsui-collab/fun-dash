// ---------------------------------------------------------------------------
//  Fun Dash — AUTHORITATIVE deterministic race sim (Node, server-side).
//
//  This is the trust anchor for Phase-1 PvP: the server runs the race from a
//  seed + each player's JUMP input timeline. Positions, collisions and the
//  WINNER are computed here — clients only render snapshots and send jumps, so
//  a client can never claim a position or a win it didn't earn.
//
//  Determinism: fixed dt per step + a seeded RNG for the (server-side) bot
//  decisions. Same (seed, inputs) -> byte-identical race every time, which also
//  makes any result re-simulatable for dispute/audit.
//
//  buildTrack / segAt / segBefore / the constants are copied VERBATIM from the
//  browser game (index.html) so the track the server simulates is pixel-for-
//  pixel the track the client builds from the same seed+theme.
// ---------------------------------------------------------------------------

// ---- world / tuning (must stay in lockstep with index.html) ----
const WORLD_LEN  = 9400;
const START_X    = 120;
const GROUND_Y   = 430;
const GRAVITY    = 1600;
const JUMP_V     = 580;
const DJUMP_V    = 540;
const BASE_SPEED = 250;
const BOOST_MULT = 1.75;
const PIT_DEPTH  = 150;
const CH_W       = 46;
const CH_H       = 52;
const TIERS = [GROUND_Y, GROUND_Y - 58, GROUND_Y - 116, GROUND_Y - 168, GROUND_Y - 220];
const HAZARD_BY_THEME = { caves:'saw', neon:'saw', frost:'rock', volcano:'rock', dunes:'pit', swamp:'pit' };
// theme-key order must match Object.keys(THEME) in index.html (only matters when
// no theme is passed; we always pass one explicitly, so order is belt-and-braces)
const THEME_KEYS = ['hills','candy','caves','frost','dunes','neon','volcano','swamp'];

function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

// pick a deterministic theme from the seed, independent of the track rng stream
function themeForSeed(seed){ return THEME_KEYS[Math.abs((seed ^ 0x9e3779b9) >>> 0) % THEME_KEYS.length]; }

// --- VERBATIM port of buildTrack from index.html (themeOverride always supplied) ---
function buildTrack(seed, themeOverride){
  const rnd = mulberry32(seed);
  const keys = THEME_KEYS;
  const theme = themeOverride || keys[(rnd()*keys.length)|0];
  const clampTier = v => Math.max(0, Math.min(TIERS.length-1, v));
  const segments = [], obstacles = [], crates = [], hazards = [];
  const hazType = HAZARD_BY_THEME[theme];

  segments.push({ x0:0, x1:780, y:GROUND_Y });
  let cursor = 780, tier = 0;

  let lastTunnel = false;
  while (cursor < WORLD_LEN - 900){
    const prog = cursor / WORLD_LEN;
    let gap = 0, up = false;
    if (lastTunnel){
    } else if (rnd() < 0.36 + prog*0.20){
      if (rnd() < 0.50){ tier = clampTier(tier+1); up = true; gap = 70 + rnd()*38 + prog*26; }
      else { tier = clampTier(tier + (rnd()<0.5?0:-1)); gap = 92 + rnd()*52 + prog*40; }
    } else if (rnd() < 0.5){
      tier = clampTier(tier - 1);
    }
    cursor += gap;
    const y = TIERS[tier];
    const tunnel = (!up && !lastTunnel && cursor > 1500 && rnd() < 0.17);
    const len = tunnel ? (300 + rnd()*210) : (230 + rnd()*240);
    const seg = { x0:cursor, x1:cursor+len, y };
    if (tunnel){ seg.tunnel = true; seg.ceil = y - 76; }
    segments.push(seg);
    let hadHurdle = false;
    if (!tunnel && len > 200 && rnd() < 0.32 + prog*0.18){
      obstacles.push({ x: seg.x0 + 80 + rnd()*(len-160), w:26, h: 32 + rnd()*30 + prog*22, y });
      hadHurdle = true;
    }
    if (hazType && !tunnel && !hadHurdle && len > 250 && rnd() < 0.30 + prog*0.18){
      const hx = seg.x0 + len*(0.40 + rnd()*0.20);
      if (hazType==='saw')       hazards.push({ type:'saw',  x:hx, y, range:Math.min(64,(len-150)/2), spd:1.3+rnd()*0.9, phase:rnd()*6.283 });
      else if (hazType==='rock') hazards.push({ type:'rock', x:hx, y, period:1.5+rnd()*1.1, phase:rnd()*3, top:y-(155+rnd()*70) });
      else { const w=Math.min(86,56+rnd()*30); hazards.push({ type:'pit', x:hx, y, w, x0:hx-w/2, x1:hx+w/2 }); }
    }
    if (rnd() < 0.66)
      crates.push({ x: seg.x0 + len*(0.4+rnd()*0.25), y: tunnel ? y-40 : y-74, w:34, h:34, gotBy:[] });
    cursor = seg.x1;
    lastTunnel = tunnel;
  }
  segments.push({ x0:cursor, x1:WORLD_LEN+700, y:GROUND_Y });
  return { theme, segments, obstacles, crates, hazards };
}

function segAt(track, x){
  const S = track.segments;
  for (let i=0;i<S.length;i++){ if (x >= S[i].x0 && x < S[i].x1) return S[i]; }
  return null;
}
function segBefore(track, x){
  const S = track.segments; let best = S[0];
  for (const s of S){ if (s.x1 <= x+1 && s.x1 > best.x1) best = s; }
  return best;
}

// ---------------------------------------------------------------------------
//  Race — authoritative state machine
// ---------------------------------------------------------------------------
const DT = 1/30;          // fixed timestep (determinism)
const FINISH_GRACE = 4.0; // sec to keep simulating after the winner finishes
const MAX_RACE_T   = 90;  // hard cap so a stuck race can't run forever

class Race {
  // entrants: [{ id, name, char, isBot }]
  constructor(seed, entrants){
    this.seed = seed >>> 0;
    this.theme = themeForSeed(this.seed);
    this.track = buildTrack(this.seed, this.theme);
    this.rng = mulberry32(this.seed ^ 0x5bd1e995);   // bot-decision stream
    this.t = 0;
    this.finishOrder = [];   // racer ids in the order they crossed the line
    this.over = false;
    this.racers = entrants.map((e, i) => ({
      id: e.id, name: e.name, char: e.char, isBot: !!e.isBot, idx: i,
      x: START_X, y: GROUND_Y, vy: 0, onGround: true, jumps: 0,
      boostT: 0, stunT: 0, runPhase: i * 1.7,
      finished: false, finishTime: 0, place: 0,
      fallStreak: 0, lastFallX: -9999, lastPit: null, hitObstacles: new Set(),
      wantJump: false,
    }));
  }

  racer(id){ return this.racers.find(r => r.id === id); }

  // queue a jump for the next step (the ONLY thing a client may influence)
  input(id){ const r = this.racer(id); if (r && !r.finished) r.wantJump = true; }

  stun(r, s){ if (r.stunT < s) r.stunT = s; }

  applyJump(r){
    if (r.stunT > 0) { r.wantJump = false; return; }
    if (r.onGround){ r.vy = -JUMP_V; r.onGround = false; r.jumps = 1; }
    else if (r.jumps < 2){ r.vy = -DJUMP_V; r.jumps = 2; }
    r.wantJump = false;
  }

  // deterministic bot: jump near a gap edge / before a hurdle / at a sweeping saw or pit lip
  botThink(r){
    const seg = segAt(this.track, r.x);
    if (r.onGround && r.stunT <= 0 && seg){
      const distEdge = seg.x1 - r.x;
      const after = segAt(this.track, seg.x1 + 6);
      const gapAhead = distEdge < 46 && (!after || after.y < seg.y - 4);
      const hurdleClose = this.track.obstacles.some(o => o.x>r.x && o.x-r.x<100 && o.x-r.x>0 && Math.abs(o.y-seg.y)<24);
      const hazClose = this.track.hazards.some(hz => {
        if (Math.abs(hz.y-seg.y) > 24) return false;
        if (hz.type==='saw'){ const sx=hz.x+Math.sin(this.t*hz.spd+hz.phase)*hz.range; return sx>r.x && sx-r.x<88; }
        if (hz.type==='pit'){ return hz.x0>r.x-12 && hz.x0-r.x<78; }
        return false;
      });
      if ((gapAhead || hurdleClose || hazClose) && this.rng() < 0.97){ r.vy = -JUMP_V; r.onGround=false; r.jumps=1; }
    } else if (!r.onGround && r.jumps<2 && r.vy>10 && !segAt(this.track, r.x)){
      r.vy = -DJUMP_V; r.jumps = 2;
    }
  }

  step(){
    if (this.over) return;
    const dt = DT;
    this.t += dt;

    let leadX = 0;
    for (const r of this.racers) leadX = Math.max(leadX, r.finished ? WORLD_LEN : r.x);

    for (const r of this.racers){
      if (r.finished) continue;

      if (r.boostT>0) r.boostT -= dt;
      if (r.stunT>0)  r.stunT  -= dt;

      if (r.isBot) this.botThink(r);
      else if (r.wantJump) this.applyJump(r);
      r.wantJump = false;

      // hazard pit slog + one-time trip
      let inPit = null;
      if (r.onGround){
        for (const hz of this.track.hazards){ if (hz.type==='pit' && r.x>hz.x0 && r.x<hz.x1){ inPit=hz; break; } }
      }
      if (inPit){ if (r.lastPit!==inPit && r.stunT<=0) this.stun(r,0.4); r.lastPit=inPit; }
      else r.lastPit=null;

      // horizontal motion (rubber-band keeps the pack together)
      let spd = BASE_SPEED;
      const behind = leadX - r.x;
      spd *= 1 + Math.min(behind / 1500, 1) * 0.22;
      if (behind < 30) spd *= 0.93;
      if (r.boostT>0) spd *= BOOST_MULT;
      if (r.stunT>0)  spd *= 0.20;
      if (inPit)      spd *= 0.5;
      r.x += spd * dt;

      // vertical physics on tiered platforms
      const wasAir = !r.onGround;
      r.vy += GRAVITY * dt;
      r.y  += r.vy * dt;
      const seg = segAt(this.track, r.x);
      if (seg){
        if (r.vy >= 0 && r.y >= seg.y){ r.y = seg.y; r.vy = 0; r.onGround = true; r.jumps = 0; }
        else if (r.y < seg.y){ r.onGround = false; }
      } else {
        r.onGround = false;
        if (r.y > GROUND_Y + PIT_DEPTH){
          const back = segBefore(this.track, r.x);
          if (Math.abs(r.x - (r.lastFallX||-9999)) < 80) r.fallStreak=(r.fallStreak||0)+1; else r.fallStreak=1;
          r.lastFallX = r.x;
          if (r.fallStreak >= 3){
            const fwd = this.track.segments.find(s => s.x0 > r.x);
            if (fwd){ r.x = fwd.x0 + 24; r.y = fwd.y; } else { r.x = back.x1 - 60; r.y = back.y; }
            r.fallStreak = 0; this.stun(r, 0.4);
          } else {
            this.stun(r, 0.8); r.x = back.x1 - 60; r.y = back.y;
          }
          r.vy = 0; r.onGround = true; r.jumps = 0;
        }
      }

      // tunnel ceiling caps jump height
      if (seg && seg.tunnel && r.y - CH_H < seg.ceil){ r.y = seg.ceil + CH_H; if (r.vy < 0) r.vy = 0; }

      // hurdle collisions (trip once each)
      for (let i=0;i<this.track.obstacles.length;i++){
        const o = this.track.obstacles[i];
        if (r.hitObstacles.has(i)) continue;
        if (Math.abs(r.x - o.x) < (CH_W/2 + o.w/2)){
          const feetTop = r.y - CH_H, topY = o.y - o.h;
          if (feetTop > topY - 6) this.stun(r, 0.4);
          r.hitObstacles.add(i);
        }
      }

      // map hazards: sweeping saws + falling rocks (time-based, deterministic)
      for (const hz of this.track.hazards){
        if (hz.type==='saw'){
          const sx = hz.x + Math.sin(this.t*hz.spd + hz.phase)*hz.range;
          if (r.stunT<=0 && Math.abs(r.x-sx) < 24 && (r.y - hz.y) > -28) this.stun(r, 0.5);
        } else if (hz.type==='rock'){
          const ph = ((this.t+hz.phase) % hz.period)/hz.period;
          const ry = hz.top + (hz.y - hz.top)*ph;
          if (r.stunT<=0 && ph>0.5 && Math.abs(r.x-hz.x) < 22 && Math.abs(r.y-ry) < 30) this.stun(r, 0.5);
        }
      }

      if (r.onGround && r.stunT<=0) r.runPhase += dt * (spd/26);

      if (r.x >= WORLD_LEN && !r.finished){
        r.finished = true; r.finishTime = this.t; r.x = WORLD_LEN;
        r.place = this.finishOrder.length + 1;
        this.finishOrder.push(r.id);
      }
    }

    // end conditions: everyone home, or grace elapsed after first finish, or hard cap
    const allDone = this.racers.every(r => r.finished);
    const graceUp = this.finishOrder.length > 0 && (this.t - this.racer(this.finishOrder[0]).finishTime) > FINISH_GRACE;
    if (allDone || graceUp || this.t > MAX_RACE_T){
      // anyone who never crossed gets ranked by distance
      const stragglers = this.racers.filter(r => !r.finished).sort((a,b)=>b.x-a.x);
      for (const r of stragglers){ r.place = this.finishOrder.length + 1; this.finishOrder.push(r.id); }
      this.over = true;
    }
  }

  // compact wire snapshot (only what the renderer needs)
  snapshot(){
    return {
      t: +this.t.toFixed(3),
      over: this.over,
      racers: this.racers.map(r => ({
        id: r.id, x: +r.x.toFixed(1), y: +r.y.toFixed(1),
        vy: +r.vy.toFixed(1), g: r.onGround?1:0, b: r.boostT>0?1:0, s: r.stunT>0?1:0,
        rp: +r.runPhase.toFixed(2), f: r.finished?1:0, pl: r.place,
      })),
    };
  }

  winnerId(){ return this.finishOrder[0] || null; }
}

module.exports = { Race, buildTrack, segAt, segBefore, themeForSeed,
  WORLD_LEN, START_X, GROUND_Y, DT, THEME_KEYS };
