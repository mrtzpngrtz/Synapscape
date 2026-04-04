"""
Brainmetatron FastAPI backend
Runs on http://localhost:8000

Start:
    uvicorn main:app --host 0.0.0.0 --port 8000

Endpoints:
    GET  /              health check
    POST /predict       upload video → returns task_id immediately
    GET  /task/{id}     poll task status / result
    WS   /ws            receive binary webcam chunks → stream back activations
"""

import os
import json
import hashlib
import uuid
import tempfile
import asyncio
import numpy as np
from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

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

# ---------------------------------------------------------------------------
# In-memory stores
# ---------------------------------------------------------------------------
result_cache: dict = {}   # md5_hex  → list[list[float]]
task_store:   dict = {}   # task_id  → {status, progress, frames, error}


def _file_md5(path: str) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Inference
# ---------------------------------------------------------------------------
def run_inference(video_path: str, task_id: str | None = None) -> list:
    """Run TRIBE v2 on a video file. Returns list of activation arrays (one per TR)."""

    def _step(msg: str):
        if task_id and task_id in task_store:
            task_store[task_id]["progress"] = msg

    if not MODEL_LOADED:
        _step("Demo mode — generating random activations...")
        n_vertices = 20484
        n_frames = 5
        return [(np.random.randn(n_vertices) * 0.5).tolist() for _ in range(n_frames)]

    _step("Extracting multimodal events (audio · speech · video)…")
    events = model.get_events_dataframe(video_path=video_path)

    _step("Running TRIBE v2 — encoding video segments (this takes a while)…")
    try:
        preds, _ = model.predict(events, verbose=False)
    except Exception as e:
        if "gated" in str(e).lower() or "403" in str(e) or "Llama" in str(e):
            _step("Llama not accessible — retrying video-only…")
            events = events[events["type"] != "Word"]
            preds, _ = model.predict(events, verbose=False)
        else:
            raise

    if len(preds) == 0:
        raise RuntimeError("No segments predicted — video may be too short or silent.")

    _step("Finalising results…")
    return [row.tolist() for row in preds]


async def _run_task(task_id: str, video_path: str, fhash: str):
    """Background coroutine: run inference, cache result, update task store."""
    try:
        loop = asyncio.get_event_loop()
        frames = await loop.run_in_executor(
            None, run_inference, video_path, task_id
        )
        result_cache[fhash] = frames
        task_store[task_id]["frames"] = frames
        task_store[task_id]["status"] = "done"
    except Exception as e:
        task_store[task_id]["status"] = "error"
        task_store[task_id]["error"] = str(e)
        print(f"Task {task_id} failed: {e}")
    finally:
        try:
            os.unlink(video_path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/")
async def health():
    return {"status": "ok", "model_loaded": MODEL_LOADED}


@app.post("/predict")
async def predict(file: UploadFile = File(...)):
    """
    Accept a video, return task_id immediately.
    If result is already cached for this file, return frames directly.
    """
    suffix = os.path.splitext(file.filename or "video.mp4")[1] or ".mp4"

    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    try:
        content = await file.read()
        tmp.write(content)
        tmp.flush()
        tmp.close()

        fhash = _file_md5(tmp.name)

        # Cache hit — instant response
        if fhash in result_cache:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass
            frames = result_cache[fhash]
            return {"frames": frames, "n_frames": len(frames), "cached": True}

        # New file — kick off background task
        task_id = str(uuid.uuid4())
        task_store[task_id] = {
            "status":   "running",
            "progress": "Queued…",
            "frames":   None,
            "error":    None,
        }
        asyncio.create_task(_run_task(task_id, tmp.name, fhash))
        return {"task_id": task_id}

    except Exception:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        raise


@app.get("/task/{task_id}")
async def get_task(task_id: str):
    """Poll task status. Returns frames when done."""
    if task_id not in task_store:
        raise HTTPException(status_code=404, detail="Task not found")

    task = task_store[task_id]

    if task["status"] == "done":
        frames = task["frames"]
        del task_store[task_id]
        return {"status": "done", "frames": frames, "n_frames": len(frames)}

    if task["status"] == "error":
        error = task["error"]
        del task_store[task_id]
        return {"status": "error", "error": error}

    return {"status": "running", "progress": task["progress"]}


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

            tmp = tempfile.NamedTemporaryFile(suffix=".webm", delete=False)
            try:
                tmp.write(data)
                tmp.flush()
                tmp.close()

                try:
                    frames = await asyncio.get_event_loop().run_in_executor(
                        None, run_inference, tmp.name, None
                    )
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
