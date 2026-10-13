import asyncio
import os
import uuid
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import edge_tts
from threading import Thread
import logging
import tempfile
import time

# --- LOGGING SETUP ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("PandaAIServer")

app = Flask(__name__)
CORS(app)

# --- GLOBAL MODEL STATE (SenseVoice) ---
stt_model = None
is_stt_loading = True
stt_load_error = None

# --- CONFIG ---
# SenseVoice is SOTA for multilingual streaming/offline
MODEL_ID = "iic/SenseVoiceSmall" 

# [CRITICAL FIX] FFMPEG & FFPROBE INJECTION
# Pydub has a known issue where it caches the result of its ffmpeg/ffprobe search on import.
# Simply updating PATH after import doesn't work. We need to MONKEY-PATCH its internal functions.
try:
    import imageio_ffmpeg
    ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()
    ffmpeg_dir = os.path.dirname(ffmpeg_path)
    ffprobe_path = os.path.join(ffmpeg_dir, "ffprobe")
    
    # 1. Update system PATH (for funasr's subprocess calls)
    os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ["PATH"]
    
    # 2. MONKEY-PATCH pydub's utility functions to force our binaries
    import pydub.utils
    from pydub import AudioSegment
    
    # Override the functions that search for ffmpeg/ffprobe
    pydub.utils.get_encoder_name = lambda: ffmpeg_path
    pydub.utils.get_prober_name = lambda: ffprobe_path
    
    # Also set the converter attribute (AudioSegment uses this too)
    AudioSegment.converter = ffmpeg_path
    
    logger.info(f"🔧 [FORCE-INJECTED] FFmpeg: {ffmpeg_path}")
    logger.info(f"🔧 [FORCE-INJECTED] FFprobe: {ffprobe_path}")
    logger.info(f"🔧 PATH Updated: {ffmpeg_dir}")
except Exception as e:
    logger.warning(f"⚠️ FFmpeg injection failed: {e}")

def load_sense_voice_model():
    """
    Loads Alibaba's SenseVoiceSmall model.
    This model is extremely fast and accurate for mixed Zh/En.
    """
    global stt_model, is_stt_loading, stt_load_error
    try:
        logger.info("⏳ Starting SenseVoice model download/load...")
        from funasr import AutoModel
        
        # Initialize SenseVoice
        # It automatically handles Zh/En/Ja/Ko/Yue
        model = AutoModel(
            model=MODEL_ID,
            trust_remote_code=True,
            remote_code="./model.py",  
            vad_model="fsmn-vad",
            vad_kwargs={"max_single_segment_time": 30000},
            device="cpu", # SenseVoice is light enough for CPU
            disable_update=True
        )
        
        stt_model = model
        is_stt_loading = False
        logger.info("✅ SenseVoice STT Loaded Successfully! (Best for Zh/En Mixed)")
    except Exception as e:
        logger.error(f"❌ Failed to load SenseVoice: {e}")
        stt_load_error = str(e)
        is_stt_loading = False

# Start loading in background
loader_thread = Thread(target=load_sense_voice_model)
loader_thread.daemon = True
loader_thread.start()


# --- TTS HELPERS ---

async def generate_tts_file(text, voice, rate="+20%"):
    """Generates a TTS file using edge-tts."""
    communicate = edge_tts.Communicate(text, voice, rate=rate)
    # Use a temp file that persists briefly
    temp_dir = tempfile.gettempdir()
    filename = f"tts_{uuid.uuid4()}.mp3"
    filepath = os.path.join(temp_dir, filename)
    
    await communicate.save(filepath)
    return filepath

# --- ROUTES ---

@app.route('/health', methods=['GET'])
def health_check():
    status = "loading" if is_stt_loading else ("error" if stt_load_error else "ready")
    return jsonify({
        "status": "ok", 
        "stt_status": status,
        "stt_model": "SenseVoiceSmall"
    })

