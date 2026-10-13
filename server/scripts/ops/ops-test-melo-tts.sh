#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"
load_env

API_KEY="${BAMBOOK_SDK_KEY:-${BAMBOOK_API_KEY:-${VITE_BAMBOOK_API_KEY:-}}}"
if [[ -z "$API_KEY" ]]; then
  echo "Missing Bambook API key in server environment" >&2
  exit 1
fi

export API_KEY
python3 <<'PY'
import json
import os
import time
import urllib.request

api_key = os.environ["API_KEY"]
url = os.environ.get("BAMBOOK_TTS_TEST_URL", "http://127.0.0.1:8081/api/ai/tts/speech")
samples = [
    "你好，这里是 Bambook 中文语音测试。",
    "请打开订单页面，然后查看客户关系和产品档案。",
    "这是一段较长的中文语音测试，用来确认 Melo 默认只使用中文音色。",
]

for text in samples:
    payload = json.dumps({
        "input": text,
        "voice": "default",
    }).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Bambook-API-Key": api_key,
        },
        method="POST",
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            body = response.read()
            result = {
                "input": text,
                "status": response.status,
                "contentType": response.headers.get("Content-Type"),
                "engine": response.headers.get("X-Bambook-TTS-Engine"),
                "language": response.headers.get("X-Bambook-TTS-Language"),
                "serviceMs": response.headers.get("X-Bambook-TTS-Elapsed-Ms"),
                "bytes": len(body),
                "elapsedMs": round((time.perf_counter() - started) * 1000),
                "riff": body[:4].decode("ascii", "replace"),
                "wave": body[8:12].decode("ascii", "replace"),
            }
    except Exception as error:
        result = {
            "input": text,
            "error": str(error),
            "elapsedMs": round((time.perf_counter() - started) * 1000),
        }
    print(json.dumps(result, ensure_ascii=False), flush=True)
PY
