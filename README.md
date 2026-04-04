# Synapscape

**Synapscape** is a brain activity visualization tool that uses [TRIBE v2](https://github.com/facebookresearch/tribev2) — Meta's transformer-based brain encoding model ([HuggingFace](https://huggingface.co/facebook/tribev2)) — to predict fMRI brain responses to video stimuli and renders them as interactive 3D cortical surface maps.

## Features

- Upload a video clip and get a per-frame 3D brain activation map synced to playback
- Live webcam mode — streams 4-second chunks via WebSocket for continuous inference
- Two render modes: **Surface** (PBR vertex-colour mesh) and **Particles** (white glowing point cloud, particle size driven by activation magnitude)
- Loop sequencer with cycle counter and real-time loop-frequency readout (Hz)
- Async inference with live step-progress overlay — no frozen UI during long runs
- File-hash result cache — re-submitting the same video is instant
- Selectable spectral colormaps: RdBu · Hot · Viridis
- 4-viewport cortical view: Anterior · Posterior · L Lateral · R Lateral
- Drag-to-rotate brain with inertia (mouse + touch)
- GPU-accelerated inference via TRIBE v2; automatic Llama-gated fallback (video-only)
- Demo mode with random activations when model is unavailable

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla JS · Three.js r128 |
| 3D rendering | WebGL · custom GLSL particle shader · additive blending |
| Backend | Python · FastAPI · Uvicorn |
| Brain model | [TRIBE v2](https://github.com/facebookresearch/tribev2) · [model](https://huggingface.co/facebook/tribev2) |
| Transcription | WhisperX (large-v3 on GPU) |
| Deep learning | PyTorch 2.8 + CUDA 12.6 |
| Brain mesh | FreeSurfer fsaverage5 (~20 484 vertices) |

## Setup

### Prerequisites
- Python 3.12
- CUDA-capable GPU (recommended)
- XAMPP or any static file server for the frontend

### Backend
```bash
# Create environment
python -m venv tribe_env
tribe_env\Scripts\activate

# Install PyTorch (CUDA 12.6)
pip install torch==2.8.0+cu126 torchaudio==2.8.0+cu126 torchvision==0.23.0+cu126 \
    --index-url https://download.pytorch.org/whl/cu126

# Install remaining dependencies
pip install -r backend/requirements.txt
```

### Run
```bash
start_backend.bat
```

Then open `index.html` in your browser (served via XAMPP or any static file server).

## Usage

1. Start the backend (`start_backend.bat`) — TRIBE v2 loads in ~10–30 s
2. Open `index.html` in a browser
3. **Load Sequence** — upload an MP4; inference runs async with live step progress
4. Play the video — the brain updates frame-by-frame in sync
5. Toggle **Particles** for the white point-cloud view (activation = particle size)
6. Enable **Loop Seq** to cycle the video; watch the CYCLE counter and loop-frequency readout
7. Or click **Live Capture** for real-time webcam inference

## Performance notes

- First inference on a new video: ~2–3 min on a mid-range GPU (video encoding is the bottleneck)
- Repeated submissions of the same file are served from the in-memory cache (instant)
- Demo mode (no model loaded) returns random activations immediately

## License

MIT
