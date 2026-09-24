#!/usr/bin/env bash
# Regenerates the README's images in docs/images from a clean, staged Kikoe.
#
#   bash scripts/readme-images.sh
#
# The desk shot comes from the app's own --screenshot harness, which stages a
# board. The phone shot runs a second Kikoe on a throwaway home (nothing of
# the real ~/.kikoe or ~/.claude is read or written), stages a few cards
# through the same hooks and /show that Claude Code uses, and loads the
# walkie's canvas at 390x844 the way a phone would. The island is cropped to
# the pill, because its hover card shows the real account's usage.
#
# Stop the installed app first (one daemon owns port 4570). The throwaway
# instance has Tailscale off, and turning it off takes the tailnet rule down:
# start Kikoe again afterwards and it puts the rule back.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
H="$TMP/home"
mkdir -p "$H/claude" "$ROOT/docs/images"
cleanup() { taskkill //IM electron.exe //F >/dev/null 2>&1 || pkill -f electron || true; }
trap cleanup EXIT

cd "$ROOT/packages/app"
npx electron . --screenshot "$TMP/room.png" >/dev/null 2>&1

cat > "$H/config.local.json" <<'JSON'
{ "onboarded": true, "tts": "none", "mic": false, "brain": false, "jev": false,
  "walkie": true, "walkie_tailscale": false, "usage": false, "backdrop": "aurora",
  "agents": false, "pc": false, "theme": "dark" }
JSON
export KIKOE_HOME="$H" KIKOE_CLAUDE_DIR="$H/claude" KIKOE_USAGE=off
unset JEV_API_KEY ANTHROPIC_API_KEY OPENROUTER_API_KEY ELEVENLABS_API_KEY
npx electron . >"$TMP/app.log" 2>&1 &
for _ in $(seq 1 60); do
  [ -f "$H/daemon_token.txt" ] && curl -s -m 2 -o /dev/null http://127.0.0.1:4570/state && break
  sleep 1
done
A=(-s -H "Authorization: Bearer $(cat "$H/daemon_token.txt")" -H "Content-Type: application/json")
D=http://127.0.0.1:4570
hook() { curl "${A[@]}" -d "$1" "$D/hook/claude" >/dev/null; }
hook '{"hook_event_name":"SessionStart","session_id":"demo","cwd":"C:/work/storefront"}'
hook '{"hook_event_name":"UserPromptSubmit","session_id":"demo","cwd":"C:/work/storefront","prompt":"add a retry to the token refresh"}'
hook '{"hook_event_name":"PreToolUse","session_id":"demo","cwd":"C:/work/storefront","tool_name":"Bash","tool_input":{"command":"pnpm test"}}'
curl "${A[@]}" -d '{"kind":"diagram","title":"the retry","repo":"storefront","by":"kik","body":"refresh token -> retry x3\nretry x3 -> backoff 200, 800, 3200 ms\nretry x3 -> give up\n*retry x3\nnote: a fourth attempt never helped"}' "$D/show" >/dev/null
curl "${A[@]}" -d '{"kind":"markdown","title":"release checklist","repo":"storefront","by":"kik","sticky":true,"body":"- [x] retry on token refresh\n- [x] tests green\n- [ ] changelog\n- [ ] tag v1.4"}' "$D/show" >/dev/null
curl "${A[@]}" -d '{"text":"what is it doing?"}' "$D/say" >/dev/null
sleep 3

cp "$ROOT/scripts/phone-shot.cjs" "$TMP/phone-shot.cjs"
(cd "$TMP" && SHOT_URL="https://127.0.0.1:4571/?t=$(cat "$H/walkie_token.txt")" SHOT_OUT="$TMP/phone.png" \
  npx --prefix "$ROOT/packages/app" electron phone-shot.cjs)

python - "$TMP" "$ROOT/docs/images" <<'PY'
import sys
from PIL import Image
tmp, out = sys.argv[1], sys.argv[2]
Image.open(f"{tmp}/room.png").convert("RGB").save(f"{out}/room.png", optimize=True)
Image.open(f"{tmp}/phone.png").convert("RGB").save(f"{out}/phone.png", optimize=True)
Image.open(f"{tmp}/room-island.png").crop((196, 0, 524, 52)).convert("RGB").save(f"{out}/island.png", optimize=True)
PY
echo "wrote docs/images/room.png, phone.png, island.png"
