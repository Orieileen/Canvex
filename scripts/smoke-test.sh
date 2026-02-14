#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:28000}"

echo "[1] Create scene"
CREATE_SCENE=$(curl -sS -X POST "${BASE_URL}/api/v1/excalidraw/scenes/" \
  -H "Content-Type: application/json" \
  -H "ngrok-skip-browser-warning: true" \
  -d '{"title":"Smoke Scene","data":{}}')
SCENE_ID=$(python3 - <<'PY' "$CREATE_SCENE"
import json,sys
obj=json.loads(sys.argv[1])
print(obj.get('id',''))
PY
)
if [[ -z "$SCENE_ID" ]]; then
  echo "Create scene failed: $CREATE_SCENE"
  exit 1
fi
echo "scene_id=$SCENE_ID"

echo "[2] List scenes"
curl -sS "${BASE_URL}/api/v1/excalidraw/scenes/" -H "ngrok-skip-browser-warning: true" | python3 -m json.tool >/dev/null

echo "[3] Chat fallback (non-stream)"
CHAT_RESP=$(curl -sS -X POST "${BASE_URL}/api/v1/excalidraw/scenes/${SCENE_ID}/chat/" \
  -H "Content-Type: application/json" \
  -H "ngrok-skip-browser-warning: true" \
  -d '{"content":"hello"}')
python3 - <<'PY' "$CHAT_RESP"
import json,sys
obj=json.loads(sys.argv[1])
if obj.get('role') == 'assistant' or obj.get('content') is not None:
    print('chat ok')
else:
    print(f"chat fallback returned non-assistant payload (expected when LLM key missing): {obj}")
PY

echo "[4] Chat stream SSE (delta/intent/tool-result/message/error)"
# 仅抓取前几行验证 SSE 可连通
curl -sN -X POST "${BASE_URL}/api/v1/excalidraw/scenes/${SCENE_ID}/chat/?stream=1" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream, application/json" \
  -H "ngrok-skip-browser-warning: true" \
  -d '{"content":"画一只猫"}' | head -n 8 || true

echo "[5] Data Library folder + asset"
FOLDER_RESP=$(curl -sS -X POST "${BASE_URL}/api/v1/library/folders/" \
  -H "Content-Type: application/json" \
  -H "ngrok-skip-browser-warning: true" \
  -d '{"name":"Smoke Folder"}')
FOLDER_ID=$(python3 - <<'PY' "$FOLDER_RESP"
import json,sys
print((json.loads(sys.argv[1]) or {}).get('id',''))
PY
)
if [[ -z "$FOLDER_ID" ]]; then
  echo "Create folder failed: $FOLDER_RESP"
  exit 1
fi

tmp_png="$(mktemp -t smoke-asset-XXXXXX).png"
python3 - <<'PY' "$tmp_png"
import struct, sys, zlib

def chunk(chunk_type: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + chunk_type
        + data
        + struct.pack(">I", zlib.crc32(chunk_type + data) & 0xFFFFFFFF)
    )

# 1x1 RGB white pixel PNG
png_sig = b"\x89PNG\r\n\x1a\n"
ihdr = chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
raw = b"\x00\xff\xff\xff"  # filter=0 + RGB(255,255,255)
idat = chunk(b"IDAT", zlib.compress(raw))
iend = chunk(b"IEND", b"")
with open(sys.argv[1], "wb") as f:
    f.write(png_sig + ihdr + idat + iend)
PY

ASSET_RESP=$(curl -sS -X POST "${BASE_URL}/api/v1/library/assets/" \
  -H "ngrok-skip-browser-warning: true" \
  -F "folder=${FOLDER_ID}" \
  -F "filename=smoke.png" \
  -F "is_public=true" \
  -F "file=@${tmp_png};type=image/png")
ASSET_URL=$(python3 - <<'PY' "$ASSET_RESP"
import json,sys
print((json.loads(sys.argv[1]) or {}).get('url',''))
PY
)
if [[ -z "$ASSET_URL" ]]; then
  echo "Upload asset failed: $ASSET_RESP"
  exit 1
fi

echo "asset_url=$ASSET_URL"

echo "[6] Image edit (requires OPENAI_API_KEY for chat + MEDIA_OPENAI_* for media)"
set +e
IMAGE_JOB=$(curl -sS -X POST "${BASE_URL}/api/v1/excalidraw/scenes/${SCENE_ID}/image-edit/" \
  -H "ngrok-skip-browser-warning: true" \
  -F "prompt=make it brighter" \
  -F "image=@${tmp_png};type=image/png")
set -e
echo "$IMAGE_JOB" | python3 -m json.tool || echo "$IMAGE_JOB"

echo "[7] Video job (requires MEDIA_OPENAI_BASE_URL + MEDIA_OPENAI_API_KEY)"
set +e
VIDEO_JOB=$(curl -sS -X POST "${BASE_URL}/api/v1/excalidraw/scenes/${SCENE_ID}/video/" \
  -H "Content-Type: application/json" \
  -H "ngrok-skip-browser-warning: true" \
  -d "{\"prompt\":\"cinematic product shot\",\"image_urls\":[\"${ASSET_URL}\"]}")
set -e
echo "$VIDEO_JOB" | python3 -m json.tool || echo "$VIDEO_JOB"

echo "[done] Smoke flow complete"
