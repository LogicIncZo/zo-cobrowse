#!/usr/bin/env bun
/**
 * Size-tolerance bisect for the markdown-embed image transport (#25).
 *   bun --env-file=.env tests/test-prompts/probe-vision-size.ts
 * Binary-searches the largest base64 data-URL embed /zo/ask accepts.
 */
const TOKEN = process.env.ZO_API_KEY || process.env.ZO_ACCESS_TOKEN || "";
if (!TOKEN) { console.error("ZO_API_KEY missing"); process.exit(2); }
const API = "https://api.zo.computer/zo/ask";
const MODEL = process.env.PROBE_MODEL || "zo:zai/glm-5.3-flash";

async function jpegOfSize(targetKB: number): Promise<string> {
  const proc = Bun.spawnSync(["python3", "-c", `
import base64, io, random, sys
from PIL import Image
random.seed(7)
W, H = 1280, 800
img = Image.new("RGB", (W, H), (0, 128, 128))
px = img.load()
density = ${Math.min(100, Math.max(1, Math.round((targetKB / 600) * 100)))}
for y in range(H):
    for x in range(W):
        if random.randint(1, 100) <= density:
            c = px[x, y]
            j = random.randint(-50, 50)
            px[x, y] = tuple(max(0, min(255, v + j)) for v in c)
buf = io.BytesIO()
q = 92
img.save(buf, "JPEG", quality=q)
while buf.tell() > ${targetKB} * 1024 and q > 40:
    q -= 6
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=q)
sys.stdout.write(base64.b64encode(buf.getvalue()).decode())
`]);
  return `data:image/jpeg;base64,${proc.stdout.toString().trim()}`;
}

async function attempt(kb: number) {
  const dataUrl = await jpegOfSize(kb);
  const input = `## Screenshot\n![page](${dataUrl})\n\nWhat is the dominant background color? One word.`;
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ input, model_name: MODEL, stream: false, memory_mode: "off" }),
  });
  const ok = res.ok;
  const body = ok ? await res.text() : (await res.text()).slice(0, 120);
  console.log(`${kb}KB jpg → ${dataUrl.length} chars → HTTP ${res.status} ${ok ? "· " + body.slice(0, 80) : "· " + body}`);
  return ok;
}

// Coarse ladder first, then bisect between last pass and first fail.
const ladder = [650, 700, 750, 800];
let lastPass = 0, firstFail = 0;
for (const kb of ladder) {
  if (await attempt(kb)) lastPass = kb;
  else { firstFail = kb; break; }
}
if (firstFail) {
  let lo = lastPass, hi = firstFail;
  while (hi - lo > 50) {
    const mid = Math.round((lo + hi) / 2);
    if (await attempt(mid)) lo = mid; else hi = mid;
  }
  console.log(`\nbisect: passes at ${lo}KB, fails at ${hi}KB`);
}
