---
key: qa-stream-accumulation-debugger-conflict
title: A second CDP debugger (Playwright tracer) silently breaks background stream accumulation on tab close
severity: P2
surface: streaming
source: matrix
found: 2026-09-10
---
**What breaks:** when a second CDP debugger is attached to the extension's
pages (demonstrated: Playwright's `trace: "retain-on-failure"` tracer), closing
a backgrounded chat tab mid-stream loses the turn's reply — the conversation
record freezes with only the user message (`updatedAt` stops at close time);
the stream's final answer is never persisted. With tracing off, the identical
flow persists the answer correctly every time.

**Evidence (matrix lane, m1-chat-tabs.spec.ts):**
- With trace ON: 5/5 runs lose the answer — storage dump at T+9s shows
  `messages: [user only]`, `updatedAt` frozen ~2s after the close.
- With trace OFF (`--trace off`): 2/2 runs green — answer lands, footer,
  context chip, history restore all correct.

**Probable mechanism (unconfirmed):** the tracer holds the CDP debugger that
the extension's `getActiveTabContext()` fast-path (`chrome.debugger`) also
needs; the contention breaks more than capture — the stream-completion save
path never runs for the backgrounded chat.

**User-facing trigger (needs one manual check):** a user with DevTools open on
a page while a background chat streams may hit the same contention (Chrome
allows one debugger per target). Confirm during triage; if DevTools reproduces
the loss, raise to P1.

**Suggested direction:** make the completion save independent of the debugger
fast-path (fall back cleanly when `chrome.debugger` is contended), or detect
contention and keep the stream alive on the pure messaging path.
