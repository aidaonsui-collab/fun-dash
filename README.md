# Fun Dash 🏃💨

A *Fun Run*–style auto-runner racing game starring **Sui meme coins**. One self-contained HTML file — no build step, no dependencies. Open `index.html` and race.

## Play

Open `index.html` in any modern browser (or serve the folder with any static server, e.g. `python3 -m http.server`).

- **Jump / double-jump:** `Space` · `↑` · `W` · tap the screen
- **Use item:** `↓` · `Shift` · the item button (bottom-left)

Pick your meme, vote a map, and be first to the flag.

## Features

- **7 playable Sui-meme mascots** — HIPPO (Sudeng), BLUB, MIU, LOFI, AXOL, FUD, PANS (PandaSui)
- **Multi-tier platform courses** with chasms, ledges, scaffold towers & rope bridges, and ramping difficulty
- **3 themed maps** — Green Hills / Candy Shop / Hidden Caves — with a pre-race vote lobby
- **7 power-ups** — 🚀 Boost, ⚡ Lightning, 🪚 Saw trap, 🛡️ Shield, 🦘 Mega-jump, 🧲 Magnet, 🥊 Punch
- Procedural squash-&-stretch / tumble animation, a power-up kill-feed, and rubber-band balancing
- 3 AI opponents, WebAudio sound effects

## Project layout

```
index.html              the entire game (canvas + vanilla JS)
assets/*.png            the 7 character sprites (transparent)
assets/process_sprite.py  green-screen → trimmed transparent sprite tool
```

## Credits

Character sprites are original recreations of each token's profile art. This is a fan homage and is **not** affiliated with Dirtybit's *Fun Run* or with any of the referenced tokens.
