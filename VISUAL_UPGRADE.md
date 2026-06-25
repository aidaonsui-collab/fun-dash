# Fun Dash — Premium Visual Upgrade

A rendering-layer overhaul that takes Fun Dash from "clean prototype" to a **juicy, premium Fun Run–style racer** — without touching gameplay logic, tuning, or the single-file architecture.

- **`index.html`** — the upgraded game (drop-in; same controls, same physics, same flow).
- **`index-original.html`** — your original, untouched, for diffing/rollback.
- Now ships **5 themed maps**, all identical physics — Green Hills, Candy Shop, Hidden Caves, **Frost Peaks** (snow / pines / falling snow), **Sunset Dunes** (golden-hour desert / cacti / blowing sand). The map-vote lobby and random races pick from all five.

Everything below ships **already implemented** in `index.html` unless marked _Next_. The render pipeline is the only thing that changed: `update()` got a handful of FX/camera hooks, but no rule that affects who wins changed.

---

## 1. Visual Style Guide — the "Fun Run premium" rules

**Color & light**
- **Saturated, high-key skies** with a 3-stop vertical gradient (bright zenith → soft horizon) + a glowing sun/moon disc. Never a flat fill.
- **Value separation by depth.** Each parallax layer is a *flatter, cooler, lower-contrast* version of the one in front. Far hills are hazy; the play layer is crisp and saturated.
- **One warm accent runs the whole UI**: `#ffd24a` gold = "you / reward / energy" (player marker, nametag, crate glow, finish banner, win state).
- **Light comes from above-front.** Top edges get a bright lip (`grassLip`, bevel highlights); bottoms get a soft occlusion shadow. This single rule is 80% of the "3D-ish cartoon" feel.
- **Glows are additive.** All energy — sun, crystals, fireflies, boost flames, shields, sparks — is drawn with `globalCompositeOperation:'lighter'` so it *adds* light instead of painting over.

**Animation philosophy ("juice")**
- **Every action gets a reaction.** Jump → dust. Land → shockwave ring + dust kick + screen-shake scaled to impact. Pickup → pop + sparkle burst. Hit → tumble + starburst + ring + shake. Boost → flames + rim-glow + speed lines. Finish → confetti.
- **Squash & stretch is volume-preserving and physics-driven.** Stretch on the way up (`sy↑, sx↓`), squash on landing, keyed off real `vy`/`landT`, not a looping timer.
- **Secondary motion everywhere, cheaply:** grass blades sway, crates bob+rotate, the moon-lit moss twinkles, fireflies drift, the finish flag waves per-column.
- **Easing, not snapping.** Camera lerps toward its target; nothing teleports.
- **Restraint.** Effects are short (0.3–0.6 s) and additive so they read as energy, not clutter. The particle system is hard-capped (520) so a chaotic moment never tanks the frame-rate.

**Rules of thumb**
1. If it moves, it casts a shadow that *shrinks and fades with height*.
2. If it's a reward, it's gold and it pulses.
3. If it's danger, it's red/orange and it has a hazard pattern + glow.
4. Background detail must be **world-anchored** (seeded by world-x), never screen-x — otherwise it boils/shimmers as you scroll.
5. Prefer **gradients over `shadowBlur`** in the hot loop; `shadowBlur` is per-pixel-expensive, a cached radial gradient is not.

---

## 2. Prioritized Upgrade Plan (phased)

### ✅ Phase 1 — Shadows, Particles, Polish _(shipped)_
Highest impact / lowest effort. The "feel" layer.
- Generalized **particle system** (gravity, drag, spin, additive batching, life-fade) replacing the 3 ad-hoc spawners.
- **Soft cast shadows** under characters (height-aware), crates, hurdles, traps.
- **Screen-shake** on landings/hits/boost, **eased camera**, **vignette**, colored **lightning flash**.
- Run-dust, landing shock-rings, pickup/burst sparkles, **CSS** countdown pop + item-slot pulse.

### ✅ Phase 2 — Richer Backgrounds & Character Juice _(shipped)_
The "production value" layer.
- **Multi-layer parallax** per theme: gradient sky + sun/moon + clouds/stars, far ridge with rim-light, mid ridge, and a **themed mid-ground decor band** (trees / candy / crystals + stalagmites).
- **Theme ambient particles**: pollen (hills), sparkles (candy), fireflies (caves).
- **Rebuilt ground**: graded earth columns, pebbles, scalloped grass with bright lip + **theme tufts** (grass blades / frosting-drips + sprinkles / glowing moss), graded chasm pits with darkened walls.
- **Rebuilt props**: beveled glowing **crates** (bob/rotate/orbiting sparkle), metallic motion-blurred **saws** with danger-glow + spark shower, **plank rope-bridges**, glowing **waving finish flag**, shaded hazard **hurdles**.
- **Character juice**: punchier squash/stretch, boost **rim-glow + flame trail + speed lines**, animated **shield bubble**, tumble+star stun, **pill nametags**, glowing player marker.

### 🔜 Phase 3 — Full sprite animation & advanced FX _(next; needs art)_
The "mobile-flagship" layer. Diminishing returns vs. effort, but where to go next:
- **Multi-frame run cycles** per character — _the engine hook is now shipped_ (`SHEET` config + `drawSprite` slices a horizontal strip, **speed-linked**, air/stun fall back to the static PFP). Only the art is left: drop in a strip and a character switches from procedural bob to true leg/arm motion.
- **Facial expression swaps**: a tiny strained/dizzy/grin overlay frame per state (boost / hit / win). Even a 3-frame "face strip" composited over the body sells personality.
- **Per-theme weather**: candy-floss clouds drifting low, cave water drips + light shafts, hill wind gusts that bend grass harder.
- **Depth-of-field / color grading** pass: a cheap full-screen multiply+screen LUT per theme for cinematic cohesion.
- **Pre-rendered glow atlas**: bake the soft shadow + boost glow + shield to an offscreen canvas once and blit, to claw back any budget on low-end phones.

