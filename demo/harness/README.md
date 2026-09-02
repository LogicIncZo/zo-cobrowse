# Zo Co-browse — demo harness

Reproducible build kit for the narrated product demo (`../zo-cobrowse-demo-*.mp4`,
1280x720, ~2:05, `en-IN-NeerjaNeural` narration).

## Release cadence

Every tagged release ships a narrated demo (`demo/zo-cobrowse-demo-<date>.mp4`) produced by `build/make_demo.sh` — see `CONTRIBUTING.md` § Release Demos. When a release adds a user-visible feature, extend `narration.txt` and the choreography beats, then regenerate.

## Why a harness?

agent-browser cannot load MV3 extensions, and headless Chrome renders no docked
side panel. The honest approximation: the **real extension UI** (sidepanel.html
markup/classes) + the **real article page** side-by-side, driven by the real
action protocol (`navigate|click|extract|scroll|wait|done`) against the real
`/zo/ask` API. The chat choreography is pre-rolled (one-time API calls, replayed
during recording) so the capture is deterministic.

## Files

- `site/harness.html` — split-screen: sidepanel UI (left) + article iframe (right).
  Choreography timeline is absolute (`at(ms)`); `window.boom()` starts it. The
  `const SUM = SUMMARIZE_TEXT;` placeholder is replaced at build time with the
  pre-rolled summarize response.
- `site/article.html` — cleaned UPI Wikipedia article (fetched fresh each build).
- `site/endcard.html` — closing card (screenshot → 30s still).
- `build/prep_article.py` — strip scripts/refs, inject demo stylesheet, save
  page-context text + `context.json`.
- `build/extract_elements.py` — compact element list in the extension's
  `compactEl` format (`[h2 "History" #History]`, `[a "PhonePe" a[href="./PhonePe"]]`).
- `build/preroll.py` — two live `/zo/ask` calls (ask + cobrowse modes) with
  extension-faithful prompts; saves `resp_summary.json` / `resp_cobrowse.json`.
  Cobrowse response must be JSON: `[{"type":"click","selector":"#History"},
  {"type":"extract","selector":"a[href]"},{"type":"done","response":"..."}]`.
- `build/narration.txt` — six narration segments, `seg|text` lines.
- `build/make_demo.sh` — full pipeline: fetch → prep → preroll → inject → TTS →
  record 3 passes → compose with the timeline table below.

## Timeline (final cut)

| Scene | Wall time | Content | Narration at |
|---|---|---|---|
| S1 | 0–22.5 | GitHub repo, scripted scrolls | 0.7s |
| S2 | 22.5–45.2 | Docs site, scripted scrolls | 23.0s |
| S3–S5 | 45.2–95.2 | Harness: idle → connect → typing → thinking → summary stream (16–20.5) → mode flash + co-browse query (29.2) → click/extract trace (35.6–43) → extract result (44.3) → done + footer (46.2) | 45.8 / 54.2 / 68.8s |
| S6 | 95.2–125.2 | Endcard still | 96.0s |

Boom fires 0.7s into the harness clip, so in-clip beat times ≈ wall − 44.5s.

## Recording gotchas (learned the hard way)

- **agent-browser idle recording collapses**: the screencast only sends frames
  on page activity. The harness embeds a 60fps `requestAnimationFrame` clock
  (bottom-right, sub-visible opacity) to force real-time capture. Pure static
  pages (GitHub) also collapse — accept ~1s drift there or add motion.
- **`set viewport` resets on every `open`** — always set it after opening, before
  `record start` (else you get window-chrome-sized 1280x634).
- **Double-launch race**: `close` → `open` → `record start` back-to-back spawns
  a second browser and the eval hits a blank context. Sleep ~2s after close,
  ~3s after open, and sanity-check the page before recording.
- **Recording must be a single foreground bash call** — backgrounding the
  record chain truncates the capture.
- Reuse ONE browser instance for all passes; `record stop` before `close`.
- Wrote outputs only inside `build/record/` — `agent-browser record stop` saves
  relative to its own daemon cwd; use paths under the launched browser's cwd.

## Regenerate

```bash
cd demo/harness/build
pip install edge-tts        # narration voice
./make_demo.sh              # needs ZO_CLIENT_IDENTITY_TOKEN in env
```

Note: the pre-rolled responses reflect the Wikipedia article as of 2026-08-30.
If the article's History section changes materially, the extract beat
(8 links) and summary figures may drift — `preroll.py` re-runs automatically
and `harness.html` renders whatever comes back.
