// ---------------------------------------------------------------------------
//  Wallet-ownership proof: verify a Sui personal-message signature and recover
//  the signer's address. Used to (a) prove a wallet owner before claiming/loading
//  a profile, and (b) gate admin moderation to the dev's wallet.
// ---------------------------------------------------------------------------
let _verify = null;
async function lazy(){
  if (!_verify){ const m = await import('@mysten/sui/verify'); _verify = m.verifyPersonalMessageSignature; }
  return _verify;
}

// true iff `signature` is a valid signature of the exact `message` string by `expectedAddr`.
async function ownsWallet(message, signature, expectedAddr){
  if (!message || !signature || !expectedAddr) return false;
  try {
    const verify = await lazy();
    const bytes = new TextEncoder().encode(String(message));
    const pk = await verify(bytes, signature);
    return pk.toSuiAddress().toLowerCase() === String(expectedAddr).toLowerCase();
  } catch(e){ return false; }
}

// message must be recent (replay guard) and bind the claimed wallet
function freshFor(message, wallet, maxAgeMs = 5*60*1000){
  if (typeof message !== 'string') return false;
  if (!message.toLowerCase().includes(String(wallet).toLowerCase())) return false;
  const m = message.match(/ts:(\d{10,})/);
  if (!m) return false;
  const age = Date.now() - Number(m[1]);
  return age >= -30000 && age <= maxAgeMs;   // within 5 min (small clock-skew tolerance)
}

module.exports = { ownsWallet, freshFor };
