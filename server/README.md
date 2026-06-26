# Fun Dash — Online PvP server (Phase 1)

Server-authoritative realtime racing. Clients connect over WebSocket, get matched
into rooms, and send **only jump inputs**. The server runs the deterministic race
sim, broadcasts snapshots, decides the winner, and (for staked rooms) settles
on-chain as the contract **operator** — so a player can never fake a position or a win.

## Deployed

Live on Railway (project `fun-dash-server`, aidaonsui-collab):

- **https://fun-dash-server-production.up.railway.app** (`/health` for status)
- WebSocket: **wss://fun-dash-server-production.up.railway.app**

The game (`../index.html`) defaults to this URL, so it's online out of the box.
Redeploy after server changes with `railway up` from this directory.

## Run locally

```bash
cd funrun-game/server
npm install
npm start                 # realtime only, no chain  → ws://localhost:8125
```

Point the game at a local server by appending `?server=ws://localhost:8125` to
the game URL (otherwise it uses the deployed server above).

Env knobs: `PORT` (8125), `TICK_HZ` (30), `CASUAL_WAIT` (6000ms before bots fill a
casual field), `STAKE_WAIT` (45000ms handshake window).

## Modes

- **Quick Match** — fills with deterministic bots up to a 4-racer field. No money.
  Works with a single player. This is the part you can run with zero setup.
- **Staked PvP** — two real players, both staked into one on-chain `RaceRoom`,
  winner takes pot − 10%. Requires the on-chain operator setup below + a Sui wallet
  (Testnet) in each browser.

## Enabling staked on-chain settlement

The contract lets `creator OR operator` call `finish_race`. For server authority we
point the contract's `operator` at the server's own key so **no player** can settle.

1. Generate a server keypair and fund it with a little testnet SUI for gas
   (e.g. `sui client new-address ed25519`, then faucet it).
2. As the **AdminCap holder**, set the operator to that key (one call):
   ```
   update_config(AdminCap, PlatformConfig, treasury, 1000 /*fee bps*/, <server-address>)
   ```
3. Start the server with the key present:
   ```bash
   OPERATOR_KEY=suiprivkey1... npm start      # logs: settle=ON + operator address
   ```

With `OPERATOR_KEY` set, a staked match: host `create_race`+`join_race` (wallet) →
guest `join_race` (wallet) → server verifies both stakes on-chain → server
`start_race` → race → server `finish_race(winner)`. Without the key, staked rooms are
disabled and Quick Match still works.

## Test

```bash
npm test        # headless: determinism/reproducibility + 2 live WS clients + bots,
                # asserts both clients get the same server-decided winner and that a
                # client spamming "I won" can't change the result.
```

Contract (testnet): pkg `0xb466991c…39a0d52`, config `0x3b76b1…94944b`, fee 10%.
Override via `FUNRUN_PKG` / `FUNRUN_CONFIG` / `FUNRUN_NET`.