@app.route('/v1/audio/speech', methods=['POST'])
def text_to_speech():
    """Compatible with OpenAI /v1/audio/speech"""
    data = request.json
    text = data.get('input')
    voice = data.get('voice', 'zh-CN-XiaoxiaoNeural')
    rate = data.get('rate', '+0%')

    # Map generic voice names to EdgeTTS specific ones if needed
    if voice == 'default': voice = 'zh-CN-XiaoxiaoNeural'

    if not text:
        return jsonify({"error": "Missing input text"}), 400

    try:
        # Run async generation in the event loop
        filepath = asyncio.run(generate_tts_file(text, voice, rate))
        return send_file(filepath, mimetype="audio/mpeg")
    except Exception as e:
        logger.error(f"TTS Error: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/v1/audio/transcriptions', methods=['POST'])
def speech_to_text():
    """
    SenseVoice STT Endpoint.
    Supports high-accuracy mixed Zh/En recognition.
    """
    global stt_model
    
    logger.info("📥 Received STT request")
    
    if is_stt_loading:
        logger.warning("Model still loading, returning placeholder")
        return jsonify({"text": "(System: AI Ear is warming up... please wait 1 min)"})
    
    if stt_load_error:
        return jsonify({"text": f"(System: STT Error - {stt_load_error})"})

    if 'file' not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "No selected file"}), 400
    
    # Save temp file (WebM from browser)
    temp_dir = tempfile.gettempdir()
    webm_path = os.path.join(temp_dir, f"stt_{uuid.uuid4()}.webm")
    logger.info(f"💾 Saving uploaded audio to: {webm_path}")
    file.save(webm_path)

    wav_path = None
    try:
        start_time = time.time()
        logger.info(f"⏱️ [STEP 1] File uploaded successfully, size: {os.path.getsize(webm_path)} bytes")
        
        # [THE REAL SOLUTION] Manual WebM → WAV Conversion via imageio-ffmpeg
        # Problem: torchaudio can't handle webm/opus → falls back to system ffmpeg → Errno 2
        # Solution: Use imageio-ffmpeg's bundled ffmpeg binary directly via subprocess
        logger.info("🔄 [STEP 2] Starting WebM → WAV conversion...")
        
        import subprocess
        wav_path = os.path.join(temp_dir, f"stt_{uuid.uuid4()}.wav")
        
        # Use imageio-ffmpeg's binary
        import imageio_ffmpeg
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
        logger.info(f"🔧 [STEP 2.1] Using ffmpeg: {ffmpeg_exe}")
        
        # Run ffmpeg: webm → 16kHz mono wav (optimal for SenseVoice)
        logger.info(f"🎵 [STEP 2.2] Running ffmpeg conversion: {webm_path} → {wav_path}")
        conversion_result = subprocess.run([
            ffmpeg_exe,
            '-i', webm_path,           # Input
            '-ar', '16000',             # Sample rate: 16kHz
            '-ac', '1',                 # Channels: Mono
            '-f', 'wav',                # Format: WAV
            wav_path                    # Output
        ], capture_output=True, text=True, timeout=30)
        
        if conversion_result.returncode != 0:
            logger.error(f"❌ FFmpeg STDOUT: {conversion_result.stdout}")
            logger.error(f"❌ FFmpeg STDERR: {conversion_result.stderr}")
            raise Exception(f"FFmpeg conversion failed (code {conversion_result.returncode}): {conversion_result.stderr}")
        
        logger.info(f"✅ [STEP 3] Conversion complete: {wav_path} (size: {os.path.getsize(wav_path)} bytes)")
        
        # Now feed the WAV to SenseVoice
        logger.info(f"🎤 [STEP 4] Starting SenseVoice inference...")
        res = stt_model.generate(
            input=wav_path,
            cache={},
            language="auto",  # Auto-detect Zh/En
            use_itn=True,     # Inverse Text Normalization (e.g., "一千" -> "1000")
            batch_size_s=60,
        )
        logger.info(f"✅ [STEP 5] SenseVoice inference completed, raw result: {res}")
        
        # Extract text from result
        raw_text = res[0]['text'] if res and len(res) > 0 else ""
        
        # [CRITICAL] Clean SenseVoice's internal tokens
        # SenseVoice outputs control tokens like <|zh|>, <|NEUTRAL|>, <|Speech|>, <|withitn|>
        # These are for model debugging but should NEVER be shown to users.
        import re
        # Remove all angle-bracket tokens: <|...|>
        cleaned_text = re.sub(r'<\|[^|]+\|>', '', raw_text).strip()
        
        logger.info(f"📝 [STEP 5.5] Cleaned text: [{cleaned_text}] (removed tokens from: [{raw_text}])")

        
        elapsed = time.time() - start_time
        logger.info(f"✅ [STEP 6] Transcription complete in {elapsed:.2f}s: [{cleaned_text}]")
        
        # Cleanup temp files
        logger.info("🧹 [STEP 7] Cleaning up temp files...")
        if os.path.exists(webm_path):
            os.remove(webm_path)
        if wav_path and os.path.exists(wav_path):
            os.remove(wav_path)
        
        logger.info(f"🎉 [SUCCESS] Returning transcribed text: {cleaned_text}")
        return jsonify({"text": cleaned_text})

    except Exception as e:
        logger.error(f"❌ [CRITICAL ERROR] STT Pipeline Failed at some step", exc_info=True)
        logger.error(f"❌ Exception type: {type(e).__name__}")
        logger.error(f"❌ Exception message: {str(e)}")
        # Cleanup on error
        try:
            if os.path.exists(webm_path):
                os.remove(webm_path)
                logger.info(f"🧹 Cleaned up webm file: {webm_path}")
        except Exception as cleanup_e:
            logger.error(f"Failed to cleanup webm: {cleanup_e}")
        
        try:
            if wav_path and os.path.exists(wav_path):
                os.remove(wav_path)
                logger.info(f"🧹 Cleaned up wav file: {wav_path}")
        except Exception as cleanup_e:
            logger.error(f"Failed to cleanup wav: {cleanup_e}")
        
        return jsonify({"error": str(e)}), 500


