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
      exports timings and NO page text or token.

Log results (pass/fail + commit SHA) in the release PR description.
