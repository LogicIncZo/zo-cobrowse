import os
#!/usr/bin/env python3
"""Extract page elements (compactEl format) from demo article for Zo context."""
import re, json

B = os.path.dirname(os.path.abspath(__file__))  # build/
SITE = os.path.join(os.path.dirname(B), "site")
html = open(f"{SITE}/article.html", encoding="utf-8").read()

def strip_tags(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s)).strip()

# section headings with ids
headings = []
for m in re.finditer(r'<h([123])[^>]*\bid="([^"]+)"[^>]*>(.*?)</h\1>', html, re.S):
    inner = re.sub(r'<[^>]+>', '', m.group(3))
    txt = strip_tags(inner)[:40]
    if txt:
        headings.append((f"h{m.group(1)}", txt, m.group(2)))

# links (article body only, dedup by href)
links = []
seen = set()
for m in re.finditer(r'<a[^>]*href="(\./[^"#]+|/wiki/[^"#]+|#[^"]+)"[^>]*>(.*?)</a>', html, re.S):
    href, inner = m.group(1), strip_tags(m.group(2))[:40]
    if not inner or href in seen:
        continue
    seen.add(href)
    links.append((href, inner))
    if len(links) >= 45:
        break

els = []
for tag, txt, hid in headings[:14]:
    els.append(f'[{tag} "{txt}" #{hid}]')
for href, txt in links[:40]:
    sel = f'a[href="{href}"]'
    els.append(f'[a "{txt}" {sel}]')

out = "\n".join(els)
open(f"{B}/context_elements.txt", "w", encoding="utf-8").write(out)
print(out[:1500])
print("...total:", len(els))
