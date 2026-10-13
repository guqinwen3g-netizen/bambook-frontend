#!/usr/bin/env python3
import argparse
import json
import os
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import torch


torch.backends.mps.is_available = lambda: False

from melo.api import TTS


DEFAULT_LANGUAGE = "ZH"
MODEL_CACHE = {}
MODEL_LOCK = threading.Lock()


def resolve_model():
    if DEFAULT_LANGUAGE not in MODEL_CACHE:
        MODEL_CACHE[DEFAULT_LANGUAGE] = TTS(language=DEFAULT_LANGUAGE, device="cpu")
    return DEFAULT_LANGUAGE, MODEL_CACHE[DEFAULT_LANGUAGE]


def resolve_speaker_id(model):
    speaker_ids = model.hps.data.spk2id
    fallback = "ZH" if "ZH" in speaker_ids else next(iter(speaker_ids.keys()))
    return fallback, speaker_ids[fallback]


resolve_model()


class MeloHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        if self.path != "/health":
            self.send_error(404)
            return
        self._send_json({"ok": True})

    def do_POST(self):
        if self.path != "/speech":
            self.send_error(404)
            return

        try:
            started = time.perf_counter()
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            text = str(body.get("input") or "").strip()
            speed = float(body.get("speed") or 1.0)
            sdp_ratio = float(body.get("sdp_ratio") or 0.2)
            noise_scale = float(body.get("noise_scale") or 0.6)
            noise_scale_w = float(body.get("noise_scale_w") or 0.8)
            if not text:
                self.send_error(400, "input is required")
                return

            with tempfile.TemporaryDirectory(prefix="bambook-melo-") as temp_dir:
                output_path = Path(temp_dir) / "speech.wav"
                with MODEL_LOCK:
                    resolved_language, model = resolve_model()
                    _resolved_speaker, speaker_id = resolve_speaker_id(model)
                    model.tts_to_file(text, speaker_id, str(output_path), speed=speed, sdp_ratio=sdp_ratio, noise_scale=noise_scale, noise_scale_w=noise_scale_w, quiet=True)
                audio = output_path.read_bytes()
            elapsed_ms = int((time.perf_counter() - started) * 1000)

            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("X-Bambook-TTS-Engine", "melo")
            self.send_header("X-Bambook-TTS-Elapsed-Ms", str(elapsed_ms))
            self.send_header("X-Bambook-TTS-Language", resolved_language)
            self.end_headers()
            self.wfile.write(audio)
        except Exception as error:
            message = str(error).encode("utf-8", "replace")
            self.send_response(500)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(message)))
            self.end_headers()
            self.wfile.write(message)

    def log_message(self, format, *args):
        return

    def _send_json(self, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), MeloHandler)
    print(f"MELO_TTS_READY http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