---

## 3. Key code changes / new helpers

All additive; original function names kept where callers existed, so nothing else needed editing.

**Color / math helpers**
- `shade(hex, p)` — lighten (`p>0`) / darken (`p<0`) a hex by a fraction. The backbone of every gradient.
- `rgba(hex, a)` — hex → `rgba()` with alpha, for glows.
- `rndAt(i, salt)` — cheap deterministic 0–1 hash. **Seed it with world-x** to anchor scenery so it never shimmers.
- `themeDust()` — picks the dust tint for the current theme.

**Particle system** (`P(o)` factory + spawners, `drawFx`/`drawParticle`)
- One generic particle: `{type,x,y,vx,vy,g,drag,r,r2,c,life,rot,vrot,add}`. Integrated in `update()` with per-particle gravity/drag/spin; **drawn in two passes** (normal, then one batched additive pass) to minimize canvas state changes.
- Spawners: `spawnDust`, `spawnLand` (ring+kick), `spawnTrail` (flame+smoke), `spawnSpark`, `spawnBurst`, `spawnRing`, `spawnConfetti`, `spawnStars`, `spawnBolt`, plus `screenShake`. Types render as `smoke / flame / spark / ring / confetti / stars`.

**Background suite** (replaces `drawClouds`+`drawHills`)
- `drawSky` (gradient + sun/moon glow + clouds or starfield), `drawBackground` (two graded parallax ridges + rim-light) → `drawDecor` → `drawTree` / `drawCandy` / `drawCrystal`, `drawAmbient`/`initAmbient` (drifting motes), `drawSpeedLines`, `drawBolts`, `drawVignette`.

**Ground / props**
- `drawGround(T)` → `drawPlatform` (graded earth, pebbles, scallop grass, theme tufts) + `drawHurdle`. Rebuilt `drawCrates`, `drawTraps`, `drawFinish`, `drawScaffolds`.

**Character** — `drawSprite` rebuilt: height-aware cast shadow, stronger squash/stretch, boost rim-glow (flames are particles), animated shield, tumble-stun with orbiting stars, pill nametag, glowing marker.

**`update()` hooks** (FX only — no logic change): eased camera + shake decay; richer particle integration; run-dust cadence / boost-trail; landing & respawn impacts; per-item rings/bursts/bolt in `useItem`; impact burst + shake in `stun`; finish confetti; idle saw sparks.

**Performance guardrails**: particle cap (520); additive draws batched; gradients (not `shadowBlur`) for soft shapes; off-screen platforms/props/racers culled (already in engine); scenery seeded by world-x so it's stable, not recomputed-random per frame.

---

## 4. Minimal new-asset guidelines (for Phase 3)

The game already looks premium with the **existing single PFP sprite per character** — Phase 3 is optional polish. To get the biggest leap for the least art:

**A. Character run sprite-strips (highest value)**
- **Already wired** — enable a character with `SHEET.hippo = { src:'assets/hippo_run.png', frames:8 }` near the sprite preload (empty `SHEET` = today's static look). Animation auto-links to run speed; **air & stun keep the static PFP**, so you can convert one character at a time.
- One horizontal PNG strip per character, **6–8 frames**, transparent, trimmed, consistent foot-baseline.
- Suggested cell: **~220×260 px** (matches current ~78px draw height at 3× for crispness). Keep the **anchor at the feet centre**.
- Frames: contact → down → pass → up for each leg (a classic 2-step run). Add a **jump** and a **land** pose at the end of the strip if you can.
- Loading: same pattern as today — `new Image()`; draw `frame = floor(runPhase) % FRAMES`, slicing with the 9-arg `drawImage`. Squash/stretch still multiplies on top.

**B. Face strip (cheap personality)**
- A tiny **3-frame** face overlay per character (`neutral / strain / dizzy`), ~96×96, drawn over the body at the eye-line, swapped by state. Sells expression without re-animating the whole body.

**C. Power-up icons as a sprite sheet (sharpens HUD + crates)**
- One **7-icon sheet** (boost/lightning/saw/shield/spring/magnet/glove), 128×128 each, chunky cartoon with a thick rim-light, on transparent. Use in the item slot and floating above crates instead of emoji for a consistent look.

**D. Optional background plates**
- A single wide **1920×400 PNG per theme** for the far ridge can replace the procedural far layer if you want hand-painted depth. Keep mid/near procedural for parallax variety.

**Art-direction north star for all new assets**: thick clean outlines, big readable silhouettes, top-down soft light (bright top lip + soft bottom occlusion), 1–2 rim highlights, saturated mid-tones, **no gradients baked so dark they muddy** — let the engine's additive glows do the lighting.

---

## 5. Quick-win UI/CSS polish (shipped + ideas)

**Shipped**
- `#stage::after` inset frame (soft inner vignette + top gloss) for a "screen" feel.
- **Countdown** number pops with an overshoot keyframe each tick (`countPop`).
- **Item slot** glows/pulses when full (`itemPulse`); menu portraits gently float.
- Player **place** number and **track pips** get a soft glow.

**Ideas (next)**
- Animate the HUD **progress pips** with a tiny trailing motion-blur on lead changes.
- Kill-feed entries **slide+fade in** rather than appear.
- A subtle **CRT/scanline or grain** overlay toggle for retro-arcade mode.
- Results list rows **stagger-in** (40ms each) with the winner row doing a gold shimmer.
