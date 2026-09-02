#!/usr/bin/env python3
"""Clean UPI Wikipedia article for local demo serving + extract Zo page context."""
import os, json, re
from html.parser import HTMLParser

B = os.path.dirname(os.path.abspath(__file__))  # build/
SITE = os.path.join(os.path.dirname(B), "site")

raw = open(f"{SITE}/article_raw.html", encoding="utf-8").read()

# Strip scripts, edit links, refs nav noise
html = re.sub(r"<script[^>]*>.*?</script>", "", raw, flags=re.S)
html = re.sub(r"<style[^>]*>.*?</style>", "", html, flags=re.S)
html = re.sub(r'rel="dc:replaces"[^/]*/>', "", html)

# Inject a clean stylesheet so the page looks tidy at demo viewport
clean_css = """
<style>
  body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; margin: 0 auto; max-width: 860px;
         padding: 24px 20px 200px; color: #202122; background: #fff; line-height: 1.55; font-size: 15px; }
  h1 { font-size: 1.7em; border-bottom: 1px solid #a2a9b1; padding-bottom: 6px; }
  h2 { font-size: 1.35em; border-bottom: 1px solid #eaecf0; margin-top: 1.4em; }
  h3 { font-size: 1.12em; }
  a { color: #3366cc; text-decoration: none; }
  table { border-collapse: collapse; font-size: 0.9em; max-width: 100%; }
  table td, table th { border: 1px solid #c8ccd1; padding: 5px 8px; }
  figure { margin: 1em 0; }
  figcaption { font-size: 0.85em; color: #54595d; }
  .infobox { float: right; margin: 0 0 12px 16px; background: #f8f9fa; font-size: 0.88em; }
  img { max-width: 100%; height: auto; }
  .mw-editsection, .mw-reflink-text, sup.reference { display: none; }
  #toc, .navbox, .metadata, .ambox, .hatnote, .reflist { display: none; }
</style>
"""
html = html.replace("</head>", clean_css + "</head>")
# make relative protocol links inert (no external nav during demo)
open(f"{SITE}/article.html", "w", encoding="utf-8").write(html)

# ---- extract visible text (for Zo context) ----
class TextGrab(HTMLParser):
    def __init__(self):
        super().__init__()
        self.skip = 0
        self.parts = []
    def handle_starttag(self, tag, attrs):
        if tag in ("style", "script", "table", "figcaption"):
            self.skip += 1
        if tag in ("h1","h2","h3","p","li"):
            self.parts.append("\n")
    def handle_endtag(self, tag):
        if tag in ("style", "script", "table", "figcaption") and self.skip:
            self.skip -= 1
    def handle_data(self, d):
        if not self.skip:
            self.parts.append(d)

tg = TextGrab()
tg.feed(html)
text = re.sub(r"\n{2,}", "\n", "".join(tg.parts))
text = re.sub(r"[ \t]{2,}", " ", text).strip()
open(f"{B}/context_text.txt", "w", encoding="utf-8").write(text)
print("text chars:", len(text))
print(text[:400])
