# Privacy Policy — Zo Co-browse Extension

**Last updated:** 2026-07-13

## Overview

Zo Co-browse is a browser extension that lets you interact with web pages through Zo Computer's AI assistant. This policy explains what data the extension accesses, how it's used, and what is shared.

## Data Collected

### Page Content (Contextual)
When you ask a question or issue a command, Zo Co-browse captures:
- The **URL** of the active tab
- The **page title** and **visible text content**
- A **screenshot** (only when screenshots are enabled in settings)

This data is sent to your Zo Computer instance (`*.zo.computer`) to provide contextual answers. It is **not stored** by Zo Co-browse locally beyond the current conversation session.

### Configuration (Stored Locally)
The extension stores in `chrome.storage.sync`:
- Your Zo Computer endpoint URL
- Selected AI model and persona preferences
- Persona routing mode (auto/lite/full)
- Enabled context menu items
- Quick action shortcuts

In `chrome.storage.local` (not synced across devices):
- Your Zo access token
- Conversation history

### Conversation History
Chat messages are saved locally to `chrome.storage.local` for conversation continuity. You can clear history at any time via the extension's New Chat button or by clearing browser storage.

## Data Sharing

| Data | Shared With | Purpose |
|------|-------------|---------|
| Page URL + Content | Your Zo Computer instance (`*.zo.computer`) | AI-powered answers and actions |
| Screenshots | Your Zo Computer instance | Visual context (when enabled) |
| Access token | Your Zo Computer instance | Authentication |

Zo Co-browse **does not**:
- Send data to any third party
- Use analytics or telemetry services
- Sell or share your browsing data
- Collect personal identification information
- Store data on external servers beyond your own Zo Computer

## Permissions Used

| Permission | Why |
|------------|-----|
| `activeTab` | Access current page content and URL when you ask a question |
| `storage` | Save your settings and conversation history locally |
| `tabs` | Navigate pages and query tab metadata |
| `scripting` | Execute actions (click, fill, extract) on pages with your permission |
| `contextMenus` | Right-click integration for quick queries |
| `commands` | Keyboard shortcuts for faster access |
| `omnibox` | Type "zo" in address bar for quick commands |
| `host_permissions` (`<all_urls>`) | Required for content script injection and page interaction on any site you browse |

## Third-Party Services

This extension communicates with your Zo Computer instance (AI inference, workspace tools). By default, no other service is contacted.

**Optional — Jev fast path (off by default):** if you enable it and supply a TypeSafe AI API key, small, redacted page-state summaries (page URL/title, clickable-element labels, short text excerpts — never form-field values) are sent to TypeSafe AI's decision API to speed up navigation choices. You can turn this off any time in Settings; the deep story is in [`docs/qa/threat-model.md`](docs/qa/threat-model.md).


## Changes

Policy updates will be reflected here with an updated date. Continued use after changes constitutes acceptance.

## Contact

CashlessConsumer — [GitHub](https://github.com/CCAgentOrg/zo-cobrowse)
