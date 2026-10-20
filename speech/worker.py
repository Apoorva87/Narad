"""One resident MLX model, sequential synthesis, cancellable between audio chunks."""
import argparse
import base64
import contextlib
import io
import json
import os
import queue
import sys
import threading
import wave

parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True)
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
emit({"event": "ready"})

while True:
    request, cancelled = requests.get()
    request_id = request["id"]
    try:
        if cancelled.is_set():
            raise RuntimeError("Narration aborted")
        emit({"event": "generating"})
        pieces = []
        with contextlib.redirect_stdout(sys.stderr):
            for result in model.generate_custom_voice(
                text=request["text"], speaker=request["voice"], language="English",
                instruct=request["style"], stream=True, streaming_interval=0.5,
                max_tokens=2048, temperature=0.7,
            ):
                if cancelled.is_set():
                    raise RuntimeError("Narration aborted")
                pieces.append(np.asarray(result.audio).reshape(-1))
        if cancelled.is_set():
            raise RuntimeError("Narration aborted")
        if not pieces:
            raise RuntimeError("The model produced no audio")
        audio = np.concatenate(pieces)
        if len(audio) / model.sample_rate > 120:
            raise RuntimeError("Narration exceeded its duration limit; please retry")
        pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
        output = io.BytesIO()
        with wave.open(output, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(model.sample_rate)
            wav.writeframes(pcm.tobytes())
        emit({"id": request_id, "audio": base64.b64encode(output.getvalue()).decode("ascii")})
    except Exception as error:
        emit({"id": request_id, "error": str(error)})
    finally:
        with lock:
            cancellations.pop(request_id, None)
