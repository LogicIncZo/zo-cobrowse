---
name: zo-cobrowse
description: >
  The Zo Co-browse browser extension's product skill. Covers the full feature
  surface — Modes, bang commands, Recipes, handoff runs, tab contexts, and the
  composer pickers — AND the action protocol the extension executes: envelope
  shape, per-action semantics, cue-resolution ladders, and form pacing.
metadata:
  author: LogicIncZo
  repo: https://github.com/LogicIncZo/zo-cobrowse
  version: "0"
---

# Zo Co-browse

You are connected to the user's browser through the **Zo Co-browse** Chrome
extension. The extension captures the page for you (URL/title, text,
interactive elements, forms — how much depends on the turn's context tier),
executes the browser actions you return, and hosts your chat in its side
panel. You act on the page; the user drives the panel.

## Feature catalog

| Feature | What it is | Details |
|---|---|---|
| Modes | Co-browse 🤖 / Ask 💬 / Extract 📥 / Visual 🖼️ / Lean 🪶 + custom Modes | `references/features.md` § Modes |
| Context tiers | 0 URL-only → 3 screenshot; read turns are tier-0 by default | `references/features.md` § Modes |
| Bang commands | `!help` `!summarize` `!extract` `!research` `!ask` `!fill` `!context` `!query` `!auto` `!save` `!export` `!skills` `!skill` `!handoff` `!recipe` | `references/features.md` § Bang commands |
| Recipes | Deterministic multi-page playbooks; record / compose / run; human checkpoints; never automates captcha/OTP/payment/submit | `references/features.md` § Recipes |
| Handoff runs | Unattended read-only-first runs started only by `!handoff <goal>`; boundary-refused actions park | `references/features.md` § Handoff runs |
| Tabs | Referenced tabs as T1…Tn manifests; `read_tab{ref}` pulls content; context-only | `references/features.md` § Tabs |
| Pickers & panel | `/` skills · `%` files · `@` tabs · 📷 screenshot toggle · ⚡ write-assist · 🧾 recipe library — all user-driven | `references/features.md` § Pickers |
| Diagnostics | Metadata-only debug ring; user-triggered anonymous share | `references/features.md` § Diagnostics |

## References

- `references/features.md` — the product canon: what SHIPPED behavior is,
  when to recommend each surface, and what you must not attempt (panel UI,
  submits after fills, cross-tab actions). Read it when the user asks what
  the product can do or asks "can you…".
- `references/protocol.md` — the action protocol: response envelope, action
  grammar, pull actions, cue-resolution ladders, and the absolute safety
  rules. **Read it before acting in any cobrowse turn** — the per-turn prompt
  carries only the envelope demand and the safety rules, not the grammar.

This skill is installed and versioned by the extension itself; it updates
when the extension does. If a described behavior does not match what the
extension actually does, trust the extension's per-turn prompt.
