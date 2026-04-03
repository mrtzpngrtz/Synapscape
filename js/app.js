/**
 * app.js
 * Main application logic.
 *   - Checks backend health
 *   - Handles video file upload → POST /predict → frame-sync brain coloring
 *   - Handles webcam → MediaRecorder 3s chunks → WebSocket /ws → brain coloring
 */

const API = 'http://localhost:8000';
const WS  = 'ws://localhost:8000/ws';

// ── DOM refs ──────────────────────────────────────────────────────────────
const statusEl      = document.getElementById('status');
const videoInput    = document.getElementById('videoInput');
const webcamBtn     = document.getElementById('webcamBtn');
const stopBtn       = document.getElementById('stopBtn');
const videoWrapper  = document.getElementById('videoWrapper');
const webcamWrapper = document.getElementById('webcamWrapper');
const videoPreview  = document.getElementById('videoPreview');
const webcamPreview = document.getElementById('webcamPreview');
const frameInfo     = document.getElementById('frameInfo');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingText   = document.getElementById('loadingText');
const colormapSelect = document.getElementById('colormapSelect');
const colorbarCanvas = document.getElementById('colorbarCanvas');

// ── State ─────────────────────────────────────────────────────────────────
let videoFrames = [];    // [{activations: [...]}] from /predict
let videoFPS    = 2;     // TRIBE outputs ~1 frame per TR (2s); we'll sync by time
let webcamWs    = null;
let mediaRecorder = null;
let webcamStream  = null;
let activeColormap = 'rdbu';

// ── Init ──────────────────────────────────────────────────────────────────
BrainRenderer.init(document.getElementById('brainCanvas'));

BrainRenderer.onReady((nVertices) => {
  loadingOverlay.classList.add('hidden');
  setStatus('Ready', 'ok');
  console.log(`Brain mesh loaded — ${nVertices} vertices`);
});

drawColorbar(colorbarCanvas, activeColormap);

colormapSelect.addEventListener('change', () => {
  activeColormap = colormapSelect.value;
  drawColorbar(colorbarCanvas, activeColormap);
});

// Check backend health
checkBackend();

// ── Backend health check ──────────────────────────────────────────────────
async function checkBackend() {
  try {
    const res = await fetch(`${API}/`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    if (data.model_loaded) {
      setStatus('Model ready', 'ok');
    } else {
      setStatus('Demo mode (no model)', 'busy');
    }
  } catch {
    setStatus('Backend offline — start uvicorn', 'err');
  }
}

// ── Video file upload ─────────────────────────────────────────────────────
videoInput.addEventListener('change', async () => {
  const file = videoInput.files[0];
  if (!file) return;

  stopAll();
  videoFrames = [];

  videoPreview.src = URL.createObjectURL(file);
  videoWrapper.classList.remove('hidden');

  setStatus('Predicting...', 'busy');
  showLoading('Running TRIBE v2 inference...');
  stopBtn.disabled = false;

  try {
    const form = new FormData();
    form.append('file', file);

    const res = await fetch(`${API}/predict`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    videoFrames = data.frames;  // array of activation arrays

    hideLoading();
    setStatus(`${videoFrames.length} frames — play video`, 'ok');

    // Start syncing brain to video playback
    startVideoSync();

  } catch (e) {
    hideLoading();
    setStatus(`Error: ${e.message}`, 'err');
    console.error(e);
  }
});

function startVideoSync() {
  // TRIBE output rate: 1 frame per ~2s of video (hemodynamic TR)
  videoPreview.addEventListener('timeupdate', syncBrainToVideo);
}

function syncBrainToVideo() {
  if (!videoFrames.length) return;
  const t = videoPreview.currentTime;
  const duration = videoPreview.duration || 1;
  const idx = Math.min(
    Math.floor((t / duration) * videoFrames.length),
    videoFrames.length - 1
  );
  BrainRenderer.setActivations(videoFrames[idx], activeColormap);
  frameInfo.textContent = `Frame: ${idx + 1} / ${videoFrames.length}`;
}

// ── Webcam ────────────────────────────────────────────────────────────────
webcamBtn.addEventListener('click', startWebcam);

async function startWebcam() {
  stopAll();

  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  } catch (e) {
    setStatus('Webcam access denied', 'err');
    return;
  }

  webcamPreview.srcObject = webcamStream;
  webcamWrapper.classList.remove('hidden');
  stopBtn.disabled = false;

  // Open WebSocket
  webcamWs = new WebSocket(WS);
  webcamWs.binaryType = 'arraybuffer';

  webcamWs.onopen = () => {
    setStatus('Webcam live — updating every 3s', 'ok');
    startRecording();
  };

  webcamWs.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.activations) {
        BrainRenderer.setActivations(msg.activations, activeColormap);
        setStatus('Webcam live — brain updating', 'ok');
      } else if (msg.error) {
        console.warn('Inference error:', msg.error);
        setStatus('Inference failed on chunk — retrying...', 'busy');
      }
    } catch (e) {
      console.error('WS parse error:', e);
    }
  };

  webcamWs.onerror = (e) => { console.error('WS error:', e); setStatus('WebSocket error', 'err'); };
  webcamWs.onclose = () => setStatus('Webcam stopped', 'busy');
}

function startRecording() {
  const CHUNK_MS = 4000; // record 4s at a time → complete valid WebM each time

  function recordOnce() {
    if (!webcamStream || !webcamStream.active) return;
    if (!webcamWs || webcamWs.readyState !== WebSocket.OPEN) return;

    const options = { mimeType: 'video/webm;codecs=vp8' };
    try {
      mediaRecorder = new MediaRecorder(webcamStream, options);
    } catch {
      mediaRecorder = new MediaRecorder(webcamStream);
    }

    const chunks = [];
    mediaRecorder.ondataavailable = (evt) => {
      if (evt.data.size > 0) chunks.push(evt.data);
    };

    mediaRecorder.onstop = () => {
      if (!webcamWs || webcamWs.readyState !== WebSocket.OPEN) return;
      const blob = new Blob(chunks, { type: 'video/webm' });
      blob.arrayBuffer().then(buf => {
        if (webcamWs && webcamWs.readyState === WebSocket.OPEN) {
          webcamWs.send(buf);
          setStatus('Processing chunk...', 'busy');
        }
      });
      // Start next recording immediately
      recordOnce();
    };

    mediaRecorder.start();
    setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
    }, CHUNK_MS);
  }

  recordOnce();
}

// ── Stop ──────────────────────────────────────────────────────────────────
stopBtn.addEventListener('click', stopAll);

function stopAll() {
  // Stop MediaRecorder
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    mediaRecorder = null;
  }
  // Stop webcam stream
  if (webcamStream) {
    webcamStream.getTracks().forEach(t => t.stop());
    webcamStream = null;
  }
  // Close WebSocket
  if (webcamWs) {
    webcamWs.close();
    webcamWs = null;
  }
  // Hide previews
  videoWrapper.classList.add('hidden');
  webcamWrapper.classList.add('hidden');
  videoPreview.removeEventListener('timeupdate', syncBrainToVideo);
  stopBtn.disabled = true;
  videoInput.value = '';
}

// ── Helpers ───────────────────────────────────────────────────────────────
function setStatus(msg, cls = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + cls;
}

function showLoading(msg) {
  loadingText.textContent = msg;
  loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
  loadingOverlay.classList.add('hidden');
}
