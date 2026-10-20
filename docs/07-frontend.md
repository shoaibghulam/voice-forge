# 07 — Frontend

React 19 + Vite + TypeScript. Client-only SPA served by FastAPI in production; Vite dev
server proxies `/api` in development.

## Design direction: "the signal path"

Not a dashboard of cards. The app is drawn as **one audio signal path** — the way a
song actually travels through the system — like the routing on a mixing console:

```
 SONGS ──▶ SEPARATE ──▶ CLEAN ──▶ QC ──▶ SLICE ──▶ PITCH ──▶ TRAIN ──▶ INDEX ──▶ VOICE
  12        lead vox     echo/      27.4    1,284     rmvpe     ep 34/100            ✓
            12/12        hiss       min     clips              ▓▓▓▓░░░
```

- Each stage is a **node** on a horizontal line. The line between nodes is the "cable";
  while a stage runs, a pulse travels along its cable (animated `transform: translateX`
  on a small gradient element, clipped by the cable — no layout animation).
- Finished cables stay lit; a failed node turns the cable red at that point and opens
  its error card beneath it with the hint and last log lines.
- On narrow screens the path turns vertical.

**Visual language**: warm, studio-like. Off-white "paper" with ink text in light mode;
deep blue-black with warm whites in dark mode. One accent drawn from Balochi embroidery
(deep red), one signal colour (teal) for live activity. Numbers in a monospace with
tabular figures so counters don't jitter.

### Tokens (`src/styles/tokens.css`)

```css
:root {
  --color-bg: #f6f2ea;  --color-surface: #fffdf8;  --color-ink: #1d1b18;
  --color-muted: #6b645a;  --color-line: #d9d1c3;
  --color-accent: #a3262a;   /* embroidery red: primary actions, selection */
  --color-signal: #127a74;   /* live activity: pulses, running stage, charts */
  --color-ok: #2f7a3a;  --color-warn: #b7791f;  --color-fail: #b42318;
  --font-sans: "Instrument Sans", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --radius: 6px;  --space: 4px;
  --dur-fast: 120ms;  --dur: 240ms;  --ease: cubic-bezier(.2,.7,.2,1);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --color-bg: #0f1216; --color-surface: #161b21; --color-ink: #efe9df;
    --color-muted: #9a958c; --color-line: #2a313a;
    --color-accent: #e0565b; --color-signal: #3cc3b8;
  }
}
:root[data-theme="dark"] { /* same values as above */ }
```

Tailwind 4 reads these through `@theme`. No raw hex outside this file.

## Screens

| Route | Screen | Purpose |
|---|---|---|
| `/login` | Login | Username + password |
| `/` | Singers | Library: each singer as a row with portrait initial, usable minutes, active voice, last run status, mini signal path |
| `/singers/$id` | Singer | Tabs: Songs · Dataset · Training · Voice |
| `/singers/$id/songs` | Songs | Drop zone (tus), per-file progress, era tag, duplicate warnings |
| `/singers/$id/dataset` | Dataset QC | Minutes gauge vs 5/10/30 min marks; rejected clips grouped by reason; listen + override; F0 range on a piano strip |
| `/jobs/$jobId` | **Live run** | The A→Z view (below) |
| `/singers/$id/voice` | Voice | Checkpoint timeline, recommended badge, A/B with real voice, blind test, export |
| `/covers/new` | New cover | Upload song, pick singer/checkpoint, controls, consent notice |
| `/covers/$id` | Cover | Progress path, then player with Original / Converted / Vocal only / Backing |
| `/analyses` | Analyse | Top-nav tab: past analyses with language · tempo · key · genre |
| `/analyses/new` | New analysis | Upload (tus, purpose `analysis`), lyrics language Auto / Balochi / Urdu / Persian / English (Balochi = rough-draft note) |
| `/analyses/$id` | Analysis | Live signal path while running; player, timeline, lyrics, music style |
| `/queue` | Queue | Running + queued jobs, reorder, cancel |
| `/system` | System | GPU, doctor checks, benchmark results, disk |

## The live run view (`/jobs/$jobId`)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Arif Baloch · training run 3            elapsed 01:12:40   ETA ≈ 00:48:10    │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━░░░░░░░░ │  job bar
│                                                                              │
│  ●──────●──────●──────●──────◉~~~~~~○──────○──────○                          │  signal path
│ prep   slice  pitch  feats  TRAIN   index  export samples                    │
│ 0:42   0:31   3:10   2:05   58:12                                            │
├───────────────────────────────────────┬──────────────────────────────────────┤
│ EPOCH 34 / 100      batch 112/160     │ GPU  RTX 4050 Laptop                 │
│ ◐ reel  (spins with steps/s)          │ util ▮▮▮▮▮▮▮▮▯▯ 82%                   │
│ epoch time 1:43 (avg 1:41)            │ VRAM ▮▮▮▮▮▮▮▯▯▯ 4.6 / 6.0 GB  shared 0 │
│                                       │ 71°C  · 1,905 MHz · 78 W             │
│ Loss  [mel ▾] [kl] [fm] [adv] [disc]  │                                      │
│  ╲                                    │ Checkpoints                          │
│   ╲___                                │ ▸ ep 30  sim .71  ▶  ★ recommended    │
│       ╲____ ___                       │ ▸ ep 25  sim .69  ▶                   │
│            ‾‾  ‾‾‾──── live           │ ▸ ep 20  sim .66  ▶                   │
├───────────────────────────────────────┴──────────────────────────────────────┤
│ Log  [all] [warnings]  ▸ arif | epoch=34 | step=5440 | batch=112/160 …        │
└──────────────────────────────────────────────────────────────────────────────┘
  [Pause after next checkpoint]   [Cancel]
