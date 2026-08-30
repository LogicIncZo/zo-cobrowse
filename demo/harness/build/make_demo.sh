#!/usr/bin/env bash
# Regenerate the Zo Co-browse demo video end-to-end.
# Output: demo/zo-cobrowse-demo-<date>.mp4 (1280x720, ~2:05, en-IN-NeerjaNeural narration)
#
# Requirements: python3, curl, ffmpeg, edge-tts (pip), agent-browser CLI,
#               ZO_CLIENT_IDENTITY_TOKEN in env (for the /zo/ask pre-roll).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"        # build/
HARNESS="$(dirname "$HERE")"                 # harness/
DEMO="$(dirname "$HARNESS")"                 # demo/
SITE="$HARNESS/site"
REC="$HERE/record"
VOICE="en-IN-NeerjaNeural"
PORT="${DEMO_PORT:-8877}"
OUT="$DEMO/zo-cobrowse-demo-$(date +%F).mp4"

# ── timeline (seconds, absolute in final cut) ────────────────────────────
# S1 github 0–22.5 | S2 docs 22.5–45.2 | S3-5 harness 45.2–95.2 | S6 endcard 95.2–125.2
# narration delays (ms): s1=700 s2=23000 s3=45800 s4=54200 s5=68800 s6=96000
A1_TRIM=22.5; A2_TRIM=22.7; B_TRIM=50.0; S6_DUR=30.0; TOTAL=125.24
GH_URL="https://github.com/LogicIncZo/zo-cobrowse"
DOCS_URL="https://logicinczo.github.io/zo-cobrowse/"

mkdir -p "$REC" "$HERE/tts"

echo "── [1/6] fetch + prep article ──"
curl -sL "https://en.wikipedia.org/api/rest_v1/page/html/Unified_Payments_Interface" -o "$SITE/article_raw.html"
python3 "$HERE/prep_article.py"
python3 "$HERE/extract_elements.py"

echo "── [2/6] pre-roll /zo/ask responses ──"
python3 "$HERE/preroll.py"

echo "── [3/6] inject summary into harness ──"
python3 - "$HERE" <<'PYEOF'
import json, re, sys
root = sys.argv[1]
h = open(f"{root}/../site/harness.html").read()
summ = json.load(open(f"{root}/resp_summary.json"))["text"]
h2, n = re.subn(r'const SUM = (SUMMARIZE_TEXT|".*?");', lambda m: 'const SUM = ' + json.dumps(summ) + ';', h, count=1, flags=re.S)
assert n == 1, "SUM placeholder not found"
open(f"{root}/../site/harness.html", "w").write(h2)
print("SUM injected,", len(summ), "chars")
PYEOF

echo "── [4/6] narration TTS ──"
while IFS='|' read -r seg text; do
  edge-tts --voice "$VOICE" --rate=+4% --text "$text" --write-media "$HERE/tts/$seg.mp3" 2>/dev/null
done < "$HERE/narration.txt"

echo "── [5/6] record three passes ──"
cd "$HARNESS"
pkill -f "[h]ttp.server $PORT" 2>/dev/null || true; sleep 0.5
(python3 -m http.server "$PORT" --directory "$HARNESS" >/dev/null 2>&1 &) ; sleep 1.5

agent-browser close 2>/dev/null || true; sleep 2
# PASS A1 — GitHub repo scene
agent-browser open "$GH_URL" && sleep 4 && agent-browser set viewport 1280 720 && sleep 1
agent-browser record start "$REC/passA1.webm" && (
  sleep 3;  agent-browser eval "window.scrollBy(0,420)"
  sleep 5;  agent-browser eval "window.scrollBy(0,420)"
  sleep 5;  agent-browser eval "window.scrollBy(0,480)"
  sleep 5;  agent-browser eval "window.scrollTo(0,0)"
) && sleep 5.5 && agent-browser record stop
# PASS A2 — docs site scene
agent-browser open "$DOCS_URL" && sleep 4 && agent-browser set viewport 1280 720 && sleep 1
agent-browser record start "$REC/passA2.webm" && (
  sleep 4;   agent-browser eval "window.scrollBy(0,380)"
  sleep 6;   agent-browser eval "window.scrollBy(0,420)"
  sleep 5.5; agent-browser eval "window.scrollBy(0,420)"
  sleep 4;   agent-browser eval "window.scrollTo(0,0)"
) && sleep 3.5 && agent-browser record stop
# PASS B — harness choreography (46.2s script + tail)
agent-browser open "http://localhost:$PORT/site/harness.html" && sleep 3 && agent-browser set viewport 1280 720 && sleep 1
agent-browser eval "typeof window.boom==='function' ? 'READY' : 'FAIL'"
agent-browser record start "$REC/passB.webm" && sleep 0.7 && agent-browser eval "window.boom()"; sleep 60.5; agent-browser record stop || true
# endcard still
agent-browser open "file://$SITE/endcard.html" && sleep 2.5 && agent-browser set viewport 1280 720 && sleep 1 && agent-browser screenshot "$SITE/endcard.png"

echo "── [6/6] compose ──"
ffmpeg -y -v error -i "$REC/passA1.webm" -c:v libx264 -preset medium -crf 18 -r 25 -pix_fmt yuv420p -t $A1_TRIM "$HERE/part1.mp4"
ffmpeg -y -v error -i "$REC/passA2.webm" -c:v libx264 -preset medium -crf 18 -r 25 -pix_fmt yuv420p -t $A2_TRIM "$HERE/part2.mp4"
ffmpeg -y -v error -i "$REC/passB.webm"  -c:v libx264 -preset medium -crf 18 -r 25 -pix_fmt yuv420p -t $B_TRIM "$HERE/part3.mp4"
ffmpeg -y -v error -loop 1 -i "$SITE/endcard.png" -t $S6_DUR -c:v libx264 -preset medium -crf 18 -r 25 -pix_fmt yuv420p "$HERE/part4.mp4"
for f in part1 part2 part3 part4; do echo "file '$HERE/$f.mp4'"; done > "$HERE/concat.txt"
ffmpeg -y -v error -f concat -safe 0 -i "$HERE/concat.txt" -c copy "$HERE/master_v.mp4"
ffmpeg -y -v error -i "$HERE/tts/s1.mp3" -i "$HERE/tts/s2.mp3" -i "$HERE/tts/s3.mp3" -i "$HERE/tts/s4.mp3" -i "$HERE/tts/s5.mp3" -i "$HERE/tts/s6.mp3" \
  -filter_complex "[0:a]adelay=700|700[a0];[1:a]adelay=23000|23000[a1];[2:a]adelay=45800|45800[a2];[3:a]adelay=54200|54200[a3];[4:a]adelay=68800|68800[a4];[5:a]adelay=96000|96000[a5];[a0][a1][a2][a3][a4][a5]amix=inputs=6:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,apad=whole_dur=$TOTAL[aout]" \
  -map "[aout]" -c:a aac -b:a 192k "$HERE/master_a.m4a"
ffmpeg -y -v error -i "$HERE/master_v.mp4" -i "$HERE/master_a.m4a" -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "$OUT"

echo "done → $OUT"
