// ---------------------------------------------------------------------------
//  On-chain settlement — the server is the trusted OPERATOR.
//
//  Phase-1 trust model: gameplay is server-authoritative, so only the server
//  knows the true winner. The on-chain contract lets `creator OR operator` call
//  finish_race; we set the contract's `operator` to THIS server's key (via
//  config::update_config, run once by the AdminCap holder) so that NO player —
//  not even the room creator — can settle a result they didn't earn.
//
//  Everything here is gated on OPERATOR_KEY being present in the env. Without it
//  the realtime race still runs; it just won't touch chain (good for local dev).
// ---------------------------------------------------------------------------
const PKG     = process.env.FUNRUN_PKG    || '0xb466991c2027c7238002fcc6fd52a7f5e4f60bf34c7ad06e8047a695439a0d52';
const CONFIG  = process.env.FUNRUN_CONFIG || '0x3b76b160d5ed84e25db5350c8bf83bbbddc613fd87b82f11c939dc869a94944b';
const NETWORK = process.env.FUNRUN_NET    || 'testnet';

let _sui = null;          // lazily-loaded @mysten/sui (ESM) + operator keypair
async function lazy(){
  if (_sui) return _sui;
  const { SuiClient, getFullnodeUrl } = await import('@mysten/sui/client');
  const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
  const { Transaction } = await import('@mysten/sui/transactions');
  const client = new SuiClient({ url: getFullnodeUrl(NETWORK) });
  let keypair = null;
  const sk = (process.env.OPERATOR_KEY || '').trim();
  if (sk){
    keypair = sk.startsWith('suiprivkey')
      ? Ed25519Keypair.fromSecretKey(sk)
      : Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(sk.replace(/^0x/,''), 'hex')));
  }
  _sui = { client, keypair, Transaction };
  return _sui;
}

function settlementEnabled(){ return !!(process.env.OPERATOR_KEY && process.env.OPERATOR_KEY.trim()); }

async function operatorAddress(){
  const { keypair } = await lazy();
  return keypair ? keypair.toSuiAddress() : null;
}

// Read a RaceRoom on-chain: who's staked, the pot, and the lifecycle state.
async function readRoom(roomId){
  const { client } = await lazy();
  const o = await client.getObject({ id: roomId, options: { showContent: true } });
  const f = o.data?.content?.fields;
  if (!f) throw new Error('room not found: ' + roomId);
  return {
    state: Number(f.state),                  // 0 waiting, 1 in-progress, 2 finished
    players: (f.players || []).map(String),
    entryFee: BigInt(f.entry_fee),
    pot: BigInt(f.escrow),
    creator: String(f.creator),
  };
}

// start_race (operator) — flips a staked room WAITING -> IN_PROGRESS.
async function startRace(roomId){
  const { client, keypair, Transaction } = await lazy();
  if (!keypair) throw new Error('no OPERATOR_KEY');
  const tx = new Transaction();
  tx.moveCall({ target: `${PKG}::race::start_race`, arguments: [tx.object(CONFIG), tx.object(roomId)] });
  tx.setGasBudget(50_000_000);
  const res = await client.signAndExecuteTransaction({ signer: keypair, transaction: tx, options: { showEffects: true } });
  await client.waitForTransaction({ digest: res.digest });
  if (res.effects?.status?.status !== 'success') throw new Error('start_race failed: ' + JSON.stringify(res.effects?.status));
  return res.digest;
}

// finish_race (operator) — pays winner pot − fee, fee → treasury. THE trust point.
async function finishRace(roomId, winnerAddr){
  const { client, keypair, Transaction } = await lazy();
  if (!keypair) throw new Error('no OPERATOR_KEY');
  const tx = new Transaction();
  tx.moveCall({ target: `${PKG}::race::finish_race`, arguments: [tx.object(CONFIG), tx.object(roomId), tx.pure.address(winnerAddr)] });
  tx.setGasBudget(50_000_000);
  const res = await client.signAndExecuteTransaction({ signer: keypair, transaction: tx, options: { showEffects: true, showEvents: true } });
  await client.waitForTransaction({ digest: res.digest });
  if (res.effects?.status?.status !== 'success') throw new Error('finish_race failed: ' + JSON.stringify(res.effects?.status));
  const ev = (res.events || []).find(e => e.type.endsWith('::race::RaceFinished'));
  return { digest: res.digest, payout: ev?.parsedJson?.winner_payout, fee: ev?.parsedJson?.platform_fee };
}

module.exports = { settlementEnabled, operatorAddress, readRoom, startRace, finishRace, PKG, CONFIG, NETWORK };
