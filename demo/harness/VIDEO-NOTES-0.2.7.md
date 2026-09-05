# 0.2.7 release video — notes

Release: `v0.2.7` (2026-09-02) · Follows the release-demo convention in
[`README.md`](./README.md) and `CONTRIBUTING.md` § Release Demos.
Recording scenario: [`e2e/demo-027-handoff.spec.ts`](../../e2e/demo-027-handoff.spec.ts)
against the deterministic mock (`e2e/mock-zo/server.mjs`) — no live `/zo/ask` calls.

## Story of the cut

0.2.7's headline is **🤖 `!handoff`** — chat graduates into an unattended run.
The daily-use wins (reconnect banner, Markdown export, update banner, honest
boundary parks) are shown *inside* the handoff narrative rather than as
disconnected feature bumps. Target: **~2:30**, 1280x720, `en-IN-NeerjaNeural`.

## Footage plan

| Part | Source | Content |
|---|---|---|
| A | existing harness reels (re-record S1–S2 only) | repo + docs-site establishing shots; endcard re-rendered with 0.2.7 notes |
| B | `ZO_DEMO=1 npx playwright test e2e/demo-027-handoff.spec.ts` | the 8-beat handoff scenario below |
| C | harness co-browse reel (reuse 0.2.6 S3–S5) | 15s bridge: "and chat still co-browses" — keeps continuity with the 2026-08-30 demo |

## Beats (Part B — from the spec)

| Beat | What's on screen | Hold |
|---|---|---|
| 1 | establishing shot of harness | 2.5s |
| 2 | type `!handoff compare the pricing across these fixture pages` (45ms/char) → send | 0.9s + send |
| 3 | turn 1: progress line, first batch card — `⛔ parked` row (read-only boundary) + sibling navigate actually moves the site tab | 3.5s |
| 4 | turn 2 chained: second batch card, site lands on `checkout.html` | 2.5s |
| 5 | turn 3: "Pricing digest" assistant card → `Handoff done` system line, progress line clears | 3.0s |
| 6 | history view → `⬇` Markdown export → download lands → back to chat | ~4.2s |
| 7 | simulated update: "Extension updated" banner → dismiss | ~3.4s |
| 8 | `__flaky/arm` → "➳ Reconnecting…" banner → answer recovers, no error card | ~5.2s |

## Narration draft (`seg|text`, extends `narration.txt`)

```
s1|Zo Co-browse 0.2.7. The browser assistant that can now take the wheel — and not just for one question. Here's what shipped.
s2|Type !handoff and a goal. That single line hands your chat to an unattended run: Zo plans its turns, navigates the pages, and reports back — while you watch every step.
s3|Watch the honesty built in. A click outside the read boundary? It doesn't sneak it — the batch card says "parked", and Zo routes around it.
s4|Three turns later: a pricing digest, delivered in plain markdown. A badge on the tab while it works, a notification when it's done.
s5|Everything it said is exportable — one click downloads the whole conversation as Markdown.
s6|Daily-use polish in this release: a reconnecting banner that recovers silently instead of erroring, and an update banner that keeps old tabs honest after an upgrade.
s7|Co-browse, handoff, export — all MIT licensed, all open source. Load it unpacked, paste your token, and give your browser a brain. v0.2.7 is live on GitHub.
```

(Reads at ~150 wpm ≈ 2:05 narration; leave breathing room inside beats → ~2:30 cut.)

## Build deltas vs the 0.2.6 kit

1. `site/endcard.html` — version → `v0.2.7`, date → 2026-09-02, add handoff/export/reconnect bullet lines.
2. No `preroll.py` changes needed for Part B (mock-zo server supplies deterministic responses); Part C reuses the existing pre-rolled `resp_summary.json` / `resp_cobrowse.json`.
3. `make_demo.sh` timeline table gains a Part B section (see beats above); compose order: A(S1,S2) → B → C → endcard.
4. TTS: append the seven `s#|` segments above to `narration.txt` (or a 0.2.7 variant file) before the TTS pass.

## Recording gotchas (spec-verified)

- **Never hover `.msg-handoff-line`** — it re-renders on every push; hover's stability wait never settles.
- History overlay is full-screen (`inset:0`) — exit via `#back-to-chat-btn`; the header ☰ is covered and clicking it hangs.
- Beat 8 must be armed from Node (`GET /__flaky/arm`) — page-side fetches race the reload.
- Capture `panel.video()` / `site.video()` paths **before** `context.close()` — videos finalize on close.
- Badge + notification: real `chrome.action` badge/notifications don't render in Playwright captures — the visible proxy is the progress line + "Handoff done" system card; mention the badge in narration only, or overlay a mock tab-strip close-up in the edit.

## Pre-record checklist

- [ ] `bun run verify` green on the release commit
- [ ] `e2e/mock-zo/server.mjs` up; `ZO_DEMO=1` export set
- [ ] endcard re-rendered with 0.2.7 strings
- [ ] 3 recording passes (README rule), pick cleanest
- [ ] final cut length ≤ 2:45; narration sync spot-checked at beats 2/3/5
