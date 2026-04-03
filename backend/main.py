"""
Brainmetatron FastAPI backend
Runs on http://localhost:8000

Start:
    uvicorn main:app --host 0.0.0.0 --port 8000

Endpoints:
    GET  /            health check
    POST /predict     upload video file → returns per-frame vertex activations
    WS   /ws          receive binary webcam chunks → stream back activations
"""

import os
import json
import tempfile
import asyncio
import numpy as np
from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

# Allow requests from XAMPP (localhost) and common dev origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Model — loaded once at startup
# ---------------------------------------------------------------------------
print("Loading TRIBE v2 model... (this may take 10-30 seconds)")
try:
    from tribev2 import TribeModel
    model = TribeModel.from_pretrained("facebook/tribev2")
    MODEL_LOADED = True
    print("TRIBE v2 ready.")
except Exception as e:
    MODEL_LOADED = False
    print(f"WARNING: Could not load TRIBE v2: {e}")
    print("Running in DEMO MODE — random activations will be returned.")


def run_inference(video_path: str) -> list:
    """Run TRIBE v2 on a video file. Returns list of activation arrays (one per TR)."""
    if not MODEL_LOADED:
        # Demo mode: return 5 frames of random activations for ~20484 vertices
        n_vertices = 20484
        n_frames = 5
        return [(np.random.randn(n_vertices) * 0.5).tolist() for _ in range(n_frames)]

    events = model.get_events_dataframe(video_path=video_path)
    preds, _ = model.predict(events)  # preds shape: (n_segments, n_vertices)
    return [row.tolist() for row in preds]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/")
async def health():
    return {"status": "ok", "model_loaded": MODEL_LOADED}


@app.post("/predict")
async def predict(file: UploadFile = File(...)):
    """Accept a video file, run inference, return per-frame activations."""
    suffix = os.path.splitext(file.filename or "video.mp4")[1] or ".mp4"

    # Write upload to a temp file (Windows needs delete=False)
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    try:
        content = await file.read()
        tmp.write(content)
        tmp.flush()
        tmp.close()

        frames = await asyncio.get_event_loop().run_in_executor(
            None, run_inference, tmp.name
        )
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass

    return {"frames": frames, "n_frames": len(frames)}


@app.websocket("/ws")
async def webcam_ws(websocket: WebSocket):
    """
    Receive binary webcam video chunks (WebM blobs from MediaRecorder).
    For each chunk: run inference, send back JSON with activations.
    """
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_bytes()

            # Save chunk to temp file
            tmp = tempfile.NamedTemporaryFile(suffix=".webm", delete=False)
            try:
                tmp.write(data)
                tmp.flush()
                tmp.close()

                try:
                    frames = await asyncio.get_event_loop().run_in_executor(
                        None, run_inference, tmp.name
                    )
                    # Send last frame of the chunk (most recent brain state)
                    if frames:
                        await websocket.send_text(json.dumps({
                            "activations": frames[-1]
                        }))
                except Exception as e:
                    print(f"Inference error on webcam chunk: {e}")
                    await websocket.send_text(json.dumps({"error": str(e)}))
            finally:
                try:
                    os.unlink(tmp.name)
                except OSError:
                    pass

    except WebSocketDisconnect:
        pass
