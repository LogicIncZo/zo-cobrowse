# Manual Panel QA Checklist — run before every `dev → main` promotion

**Why this exists (#66):** Playwright drives the sidepanel as a *tab* — CDP cannot reach the real
side-panel shell. Bugs that only manifest in the shell are invisible to the whole automated suite
(exhibit A: #62 — native `<select>` popups never opened on mouse click in the panel). This 5-minute
manual pass is the release gate for that class.

**How:** load the unpacked `extension/` at `chrome://extensions` (↻ reload if already loaded),
open the side panel on a normal website.

- [ ] **Dropdowns open on click** — MODEL, PERSONA, MODE (and any new `<select>`/shimmed control):
      mouse click opens the popup; choosing an option applies (check the prompt inspector changes);
      ↑/↓/Enter/Esc work; clicking elsewhere closes.
- [ ] **Theme applies live** — switch theme via the header toggle → the panel repaints; open
      Settings → change theme → the panel follows without reload (and vice versa).
- [ ] **Write-assist popover themed** — focus a textarea on a light site and a dark site; the
      Zo icon + popover match the chosen theme (dark theme → dark widget).
- [ ] **Toggles render + persist** — 📷 Image and 🧩 DOM toggles visible even with no referenced
      tabs; 🧩 DOM off → 🚫 DOM label sticks across panel reopen; tier chip shows the cap reason
      after a send.
- [ ] **Page title in header** — title truncates without pushing the action buttons out; tooltip
      shows the full URL; blank/new-tab pages show "— no page —".
- [ ] **`/` skills picker** — opens instantly on the second use (no "Loading skills…" flash, given
      a warm session); "+N more skill folders" note appears when folders were skipped.
- [ ] **`%` picker folder arming** — ＋ on a folder arms a 📁 chip; row click still navigates.
- [ ] **`@` autocomplete** — rows show page title + dimmed host; two same-host tabs are
      distinguishable; chips match.
- [ ] **TTS** — if voices are installed: Settings → Speech shows the voice dropdown filtered by
      language; picking one + Read aloud uses it (ear check); zero-voice systems show the disabled
      hint.
- [ ] **Debug diagnostics (if #67 shipped)** — toggle debug mode, do one send, Copy diagnostics
      exports timings and NO page text or token. **0.2.7:** entries carry `traceId` tags
      (`turn-<sessionId>…`, `exec:…`) and the export shows `"version": 2` + a
      `startup · worker-eval` entry.

## 0.2.7 additions (run once the 0.2.7 slate is loaded)

- [ ] **API endpoint field (#94)** — Settings → Connection shows the new "API Endpoint" input
      hydrated with the saved value (default `https://api.zo.computer/zo/ask`); Test Connection
      succeeds against it; a garbage URL fails with the URL quoted in the error.
- [ ] **Reconnecting banner (#95)** — simulate a transient network drop (DevTools → Network →
      offline for ~2s during a send): the "➳ Reconnecting… attempt 2 of 3" line appears, then
      the answer renders — NO error card.
- [ ] **Chat export (#108)** — History → ⬇ on a card downloads `zo-chat-<slug>-<date>.md`;
      open it: title header, role-labeled turns, 💭 reasoning blockquote, tier chip; no
      system/error noise.
- [ ] **Stale-build guard (#109)** — ↻ reload the extension with a website tab open: the tab
      still responds to panel captures (no stale script), and the panel shows the one-time
      "🔄 Extension updated" banner once (dismiss → gone for good).
- [ ] **🤖 `!handoff` read-only digest (Lane E acceptance run)** — on a multi-page site, send
      `!handoff read these pages and summarize the pricing`: run starts (priming → running),
      progress line ticks (pages · turns · parked · minutes), chained turns render live,
      digest lands via done(); ✕ stop aborts mid-run (end card 🛑; no further fetches).
- [ ] **Handoff boundary + budget** — a goal that tempts a click parks it (⛔ boundary in the
      batch card, park count in the progress line); a tiny budget (`!handoff` run with default
      budget, or let it run long) pauses honestly with the reason.
- [ ] **Handoff badge + notification (#103)** — the extension badge shows ▶ while the run is
      live and clears when it ends; closing the panel mid-run still lands the done/blocked
      notification.
- [ ] **Reasoning streams inline (probe #110)** — on a thinking model (e.g. GLM), a hard
      question shows the 💭 trace growing DURING the stream, not only at the end.

Log results (pass/fail + commit SHA) in the release PR description.
