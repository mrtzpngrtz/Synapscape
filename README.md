# Synapscape

**Synapscape** is a brain activity visualization tool that uses the [TRIBE v2](https://github.com/facebookresearch/CortexBench) model to predict fMRI brain responses to video stimuli and renders them as interactive 3D cortical surface maps.

## Features

- Upload a video clip and get a real-time 3D brain activation map
- GPU-accelerated inference via TRIBE v2 (transformer-based encoding model)
- Audio transcription via WhisperX for language feature extraction
- Interactive 3D cortical surface rendering (fsaverage5 mesh)
- Color-mapped activation overlaid on a realistic brain surface

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla JS + Three.js |
| Backend | Python · FastAPI · Uvicorn |
| Brain model | TRIBE v2 (Meta AI) |
| Transcription | WhisperX (large-v3 on GPU) |
| Deep learning | PyTorch 2.8 + CUDA 12.6 |

## Setup

### Prerequisites
- Python 3.12
- CUDA-capable GPU (recommended)
- Git

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

1. Start the backend with `start_backend.bat`
2. Open `index.html` in a browser
3. Upload a short video clip (MP4 recommended)
4. Watch the brain light up in real time

## License

MIT
