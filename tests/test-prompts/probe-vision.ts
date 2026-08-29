#!/usr/bin/env bun
/**
 * Vision transport probe (#25 live verification, v0.2.2).
 *
 *   bun --env-file=.env tests/test-prompts/probe-vision.ts
 *
 * Answers BACKLOG #25's open question: does an image embedded in the /zo/ask
 * `input` string (markdown data-URL, the extension's current transport) reach
 * a vision model? Generates a distinctive test image (teal field, yellow
 * stripe, red square, blue disc — unambiguous without OCR), embeds it at
 * realistic capture size, and grades the response for shape/color recall.
 *
 * Exit 0 when every probe passes.
 */

import { writeFileSync } from "fs";

const TOKEN = process.env.ZO_API_KEY || process.env.ZO_ACCESS_TOKEN || "";
if (!TOKEN) {
  console.error("probe-vision: ZO_API_KEY missing (bun --env-file=.env)");
  process.exit(2);
}

const API = "https://api.zo.computer/zo/ask";
const VISION_MODEL = process.env.PROBE_MODEL || "zo:openai/gpt-5.6-sol";

async function makeProbeImage(width = 1280, height = 800, quality = 75, noise = false) {
  // PIL draws the fixture; bun just shells out. Pure-JS PNG encoding would
  // work but JPEG is what captureVisibleTab actually produces.
  const proc = Bun.spawnSync([
    "python3", "-c",
    `
import base64, io, sys
from PIL import Image, ImageDraw
W, H = ${width}, ${height}
img = Image.new("RGB", (W, H), (0, 128, 128))          # teal field
d = ImageDraw.Draw(img)
d.rectangle([0, H // 3, W, 2 * H // 3], fill=(255, 220, 0))   # yellow stripe
s = H // 5
d.rectangle([W // 8, H // 8, W // 8 + s, H // 8 + s], fill=(220, 0, 0))   # red square
r = H // 6
d.ellipse([W - W // 4 - r // 2, H - H // 4 - r // 2, W - W // 4 + r // 2, H - H // 4 + r // 2], fill=(0, 64, 220))  # blue disc
${noise ? `
import random
random.seed(7)
px = img.load()
for y in range(0, H, 3):
    for x in range(0, W, 3):
        c = px[x, y]
        j = random.randint(-40, 40)
        px[x, y] = tuple(max(0, min(255, v + j)) for v in c)
` : ""}
buf = io.BytesIO()
img.save(buf, "JPEG", quality=${quality})
sys.stdout.write(base64.b64encode(buf.getvalue()).decode())
`,
  ]);
  const b64 = proc.stdout.toString().trim();
  if (proc.exitCode !== 0 || b64.length < 1000) {
    console.error("probe-vision: fixture generation failed", proc.stderr.toString());
    process.exit(2);
  }
  return { dataUrl: `data:image/jpeg;base64,${b64}`, bytes: Math.round((b64.length * 3) / 4) };
}

const SHAPES = ["teal", "yellow", "red", "blue"];
function gradeShapeRecall(text) {
  const lower = text.toLowerCase();
  const hits = SHAPES.filter((c) => lower.includes(c));
  return { hits, pass: hits.length >= 3, detail: `${hits.length}/4 colors named` };
}
function gradeSeesImage(text) {
  // The text context deliberately describes a plain white docs page; a model
  // that actually looked at the image will contradict it or hedge.
  const lower = text.toLowerCase();
  const textOnlyTelltales = [
    "i don't have access to any image",
    "no image",
    "cannot see",
    "can't see",
    "unable to view",
    "based on the text",
  ];
  return { imageRejected: textOnlyTelltales.some((t) => lower.includes(t)) };
}

async function ask(prompt, label) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      input: prompt,
      model_name: VISION_MODEL,
      stream: false,
      memory_mode: "off",
    }),
  });
  if (!res.ok) {
    console.error(`probe-vision [${label}]: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
    return null;
  }
  const data = await res.json();
  return typeof data === "string" ? data : (data.response ?? data.output ?? data.text ?? JSON.stringify(data));
}

// ── Probes ───────────────────────────────────────────────────────────────────

const { dataUrl, bytes } = await makeProbeImage();
console.log(`probe-vision: fixture ${bytes} bytes (${VISION_MODEL})`);
console.log(`probe-vision: input length ${dataUrl.length + 300} chars\n`);

const TEXT_CTX =
  "## Page Content\nA plain white documentation page titled 'Getting Started' with two paragraphs of setup instructions.\n\n";

const results = [];

// P1 — image-only: does the model see the shapes at all?
const p1 = await ask(
  `${TEXT_CTX}## Screenshot\n![page](${dataUrl})\n\nDescribe the large colored shapes you can see on the screen. Name the colors.`,
  "P1 image-only",
);
if (p1 == null) process.exit(1);
const g1 = gradeShapeRecall(p1);
results.push({ probe: "P1 image-only", pass: g1.pass, detail: g1.detail });
console.log("P1 response:\n" + p1.slice(0, 600) + "\n");

// P2 — current extension transport verbatim: buildPrompt-style section with
// page text that CONFLICTS with the image, to prove the image is consulted.
const p2 = await ask(
  `${TEXT_CTX}## Screenshot\n![page](${dataUrl})\n\nThe screenshot above is of the user's current screen. Is there a yellow horizontal band on it? Answer yes or no, then name the other prominent shapes/colors.`,
  "P2 embed transport",
);
if (p2 == null) process.exit(1);
const g2 = gradeShapeRecall(p2);
const r2 = gradeSeesImage(p2);
results.push({ probe: "P2 embed transport", pass: g2.pass && !r2.imageRejected, detail: `${g2.detail}${r2.imageRejected ? " · model claimed no image" : ""}` });
console.log("P2 response:\n" + p2.slice(0, 600) + "\n");

// Persist the last data URL for reuse/replay debugging.
writeFileSync(new URL("./fixtures/vision-probe-image.jpeg", import.meta.url).pathname, Buffer.from(dataUrl.split(",")[1], "base64"));

console.log("probe-vision results");
let fail = 0;
for (const r of results) {
  console.log(` ${r.pass ? "✓" : "✗"} ${r.probe} — ${r.detail}`);
  if (!r.pass) fail++;
}

// P3 — size tolerance: a noisy 1920×1080 JPEG inflates past what a real
// capture produces (noise defeats JPEG compression). Acceptance = HTTP 200
// AND the model still reads shapes from the image.
const big = await makeProbeImage(1920, 1080, 90, true);
console.log(`\nP3 size probe: ${big.bytes} bytes (${big.dataUrl.length} chars of base64)`);
const p3 = await ask(
  `${TEXT_CTX}## Screenshot\n![page](${big.dataUrl})\n\nName the dominant background color of this screenshot in one word, then the shapes you see.`,
  "P3 large image",
);
if (p3 == null) {
  results.push({ probe: "P3 large image", pass: false, detail: "request failed" });
  fail++;
} else {
  const g3 = gradeShapeRecall(p3);
  const r3 = gradeSeesImage(p3);
  results.push({ probe: "P3 large image", pass: g3.hits.length >= 1 && !r3.imageRejected, detail: `${g3.detail}${r3.imageRejected ? " · model claimed no image" : ""}` });
  console.log("P3 response:\n" + p3.slice(0, 600) + "\n");
}

process.exit(fail ? 1 : 0);
