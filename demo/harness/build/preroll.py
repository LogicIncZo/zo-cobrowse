#!/usr/bin/env python3
"""Build extension-faithful /zo/ask prompts and pre-roll demo responses."""
import os, json, re, textwrap, urllib.request

B = os.path.dirname(os.path.abspath(__file__))  # build/
SITE = os.path.join(os.path.dirname(B), "site")

# Build context.json from the prep/extract outputs if missing
ctx_path = os.path.join(B, "context.json")
if not os.path.exists(ctx_path):
    text = open(os.path.join(B, "context_text.txt")).read()
    elements = [l for l in open(os.path.join(B, "context_elements.txt")).read().splitlines()
                if l.strip() and not l.startswith("total:") and "...total" not in l]
    json.dump({"text": text, "elements": elements}, open(ctx_path, "w"))
ctx = json.load(open(f"{B}/context.json"))
page_text = ctx["text"]
elements = ctx["elements"]

URL = "https://en.wikipedia.org/wiki/Unified_Payments_Interface"
TITLE = "Unified Payments Interface - Wikipedia"
VIEWPORT = "780x640"

def page_block():
    return f"## Page\n- URL: {URL}\n- Title: {TITLE}\n- Viewport: {VIEWPORT}"

def build(mode_name, system_prompt, instructions, tier, text_budget, expect_json, user_query):
    parts = [system_prompt, "", page_block()]
    if tier >= 1:
        parts += ["", "## Page Content", "```", page_text[:text_budget] or "—empty—", "```"]
    if tier >= 2 and elements:
        parts += ["", "## Elements", "".join(elements)]
    parts += ["", "## User Request", user_query, ""]
    if expect_json:
        parts += [instructions,
            'Respond with JSON {"actions":[...]}. '
            'Actions: click{selector} | fill{selector,value} | extract{selector,attribute} | '
            'navigate{url} | scroll{direction,amount?} | wait{ms} | done{response}.']
    else:
        parts += [instructions, "Respond in plain markdown."]
    return "\n".join(parts)

COBROWSE_SYS = "You are Zo — the user's AI co-browsing assistant. You see the page they're on and can control the browser."
COBROWSE_INS = "Act on the page to fulfill the request. Use the ELEMENTS list when targeting clicks/fills."
SUMMARIZE_SYS = "You are Zo — the user's summarization assistant. Condense the page into its essential points. Concise, objective, organized."
SUMMARIZE_INS = "Produce a concise summary: 3-5 bullets or a short paragraph. Cover the main argument, key evidence, and conclusion."

prompt_summary = build("summarize", SUMMARIZE_SYS, SUMMARIZE_INS, 1, 2000, False,
                       "Summarize this page in 3 bullet points")
prompt_cobrowse = build("cobrowse", COBROWSE_SYS, COBROWSE_INS, 2, 4000, True,
                        "Scroll down to the History section and extract the links inside it")

def ask(prompt, attempts=4):
    import time
    for i in range(attempts):
        try:
            req = urllib.request.Request(
                "https://api.zo.computer/zo/ask",
                data=json.dumps({
                    "input": prompt,
                    "model_name": "byok:e4ad4825-9909-42a4-b022-f83234b92064",
                }).encode(),
                headers={"authorization": os.environ["ZO_CLIENT_IDENTITY_TOKEN"],
                         "content-type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read())
        except Exception as e:
            if i == attempts - 1:
                raise
            print(f"  ask attempt {i+1} failed ({e}); retrying...", flush=True)
            time.sleep(8 * (i + 1))

print("asking summarize...", flush=True)
r1 = ask(prompt_summary)
print("asking cobrowse...", flush=True)
r2 = ask(prompt_cobrowse)

sum_parts = [p for p in r1["output"].strip().split("\n\n")
             if p.strip().startswith(("-", "*"))][:3]
json.dump({"prompt": prompt_summary, "text": "\n\n".join(sum_parts)},
          open(f"{B}/resp_summary.json", "w"), indent=1)
json.dump({"prompt": prompt_cobrowse, "text": r2["output"]},
          open(f"{B}/resp_cobrowse.json", "w"), indent=1)
print("=== SUMMARY ==="); print(r1["output"][:900])
print("=== COBROWSE ==="); print(r2["output"][:1200])
