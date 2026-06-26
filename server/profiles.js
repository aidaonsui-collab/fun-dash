// ---------------------------------------------------------------------------
//  Wallet-bound player identities + stats (persisted on the Railway volume).
//
//  One profile per wallet address, keyed by the wallet (the permanent, unforgeable
//  ID). Display names are SET-ONCE and globally UNIQUE; claiming one requires a
//  wallet signature (verified in server.js) so nobody can register a name for a
//  wallet they don't own. A profanity filter blocks obvious NSFW names at claim,
//  and the dev (admin) can hide / rename / ban any profile for the rest.
//
//  Stats (games / wins / SUI won) are server-authoritative — only written when a
//  race the server ran finishes — so the leaderboard can't be faked.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || (safeDir('/data') ? '/data' : __dirname);
const FILE = path.join(DATA_DIR, 'profiles.json');
function safeDir(d){ try { fs.accessSync(d, fs.constants.W_OK); return true; } catch(e){ return false; } }

// NSFW/abuse filter — used defensively to REJECT names. Not exhaustive (admin moderation
// covers the rest); normalises common leetspeak so "f4ggot"/"sh1t" are caught too.
const BAD = [
  'nigger','nigga','faggot','fag','retard','rape','rapist','molest','pedo','paedo','cp',
  'cunt','whore','slut','bitch','fuck','shit','cock','dick','pussy','penis','vagina','boob',
  'tits','anal','cum','jizz','semen','wank','jerkoff','blowjob','handjob','dildo','porn',
  'sex','orgasm','nazi','hitler','kkk','chink','spic','kike','tranny','dyke','coon','beaner',
  'asshole','bastard','bollock','wanker','twat','prick','knob','arse','goatse','hentai',
  // common number/char obfuscations caught directly (leet recovery can't get these)
  'f4ck','fck','fuk','phuck','sh1t','sh!t','b1tch','d1ck','c0ck','pu55y','pus5y','a55','azz','n1gg','p3do','f4g',
];
function leet(s){
  return String(s).toLowerCase().replace(/[^a-z0-9]/g,'')
    .replace(/0/g,'o').replace(/1/g,'i').replace(/!/g,'i').replace(/3/g,'e').replace(/4/g,'a')
    .replace(/5/g,'s').replace(/7/g,'t').replace(/8/g,'b').replace(/@/g,'a').replace(/\$/g,'s');
}
function isClean(name){
  const raw = String(name).toLowerCase().replace(/\s/g,'');   // keeps digits/punct → catches f4ck, sh!t
  const lt  = leet(name);                                     // normalizes leet → catches f4ggot, sh1t→shit
  return !BAD.some(w => raw.includes(w) || lt.includes(w));
}

const byWallet = new Map();    // wallet(lowercased) -> profile
const byNameLower = new Map(); // nameLower -> wallet
const norm = w => String(w||'').toLowerCase();
const pub = p => ({ wallet:p.wallet, name:p.name, games:p.games, wins:p.wins, sui:p.sui, hidden:!!p.hidden, banned:!!p.banned });

function load(){
  try {
    const raw = JSON.parse(fs.readFileSync(FILE,'utf8'));
    for (const p of raw.profiles||[]){ byWallet.set(p.wallet, p); byNameLower.set(p.nameLower, p.wallet); }
    console.log(`profiles: loaded ${byWallet.size} from ${FILE}`);
  } catch(e){ console.log(`profiles: starting fresh at ${FILE}`); }
}
let saveT = null;
function persist(){
  if (saveT) return;
  saveT = setTimeout(() => { saveT = null;
    try { fs.writeFileSync(FILE, JSON.stringify({ profiles:[...byWallet.values()] })); }
    catch(e){ console.error('profiles: save failed', e.message); }
  }, 800);
}

function get(wallet){ return byWallet.get(norm(wallet)) || null; }
function getPublic(wallet){ const p = get(wallet); return p ? pub(p) : null; }

// validate + register a set-once unique name for a wallet (signature already verified by caller)
function claimName(wallet, name){
  wallet = norm(wallet); name = String(name||'').trim();
  if (name.length < 2 || name.length > 16) return { error:'Name must be 2–16 characters.' };
  if (!/^[A-Za-z0-9 ._-]+$/.test(name))     return { error:'Use letters, numbers, spaces, . _ - only.' };
  if (!isClean(name))                       return { error:'That name isn’t allowed.' };
  if (byWallet.has(wallet))                 return { error:'This wallet already has a name (names are permanent).' };
  const lower = name.toLowerCase();
  if (byNameLower.has(lower))               return { error:'That name is already taken.' };
  const p = { wallet, name, nameLower:lower, games:0, wins:0, sui:0, hidden:false, banned:false, created:Date.now() };
  byWallet.set(wallet, p); byNameLower.set(lower, wallet); persist();
  return { profile: pub(p) };
}

// server-authoritative stat update after a race the server ran
function recordResult(wallet, { won=false, sui=0 } = {}){
  const p = byWallet.get(norm(wallet)); if (!p) return;   // only claimed wallets appear on the board
  p.games++; if (won) p.wins++; if (sui > 0) p.sui = +(((p.sui||0)+sui)).toFixed(4); persist();
}

function leaderboard(limit=50){
  return [...byWallet.values()]
    .filter(p => !p.hidden && !p.banned)
    .sort((a,b) => b.sui - a.sui || b.wins - a.wins || a.created - b.created)
    .slice(0, limit).map(pub);
}

// admin moderation (server.js gates this behind a deployer-wallet signature)
function adminSet(wallet, patch){
  const p = byWallet.get(norm(wallet)); if (!p) return { error:'no such profile' };
  if (patch.name !== undefined){
    const name = String(patch.name).trim(), lower = name.toLowerCase();
    if (name.length<2 || name.length>16) return { error:'bad name length' };
    if (byNameLower.has(lower) && byNameLower.get(lower)!==p.wallet) return { error:'name taken' };
    byNameLower.delete(p.nameLower); p.name = name; p.nameLower = lower; byNameLower.set(lower, p.wallet);
  }
  if (patch.hidden !== undefined) p.hidden = !!patch.hidden;   // hide = off the leaderboard
  if (patch.banned !== undefined) p.banned = !!patch.banned;   // ban = hidden + can't play staked
  persist();
  return { profile: pub(p) };
}

load();
module.exports = { get, getPublic, claimName, recordResult, leaderboard, adminSet, isClean };
