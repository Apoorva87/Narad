"""One resident MLX model, sequential synthesis, cancellable between audio chunks."""
import argparse
import base64
import contextlib
import hashlib
import io
import json
import os
import queue
import sys
import threading
import wave
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True)
parser.add_argument("--engine", choices=["breeze", "qwen"], default="qwen")
args = parser.parse_args()
requests = queue.Queue()
cancellations = {}
lock = threading.Lock()

def emit(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()

def read_requests():
    for line in sys.stdin:
        try:
            request = json.loads(line)
            with lock:
                if "cancel" in request:
                    event = cancellations.get(request["cancel"])
                    if event:
                        event.set()
                else:
                    event = threading.Event()
                    cancellations[request["id"]] = event
                    requests.put((request, event))
        except Exception as error:
            print(str(error), file=sys.stderr)
    # The owning Node server is gone; never leave a resident model orphaned.
    os._exit(0)

threading.Thread(target=read_requests, daemon=True).start()
with contextlib.redirect_stdout(sys.stderr):
    import numpy as np
    from mlx_audio.tts.utils import load_model
    model = load_model(args.model)

# Breeze TTS 2 has no built-in speakers: it designs a voice from a description, or continues the voice of a reference
# clip. Each Narad voice is designed once from the description below and saved as a short clip of a fixed sentence
# (never lesson audio); every passage then continues that clip, so a voice stays the same person across a lesson.
REFERENCE_TEXT = "Let's take this one step at a time. First we look at the idea itself, and then we see why it works."
BREEZE_VOICES = {
    "Ryan": (11, "A calm, warm man in his late thirties with a clear, medium-low voice and an unhurried, thoughtful way of explaining."),
    "Aiden": (23, "A friendly, curious man in his twenties with a light, bright voice and natural conversational energy."),
    "Vivian": (37, "A warm, articulate woman in her thirties with a clear, steady voice and a patient, encouraging way of explaining."),
    "Serena": (41, "A bright, curious woman in her twenties with a gentle, lively voice and a natural conversational tone."),
}

def joined(results, cancelled=None):
    pieces = []
    for result in results:
        if cancelled is not None and cancelled.is_set():
            raise RuntimeError("Narration aborted")
        pieces.append(np.asarray(result.audio).reshape(-1))
    if not pieces:
        raise RuntimeError("The model produced no audio")
    return np.concatenate(pieces)

def pcm_bytes(audio):
    return (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()

def write_wav(target, audio):
    with wave.open(target, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(model.sample_rate)
        wav.writeframes(pcm_bytes(audio))

def breeze_reference(voice):
    if voice not in BREEZE_VOICES:
        raise RuntimeError("Unknown voice: " + voice)
    seed, description = BREEZE_VOICES[voice]
    # The file name carries what the clip was made from, so changing a description makes a new clip.
    key = hashlib.sha256(f"{seed}|{description}|{REFERENCE_TEXT}".encode()).hexdigest()[:12]
    path = Path(args.model) / "narad-voices" / f"{voice}-{key}.wav"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        audio = joined(model.generate(text=REFERENCE_TEXT, instruct=description, cfg_scale=4, seed=seed, split_pattern=None))
        partial = path.with_suffix(".partial")
        with open(partial, "wb") as target:
            write_wav(target, audio)
        os.replace(partial, path)
    return str(path)

def generate(request, cancelled):
    if args.engine == "breeze":
        # No classifier-free guidance (cfg_scale): it makes the style direction stronger but runs the model twice per step.
        # Measured on an M4 Max, full-precision weights: 1.75x real time without it, 1.25x with cfg_scale=2. Narration has
        # to stay ahead of playback, and the words were transcribed identically either way.
        return joined(model.generate(
            text=request["text"], instruct=request["style"], ref_audio=breeze_reference(request["voice"]), ref_text=REFERENCE_TEXT,
            max_tokens=1500, stream=True, streaming_interval=0.5, split_pattern=None,
        ), cancelled)
    return joined(model.generate_custom_voice(
        text=request["text"], speaker=request["voice"], language="English",
        instruct=request["style"], stream=True, streaming_interval=0.5,
        max_tokens=2048, temperature=0.7,
    ), cancelled)

emit({"event": "ready"})

while True:
    request, cancelled = requests.get()
    request_id = request["id"]
    try:
        if cancelled.is_set():
            raise RuntimeError("Narration aborted")
        emit({"event": "generating"})
        with contextlib.redirect_stdout(sys.stderr):
            audio = generate(request, cancelled)
        if cancelled.is_set():
            raise RuntimeError("Narration aborted")
        if len(audio) / model.sample_rate > 120:
            raise RuntimeError("Narration exceeded its duration limit; please retry")
        output = io.BytesIO()
        write_wav(output, audio)
        emit({"id": request_id, "audio": base64.b64encode(output.getvalue()).decode("ascii")})
    except Exception as error:
        emit({"id": request_id, "error": str(error)})
    finally:
        with lock:
            cancellations.pop(request_id, None)
