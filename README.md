# DEAD LINE

**The path you create becomes your next obstacle.**

A portrait mobile arcade game. You are a glowing dot moving forward at a constant
speed. You never move the dot directly — you drag left or right to *bend the path
ahead of it*. Everything you have already driven through freezes solid behind
you, the arena curls you back around into it, and the run ends the moment you
touch your own line, the perimeter, or a hazard.

**Play it: https://keremcan534.github.io/blackblue-dead-line/**

TypeScript · Vite · Phaser 3 · no backend · no image or audio assets.

---

## Run it

```bash
npm install
```

```bash
npm run dev
```

Production build:

```bash
npm run build
```

The build lands in `dist/` and uses relative asset paths, so it can be opened
from `file://` or dropped straight into a Capacitor WebView.

| Script | Does |
| --- | --- |
| `npm run dev` | Vite dev server, exposed on the LAN for phone testing. Port 5173 by default, or `$PORT` if set |
| `npm run build` | Type-check, then build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | Type-check only |

---

## How it plays

- **Drag anywhere** left or right to bend the path in front of you. The control
  is relative to wherever you first touched, so it works under either thumb.
  Arrow keys or `A`/`D` work on desktop.
- The pale, near-white tail right behind you is **still hot** and cannot hurt
  you. Past the pulsing white marker the line has **frozen** and is lethal.
- Frozen path ages **cyan → violet → magenta → red**, getting dimmer and thinner
  as it goes, then burns away. Red means it is about to expire — and that it has
  been there long enough to kill you.
- The arena **curls**, and reverses direction every few seconds (`CURL SHIFT`).
  Out near the rim the arena curls you back toward the middle, so the perimeter
  is something you steer into rather than drift into.
- Shave past your own line, the wall or a hazard for a **near miss**. Each one
  scores more the closer it was, and chains into a combo multiplier up to ×8.
- A green **purge core** appears every 10–15 seconds. Collecting it erases the
  old path in a 200-unit radius and buys you room.
- Hazards arrive at score thresholds: **orbiters** circling the arena centre and
  **drifters** bouncing across it. Both fade in harmlessly for 0.9 s first.

### Modes

| Mode | Rules |
| --- | --- |
| **Endless** | Survive. Difficulty ramps over ~165 s. |
| **Sprint 30** | 30-second clock, roughly twice the ramp rate, near misses worth double. Reaching the whistle is an achievement. |
| **Daily** | The arena is seeded from the local calendar date, so every run that day is the same layout. A per-day best is kept locally. |

High scores, lifetime stats and options are stored in `localStorage`, guarded so
that private-mode or disabled storage degrades to in-memory instead of crashing.

---

## Design notes

### The mechanic

The player has a position `p`, a heading `θ` and a speed `v`:

```
θ += (worldTurn + steer · STEER_RATE) · dt
p += v · (cos θ, sin θ) · dt
```

`worldTurn` is the arena's ambient curl. Near the rim it is blended toward a
turn that points back at the centre, which is what stops a hands-off player from
drifting into the wall while still letting a determined one steer into it.

Every 8 world units the position is appended to a ring buffer. A point older
than `SAFE_TIME` is frozen and lethal. That single rule is the whole game: the
curl guarantees you come back around to where you have been, so your own history
is the level.

There is **no physics engine**. The simulation is pure integrated kinematics on a
fixed 1/120 s timestep with an interpolated render, so movement is smooth but
identical on every device and at every frame rate — a given seed plus a given
input timeline always reproduces the same run. That is what makes the Daily mode
work without a server.

### Why the camera rotates

The camera keeps the player's heading pointing at the top of the screen, so from
the player's point of view they are always travelling upward while the arena
turns around them. Rendering is all world-space, so the grid, the perimeter and
the frozen path rotate together and sell the curl.

### Performance

Targeting 60 fps on mid-range phones:

- Trail points live in preallocated typed arrays (`Float32Array` ring buffer,
  4096 slots) indexed by a counter that is never wrapped, so nothing is
  reallocated or copied during a run.
- Collision is a uniform spatial hash; "am I about to hit my own line" touches
  nine cells.
- The trail is drawn as batched polyline runs. Age increases monotonically along
  the buffer, so a whole run shares one colour and a frame costs roughly twenty
  draw calls regardless of trail length. Runs off-screen are culled against a
  circle (a rotated camera's axis-aligned `worldView` would be wrong).
- No `fillCircle` anywhere in the frame loop — Phaser tessellates arcs into ~100
  segments each. Glows are additive sprites, hazards are two triangles, grid dots
  are `fillRect`.
- The glow pass fades as the arena fills, so dense late-game frames do not blow
  out to white.
- Bloom is faked with stacked additive strokes rather than a post-processing
  pipeline.

### Fairness

The one thing this game must never do is kill you for something you could not
have avoided. `tools/balance-harness.js` measures exactly that: at 10 Hz it
forward-simulates thirteen steering options — including the trail the rollout
itself lays down — and counts how many survive the next few seconds. Across
audited runs the longest stretch with *zero* surviving options is **under one
second**, and it always sits immediately before the crash. Deaths are a
commitment the player made, not a pocket the game closed on them.

The same harness pins the opening beat. A player who does nothing at all gets
their first near miss with their own frozen line at **~7 seconds** and dies on it
at **~7.5 seconds** — the whole hook taught inside the first ten. A player who
holds a line and adjusts it when it stops working runs a median of **~22
seconds**, with good runs past 45.

---

## QA harness

`tools/balance-harness.js` runs the real simulation headlessly, thousands of
times faster than real time. It is never imported by the game. With the dev
server running, from the browser console:

```js
const H = await import('/tools/balance-harness.js');
await H.report();
```

- `H.report()` — hook timing, reference-player survival spread, fairness, determinism
- `H.run(seed, mode, policy, maxT)` — one run
- `H.audit(seed, mode, policy, maxT, horizon)` — fairness audit
- `H.idleBot()`, `H.committedBot()`, `H.referenceBot()` — policies
- `H.determinism()` — same seed twice, byte-identical

---

## Wrapping with Capacitor

`capacitor.config.json` is already present and points at `dist/`. Nothing in the
game assumes a server, and the haptics layer picks up `Capacitor.Plugins.Haptics`
automatically when it is there, falling back to `navigator.vibrate` on the web.

```bash
npm install @capacitor/core @capacitor/cli @capacitor/haptics
npm run build
npx cap add android
npx cap sync
npx cap open android
```

Same for `ios`. The generated `android/` and `ios/` folders are git-ignored.

---

## Layout

```
src/
  main.ts              bootstrap, Phaser config, DPR sizing, focus handling, run lifecycle
  core/
    config.ts          every tunable, difficulty curves, palette
    rng.ts             mulberry32 + daily seed
    storage.ts         guarded localStorage with in-memory fallback
    settings.ts        persisted options
    audio.ts           procedural WebAudio engine
    haptics.ts         Capacitor / vibrate / no-op abstraction
    scores.ts          high scores, daily history, lifetime stats
    types.ts
  game/
    Simulation.ts      the entire game, no Phaser, fixed timestep
    TrailSystem.ts     ring-buffer trail, spatial hash, batched renderer
  scenes/
    BootScene.ts       procedural textures
    GameScene.ts       rendering, input, camera, effects
  ui/ui.ts             DOM overlay controller
  styles.css
tools/
  balance-harness.js   headless QA harness
```

The DOM overlay handles menus and HUD while Phaser owns the canvas — crisp text,
real focus handling and `env(safe-area-inset-*)` support without fighting a
WebGL text renderer.
