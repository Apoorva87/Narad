"""Download a pinned voice model once; inference subsequently uses only local files.

Usage: setup.py [breeze] [qwen] [all]   (no argument installs the default, Breeze TTS 2)
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("HF_HOME", str(ROOT / "data" / "huggingface"))
from huggingface_hub import snapshot_download

# Each engine is pinned to one revision so every installation speaks with the same weights.
ENGINES = {
    "breeze": {
        "repo": "mlx-community/Breeze-TTS-2-mlx",
        "revision": "3c8829fb7fd335818f085cd2ef49b4100c0e46c8",
        "folder": "breeze-tts-2",
        "size": "about 7.6 GB",
        "notice": "Breeze TTS 2 weights and the audio they produce are under the BreezeBlue Research and "
                  "Non-Commercial License: personal and research use only. Use Qwen3-TTS (Apache 2.0) for anything else.",
    },
    "qwen": {
        "repo": "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit",
        "revision": "41d3337e8b7f2843a75841595fc14e4b9a7a4b96",
        "folder": "qwen3-tts",
        "size": "about 2.9 GB",
        "notice": "",
    },
}

if __name__ == "__main__":
    wanted = sys.argv[1:] or ["breeze"]
    if "all" in wanted:
        wanted = list(ENGINES)
    unknown = [name for name in wanted if name not in ENGINES]
    if unknown:
        sys.exit("Unknown voice model: " + ", ".join(unknown) + ". Choose from: " + ", ".join(ENGINES) + ", all.")
    for name in wanted:
        engine = ENGINES[name]
        print(f"Downloading {engine['repo']} ({engine['size']})…", flush=True)
        if engine["notice"]:
            print(engine["notice"], flush=True)
        print(snapshot_download(engine["repo"], revision=engine["revision"], local_dir=ROOT / "data" / "models" / engine["folder"], ignore_patterns=["*.md", ".gitattributes"]), flush=True)