# --- PRE-CACHE WELCOME MESSAGE ---
# User requested zero latency for the welcome message.
# We pre-generate it on server start.
WELCOME_TEXT = "神经链接已建立。我是 Panda Clothing 的首席战略顾问。请问今天需要什么供应链决策支持？"
WELCOME_FILE_PATH = os.path.join("public", "audio", "cache", "welcome_greeting.mp3")

def pre_generate_welcome_audio():
    """Generates the static welcome audio file if it doesn't exist."""
    # Ensure directory exists
    os.makedirs(os.path.dirname(WELCOME_FILE_PATH), exist_ok=True)
    
    if not os.path.exists(WELCOME_FILE_PATH):
        logger.info("💿 Pre-generating Welcome Audio Cache...")
        try:
            asyncio.run(generate_tts_file_to_path(WELCOME_TEXT, 'zh-CN-XiaoxiaoNeural', WELCOME_FILE_PATH))
            logger.info("✅ Welcome Audio Cached.")
        except Exception as e:
            logger.error(f"Failed to cache welcome audio: {e}")

async def generate_tts_file_to_path(text, voice, path):
    communicate = edge_tts.Communicate(text, voice, rate="+20%")
    await communicate.save(path)

# Run pre-gen in background
pre_gen_thread = Thread(target=pre_generate_welcome_audio)
pre_gen_thread.daemon = True
pre_gen_thread.start()


if __name__ == '__main__':
    logger.info("🚀 PandaAI Audio Server Starting on Port 5001...")
    logger.info("✨ Powered by: EdgeTTS (Speech) + SenseVoice (Hearing)")
    app.run(host='0.0.0.0', port=5001)