```

### Elements and their animation

| Element | Data | Animation (transform/opacity only) |
|---|---|---|
| Job bar | weighted stage progress | `scaleX` from left, spring (Motion), never width |
| Signal path nodes | `stage.*` events | node fill fades in on done; running node has a soft opacity "breathing" ring; pulse travels along the running cable |
| Stage durations | `stage.completed` | numbers count up with tabular figures (text change, no motion) |
| Elapsed / ETA | client clock + `eta` events | elapsed ticks every second from `started_at`; ETA shows "≈" when method is estimate |
| Reel | `train.step` rate | SVG reel `rotate`; speed eases toward steps/s, stops on pause/fail |
| Epoch counter | `train.epoch` | digit roll (`translateY` within a clipped box) |
| Loss chart | `train.scalars` | uPlot; series toggles; log-scale option; live tail marker; checkpoints as vertical ticks |
| GPU meters | `gpu.sample` | VU-meter bars `scaleY`/`scaleX`, 1 Hz with 200 ms ease; shared memory > 0 turns the meter amber (doc 05 A11) |
| Checkpoints | `checkpoint.saved` / `.scored` | new row slides in (`AnimatePresence`, `translateY` + opacity); star appears on recommended |
| Log | `log.line` | virtualised list; auto-follow unless the user scrolls up |
| Failure | `stage.failed` | error card expands under the node (opacity + `translateY`), with hint and "Retry stage" |

`prefers-reduced-motion`: pulses, reel and digit rolls are replaced by static states;
progress bars jump instead of spring. All state still visible.

### Data flow in the browser

```
EventSource(/api/jobs/:id/events)          ← src/live/useJobEvents.ts
   │ parse + validate type (zod, generated union)
   ├─► queryClient.setQueryData(['job', id], reducer)   status, stages, ETA
   ├─► lossBuffer.push(...)   ring buffer (ref) → uPlot.setData in requestAnimationFrame
   ├─► gpuBuffer.push(...)    ring buffer (ref) → meters read latest in rAF
   └─► logStore.append(...)   capped at 5,000 lines in view, rest downloadable
```

High-rate data never goes through React state: 1 Hz GPU + streaming loss would re-render
the page constantly. React state holds only what changes the layout (stage status,
checkpoint list).

On reconnect `EventSource` resends `Last-Event-ID` automatically; a connection badge
shows "live" / "reconnecting" / "replaying".

## Other screen details

- **Upload**: `tus-js-client` with a custom drop zone; per-file progress bars (`scaleX`);
  resumes on refresh via stored upload URLs (localStorage, wrapped in try/catch).
- **Dataset QC**: minutes gauge with marks at 5 (minimum), 10 (warning), 30 (target).
  Rejected clips grouped by reason with a 3 s waveform each (wavesurfer, peaks computed
  server-side); keyboard: `space` play, `k` keep, `r` reject.
- **Voice**: checkpoint timeline as a horizontal strip; click two checkpoints → A/B player
  switches between them at the same playhead position. Blind test mode hides labels.
- **Cover**: four synced players (original, converted mix, vocal only, backing) sharing
  one playhead; controls with plain names (Pitch, Timbre strength, Breath protection,
  Vocal level, Reverb), advanced settings collapsed.

- **Analysis** (`features/analyses/`): the job's SSE stream drives the same `SignalPath`
  (separate · lyrics · style · timeline); each finished stage refetches the analysis so its
  part appears at once (plus a 3 s poll). One `<audio>` (Song ↔ Vocals only, same position).
  **Timeline**: sections as a grid strip sized by length, sung = signal colour, chorus =
  accent top edge, playhead grows by `scaleX`, click = play from there. **Lyrics**:
  timestamped lines (RTL + `lang` for Arabic script), the sung line is `aria-current`, click =
  seek and play; Edit (PATCH `lyrics_text`), Copy, Download .txt; Balochi shows the
  rough-draft note. **Music style**: tempo / key / loudness as a meter bridge, stem share
  bars, instrument chips with scores, genre and mood top 3 with the "approximate" note.
  Export JSON in the header.

## Accessibility

- Semantic landmarks; the signal path is an ordered list (`<ol>`) with `aria-current="step"`
  on the running stage.
- Live region (`aria-live="polite"`) announces stage changes, not every epoch.
- Charts have a text summary ("mel loss 0.84, down 12% over 10 epochs") and a data table toggle.
- Visible `:focus-visible` rings; all controls keyboard reachable; colour never the only
  signal (failed node also gets an icon and text).

## Frontend layout

```
frontend/src/
├── main.tsx, router.tsx
├── api/          client.ts (fetch + envelope), generated types, events.ts
├── live/         useJobEvents.ts, reducers.ts, ringBuffer.ts, eta.ts
├── features/
│   ├── singers/  songs/  dataset/  run/  voice/  covers/  queue/  system/
├── components/   SignalPath, Meter, Reel, DigitRoll, LossChart, Waveform, AbPlayer
├── styles/       tokens.css, base.css
└── test/         msw handlers, SSE fixtures (recorded event streams)
```

## Testing

- **Vitest**: reducers (event → state), ETA math, ring buffer, event parsing.
- **Component tests**: SignalPath renders every status; reduced-motion snapshot.
- **MSW**: replays a recorded SSE stream of a real run at 20× speed.
- **Playwright E2E**: upload fixture songs → prepare (mocked worker) → train (recorded
  events) → refresh mid-run (timeline restored) → select checkpoint → convert → play.
- Screenshot checks of the live run view in light and dark at 1440 px and 390 px widths.
