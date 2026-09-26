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
- [ ] **Keyboard focus visible (#310)** — Tab through header → controls → composer: every stop
      shows the 2px amber ring; mouse clicks show no ring (text fields excepted — UA behavior).
- [ ] **Screen-reader spot check (#307)** — with an SR running, Tab through the header + composer:
      "Toggle theme", "Help", "Conversation history", "New chat", "Create a custom Mode", "Voice input",
      "Send" announce meaningfully; the connection dot announces its state.
- [ ] **Page title in header** — title truncates without pushing the action buttons out; tooltip
      shows the full URL; blank/new-tab pages show "— no page —". At dock width (~400px) the
      brand collapses to the icon and a long page title still shows ≥16 characters (#296).
- [ ] **`/` skills picker** — opens instantly on the second use (no "Loading skills…" flash, given
      a warm session); "+N more skill folders" note appears when folders were skipped.
- [ ] **`%` picker folder arming** — ＋ on a folder arms a 📁 chip; row click still navigates.
- [ ] **`@` autocomplete** — rows show page title + dimmed host; two same-host tabs are
      distinguishable, and same-TITLE tabs get a path suffix in the strip + @ rows (#305).
      distinguishable; chips match.
- [ ] **Navigate action moves the tab** — ask Zo to navigate (e.g. "go to
      example.com") in Co-browse Mode: the tab really changes URL, the panel
      shows "📍 Navigating to …" followed by the done text, and a failed
      navigation shows a persisted error line instead of a "Navigated" lie
      (the panel's NAVIGATE path is invisible to e2e when the shell differs).
- [ ] **Diagnostics share (24h paste)** — with Debug mode on, Settings →
      Features → 🔗 Share diagnostics uploads the metadata-only bundle and
      copies an expiry link; opening it shows timings only — no page text,
      tokens, browsed URLs, or identifying config. With Debug mode off the
      button is disabled.
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

## 0.2.8 additions (conversation-id debug tooling, 0.2.8.0)

- [ ] **`#con_…` conversation-id chip** — after any send, the assistant footer shows a
      muted monospace chip with the truncated thread id; hover shows the FULL id;
      click copies the full id (chip flips to "Copied ✓" briefly).
- [ ] **↗ Open in Zo** — Settings → Connection → "Zo Web Origin": set it to your Zo
      chat host (e.g. `https://<slug>.zo.computer`) and save; NEW assistant footers
      show ↗ next to the chip; clicking opens `<origin>/?chat=<id>&t=chats` at the
      right thread in Zo's web UI. Empty origin → ↗ never renders (chip still copies).
- [ ] **History cards** — chats with a Zo thread show ⧉ (copy id) and ↗ (open in Zo)
      beside ✎/⬇/🗑; both act on that conversation's thread id; ⧉ flips to ✓ on copy.
- [ ] **Origin validation** — saving a garbage origin ("not a url") flags a clear
      error and persists nothing; a valid http(s) URL saves with "✅ Saved!".

## 0.3.0 additions (protocol skill + slim tails, prompt-budget gate)

- [ ] **📜 Protocol-skill chip** — after a Co-browse ACTION send (e.g. "click the first
      link"), the prompt-inspector meta row shows `📜 protocol skill ✓ vX.Y.Z.W — slim
      tail` once the skill has installed into the workspace (first action turn of a
      browser session; the mock/live workspace needs the write to succeed). Before it
      verifies — or after a failed install — the chip reads `📜 protocol skill
      unverified — inline tail (<reason>)` and the preview shows the full grammar.
- [ ] **Slim-tail preview honesty** — with the chip in the ✓ state, the inspector's
      prompt preview names `cobrowse-protocol-skill` and does NOT contain
      `click{selector}`; toggling to a read query ("summarize this page") removes the
      📜 line entirely (reads skip the skill path).
- [ ] **Stub tail on follow-ups (#237)** — second READ question in the SAME chat
      produces a preview whose tail is `Continue on this thread. Answer the request
      directly in plain markdown.` (no "Page content is NOT attached" line); a fresh
      chat's first read question still shows the full not-attached contract.
- [ ] **No regression on tuned Modes** — Settings → Prompts: give Co-browse a custom
      instruction; a slim-tail action turn must still include that custom line
      (user-tuned instructions are never dropped by the skill slim).

## 0.3.1 additions — Recipes R2 + R3 (#256, #257)

- [ ] **🧾 Recipes button opens the library popup** — by the composer option row;
      rows show name / version / steps / params (`*` = required) / 💻 local or 🌐
      workspace badge; Esc and the button toggle close it; a send closes it too.
- [ ] **Library row actions** — ▶ Run closes the popup and starts the run (params
      card when required params exist); ✎ Rename edits inline (Enter commits,
      Escape cancels); 🗑 Delete needs a second confirming click and only removes
      the local entry (a workspace-origin row's file stays); ↥ Save writes to the
      workspace (overwrite renders the confirm card when the mock/live target
      exists).
- [ ] **Import footer** — a valid workspace path imports (system line + row
      appears with 🌐 badge); an invalid recipe shows the validator errors inside
      the popup; `../../etc` paths refuse.
- [ ] **Learned-card save offer (#256)** — after `!recipe record` stops, the
      "🧠 Learned locally" card offers Save to workspace; clicking it renders the
      overwrite confirm card when the target exists.
- [ ] **Heal write-back offer (#256)** — after a healed run whose origin is a
      workspace file, the terminal line is followed by the "Healed cues are local
      only" card; one click saves (version bumps a patch); local-origin runs and
      already-saved runs show no offer.
- [ ] **Skill export (#257)** — ⤓ Export writes SKILL.md + references/recipes.md
      under `/home/workspace/Skills/<slug>/` and posts a system line with both
      paths; the bundle contains "documentation only" and no captured values.

## 0.3.0 walkthrough log (#244)

Round scaffold: walk every section above on a FRESH profile and an EXISTING profile,
logging `pass/fail + commit SHA + notes` per row in `docs/qa/usability-walkthrough-0.3.0.md`
(create it at walkthrough time — sections: base checklist → 0.2.7 → 0.2.8 → 0.3.0).
Every friction point found files per the QA playbook with a concrete UX proposal;
quick wins fix in-slate, larger redesigns triage to the backlog with rationale.

Log results (pass/fail + commit SHA) in the release PR description.

## 0.3.2 — composed recipes (C1 #289 / C2 #290)

- [ ] **↧ Save-as-recipe offer** — complete a `!handoff` run; the done line
      offers the save; the name is prefilled from the goal slug; a
      validation failure renders the validator's reasons (never a silent
      no-op); a saved draft shows in the library as 🤖 composed · unverified.
- [ ] **Rehearsal strictness** — run a composed draft; the checkpoint card
      has NO "Skip check"; verify passes/fails honestly; passing the done
      step promotes (verified badge, version bump); an aborted rehearsal
      leaves the entry a draft.
- [ ] **Compose park cards** — `!recipe compose` on a form-bearing page: the
      value park card appears (never an auto-filled field); filling the page
      by hand + Done continues; a `PARK: q | a | b` reply renders option
      buttons; `!recipe compose stop` and ✕ both abort and disarm (no further
      capture).
- [ ] **Single-session rule** — while composing, `!recipe record` refuses
      with a clear error, and vice versa.

## 0.3.4/0.3.5/0.3.6 additions (walked 2026-09-25 — docs/qa/usability-walkthrough-0.3.6.md)

- [ ] **Connection pane (0.3.4)** — Zo Username + Token only; Advanced `<details>` shows derived space/web endpoints; a hand-edited Advanced value survives save; Test Connection works against the derived endpoint.
- [ ] **⚡ Jev card (0.3.4)** — enable toggle → key Show/Hide (masked, announced) → **Test Jev** returns the probe result; thresholds persist; with Jev off, runs show no Jev vocabulary.
- [ ] **ONE Save Settings (0.3.4/#340)** — exactly one submit (sticky bottom bar); dirty dot on edit, cleared on save; the toast announces Saved/errors (`role=status`); switching Modes in the Prompts editor auto-persists the outgoing draft.
- [ ] **Prompts editor save honesty (#398)** — edit a Mode field → Save → "✅ Saved!" toast; a value like `1234` in Text Budget saves (no silent native-validation block).
- [ ] **Threat-model surfaces (0.3.5)** — context-tier chip on assistant footers shows tier + reason tooltip; recipe library popup opens focused, Esc closes and refocuses the trigger (a11y round).
- [ ] **Reduced motion (0.3.6)** — OS "reduce motion" on: the background-chat pulse, mic/tts pulses and spinners are still (no animation); panel usable as normal.
