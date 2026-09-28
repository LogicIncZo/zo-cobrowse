#!/usr/bin/env python3
"""
conversation-dump.py — extract ONE Zo Co-browse conversation (plus its
per-chat state) from a Chrome extension leveldb dump, for debugging.

Consumes the JSON produced by leveldb-log-dump.py (or the leveldb log
directly) and emits a focused bundle:

  {
    "conversation": {...},            # the matching cobrowse_convos entry
    "conversationId": "conv_...",     # the local storage id
    "ctxState": {...},                # cobrowse_ctx_state:<chatId> if present
    "activeId": "...",                # cobrowse_active_id
    "openTabs": {...},                # cobrowse_open_tabs
    "personas": {...},                # cobrowse_personas
  }

Usage:
  python3 conversation-dump.py <storage-dump.json | 00000N.log> \\
      --find <con_…|conv_…|title-substring> [--out OUT.json]

Matching: a conversation matches when its zoThreadId, id, title, or any
message text contains the --find string (case-insensitive). The FIRST match
with the most messages wins (dedup across superseded log records).
"""

import importlib.util
import json
import os
import sys

_spec = importlib.util.spec_from_file_location(
    "leveldb_log_dump", os.path.join(os.path.dirname(os.path.abspath(__file__)), "leveldb-log-dump.py"))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
parse_log = _mod.parse_log


def load_storage(dump_path):
    """Return {storageKey: parsed-or-raw value} from a dump JSON, a raw log,
    or an extension leveldb DIRECTORY (picks the newest *.log in it)."""
    if os.path.isdir(dump_path):
        logs = sorted(
            (f for f in os.listdir(dump_path) if f.endswith(".log")),
            key=lambda f: os.path.getmtime(os.path.join(dump_path, f)),
        )
        if not logs:
            print(json.dumps({"error": f"no *.log in {dump_path}"}))
            sys.exit(1)
        dump_path = os.path.join(dump_path, logs[-1])
    if dump_path.endswith(".json"):
        return json.load(open(dump_path))
    storage = {}
    for key, value in parse_log(dump_path):
        if value is not None:
            storage[key] = value
    return storage


def maybe_json(value):
    try:
        return json.loads(value)
    except Exception:
        return value


def main():
    args = sys.argv[1:]
    if len(args) < 3:
        print(__doc__)
        sys.exit(2)
    source = args[0]
    find = None
    out_path = None
    i = 1
    while i < len(args):
        if args[i] == "--find":
            i += 1
            find = args[i]
        elif args[i] == "--out":
            i += 1
            out_path = args[i]
        i += 1
    if not find:
        print("missing --find")
        sys.exit(2)

    storage = load_storage(source)
    needle = find.lower()

    convos = maybe_json(storage.get("cobrowse_convos", "{}"))
    if not isinstance(convos, dict):
        convos = {}
    matches = []
    for cid, conv in convos.items():
        hay = json.dumps(conv, ensure_ascii=False).lower()
        if needle in hay:
            matches.append((cid, conv, len(conv.get("messages", []))))
    matches.sort(key=lambda m: -m[2])
    if not matches:
        print(json.dumps({"error": f"no conversation matches {find!r}",
                          "conversationCount": len(convos)}))
        sys.exit(1)

    best_id, best, _ = matches[0]
    ctx_state = maybe_json(storage.get(f"cobrowse_ctx_state:{best_id}", "{}"))

    bundle = {
        "conversationId": best_id,
        "conversation": best,
        "matchCount": len(matches),
        "otherMatchIds": [m[0] for m in matches[1:]],
        "ctxState": ctx_state,
        "activeId": maybe_json(storage.get("cobrowse_active_id", "null")),
        "openTabs": maybe_json(storage.get("cobrowse_open_tabs", "null")),
        "personas": maybe_json(storage.get("cobrowse_personas", "null")),
    }
    text = json.dumps(bundle, ensure_ascii=False, indent=1)
    if out_path:
        open(out_path, "w").write(text)
        print(f"wrote {out_path} (conversation {best_id}, "
              f"{len(best.get('messages', []))} messages, "
              f"{len(matches)} match(es))")
    else:
        print(text)


if __name__ == "__main__":
    main()
