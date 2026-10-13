
import os
import logging
import time
from flask import Flask, request, Response, jsonify
from flask_cors import CORS

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

# -----------------------------------------------------------------------------
# Edge TTS Server (Neural Voice) + Faster Whisper (STT)
# -----------------------------------------------------------------------------

import edge_tts
import asyncio
import tempfile
import threading
from faster_whisper import WhisperModel

# --- Configuration ---
TTS_VOICE = "zh-CN-XiaoxiaoNeural" 
STT_MODEL_SIZE = "small" 

logger.info(f"Initializing Neural TTS: {TTS_VOICE}...")
logger.info(f"Initializing Whisper STT ({STT_MODEL_SIZE}) on CPU...")

# Global State
stt_model = None
is_stt_loading = True
stt_load_error = None

# Background Loading Thread
def load_whisper_model():
    global stt_model, is_stt_loading, stt_load_error
    try:
        logger.info("⏳ Starting Whisper model download/load in background...")
        # compute_type="int8" is faster on CPU
        model = WhisperModel(STT_MODEL_SIZE, device="cpu", compute_type="int8")
        stt_model = model
        is_stt_loading = False
        logger.info("✅ Whisper STT Loaded Successfully! Ready to transcribe.")
    except Exception as e:
        logger.error(f"❌ Failed to load Whisper: {e}")
        stt_load_error = str(e)
        is_stt_loading = False

# Start loading immediately in background
threading.Thread(target=load_whisper_model, daemon=True).start()

@app.route('/v1/audio/speech', methods=['POST'])
def text_to_speech():
    try:
        data = request.json
        text = data.get('input', '')
        rate_str = data.get('rate', '+0%') 
        
        if not text:
            return jsonify({"error": "No input text provided"}), 400

        logger.info(f"🗣️ TTS Generation ({rate_str}): {text[:20]}...")

        from flask import stream_with_context

        logger.info(f"🗣️ TTS Generation ({rate_str}): {text[:20]}...")

        def generate():
            # Create a dedicated event loop for this request's async generator
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            
            async def _stream_generator():
                communicate = edge_tts.Communicate(text, TTS_VOICE, rate=rate_str)
                async for chunk in communicate.stream():
                    if chunk["type"] == "audio":
                        yield chunk["data"]

            # Bridge async generator to sync Flask iterator
            # Note: This is a simple bridge. For production high-concurrency, 
            # using Quart or full-async Flask 2.0+ is better, but this works for local dev.
            gen = _stream_generator()
            try:
                while True:
                    chunk = loop.run_until_complete(gen.__anext__())
                    yield chunk
            except StopAsyncIteration:
                pass
            finally:
                loop.close()

        return Response(stream_with_context(generate()), mimetype="audio/mpeg")

    except Exception as e:
        logger.error(f"TTS Failed: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/v1/audio/transcriptions', methods=['POST'])
def speech_to_text():
    global stt_model, is_stt_loading, stt_load_error

    # Check Loading State
    if is_stt_loading:
        return jsonify({"error": "STT Model is still loading... Please wait 30 seconds."}), 503
    
    if stt_load_error:
        return jsonify({"error": f"STT Model failed to load: {stt_load_error}"}), 500
        
    if not stt_model:
        return jsonify({"error": "STT Model not initialized"}), 500

    if 'file' not in request.files:
        return jsonify({"error": "No file part"}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "No selected file"}), 400

    try:
        # Save temp file
        with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
            file.save(tmp.name)
            tmp_path = tmp.name
        
        logger.info(f"👂 Transcribing audio file: {tmp_path}...")
        
        # Run Transcription
        segments, info = stt_model.transcribe(tmp_path, beam_size=5)
        
        full_text = "".join([segment.text for segment in segments])
        
        # Cleanup
        os.remove(tmp_path)
        
        logger.info(f"✅ Text: {full_text[:50]}...")
        return jsonify({"text": full_text.strip()})

    except Exception as e:
        logger.error(f"STT Failed: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/health', methods=['GET'])
def health():
    stt_status = "loading" if is_stt_loading else ("error" if stt_load_error else "ready")
    return jsonify({
        "status": "ready", 
        "mode": "unified_local_ai",
        "tts": "edge-neural",
        "stt": f"faster-whisper-{STT_MODEL_SIZE} ({stt_status})"
    })

if __name__ == '__main__':
    print("----------------------------------------------------------------")
    print("🐼 PandaAI Unified Local Server")
    print("   - TTS: Edge Neural (Online High-Quality)")
    print(f"   - STT: Faster-Whisper {STT_MODEL_SIZE} (Background Loading...)")
    print("Access at: http://localhost:5001")
    print("----------------------------------------------------------------")
    app.run(host='0.0.0.0', port=5001)
