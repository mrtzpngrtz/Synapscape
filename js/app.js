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
const volumeSlider   = document.getElementById('volumeSlider');
const volumeVal      = document.getElementById('volumeVal');
const fovSlider      = document.getElementById('fovSlider');
const fovVal         = document.getElementById('fovVal');
const zoomResetBtn   = document.getElementById('zoomResetBtn');
const blendSlider    = document.getElementById('blendSlider');
const blendVal       = document.getElementById('blendVal');
const loopBtn        = document.getElementById('loopBtn');
const loopStatus     = document.getElementById('loopStatus');
const cycleNumEl     = document.getElementById('cycleNum');
const loopFreqEl     = document.getElementById('loopFreq');
const telemBoldFreq  = document.getElementById('telemBoldFreq');
const telemCortexSync = document.getElementById('telemCortexSync');
const telemAiConf    = document.getElementById('telemAiConf');
const telemLatency   = document.getElementById('telemLatency');

// ── State ─────────────────────────────────────────────────────────────────
let videoFrames = [];    // [{activations: [...]}] from /predict
let videoFPS    = 2;     // TRIBE outputs ~1 frame per TR (2s); we'll sync by time
let webcamWs    = null;
let loopEnabled = false;
let cycleCount  = 0;
let mediaRecorder = null;
let webcamStream  = null;
let activeColormap = 'rdbu';

// ── Init ──────────────────────────────────────────────────────────────────
BrainRenderer.init(document.getElementById('brainCanvas'));
SynapscapeGraph.init();
SynapscapeGraph.setColormap(activeColormap);

fovSlider.addEventListener('input', () => {
  const v = parseInt(fovSlider.value);
  BrainRenderer.setFOV(v);
  fovVal.textContent = v + '°';
});

zoomResetBtn.addEventListener('click', () => {
  BrainRenderer.setZoom(1.0);
});

blendSlider.addEventListener('input', () => {
  const v = parseFloat(blendSlider.value);
  BrainRenderer.setBlend(v);
  blendVal.textContent = v.toFixed(2);
});
BrainRenderer.setBlend(parseFloat(blendSlider.value));

BrainRenderer.onReady((nVertices) => {
  loadingOverlay.classList.add('hidden');
  setStatus('Ready', 'ok');
  console.log(`Brain mesh loaded — ${nVertices} vertices`);
});

drawColorbar(colorbarCanvas, activeColormap);

colormapSelect.addEventListener('change', () => {
  activeColormap = colormapSelect.value;
  drawColorbar(colorbarCanvas, activeColormap);
  SynapscapeGraph.setColormap(activeColormap);
});

// ── Volume slider ──────────────────────────────────────────────────────────
if (volumeSlider) {
  volumeSlider.addEventListener('input', () => {
    videoPreview.volume = parseFloat(volumeSlider.value);
    volumeVal.textContent = Math.round(volumeSlider.value * 100) + '%';
  });
  // Sync slider if user adjusts native video controls
  videoPreview.addEventListener('volumechange', () => {
    volumeSlider.value = videoPreview.volume;
    volumeVal.textContent = Math.round(videoPreview.volume * 100) + '%';
  });
}

// ── View mode toggle ──────────────────────────────────────────────────────
const viewMeshBtn      = document.getElementById('viewMeshBtn');
const viewParticlesBtn = document.getElementById('viewParticlesBtn');
const viewGraphBtn     = document.getElementById('viewGraphBtn');

viewMeshBtn.addEventListener('click', () => {
  BrainRenderer.setMode('mesh');
  viewMeshBtn.classList.add('btn-active');
  viewParticlesBtn.classList.remove('btn-active');
});

viewParticlesBtn.addEventListener('click', () => {
  BrainRenderer.setMode('particles');
  viewParticlesBtn.classList.add('btn-active');
  viewMeshBtn.classList.remove('btn-active');
});

viewGraphBtn.addEventListener('click', () => {
  const on = SynapscapeGraph.toggle();
  viewGraphBtn.classList.toggle('btn-active', on);
});

// ── Loop sequence toggle ───────────────────────────────────────────────────
loopBtn.addEventListener('click', () => {
  loopEnabled = !loopEnabled;
  loopBtn.classList.toggle('btn-active', loopEnabled);
  if (!loopEnabled) {
    loopStatus.classList.add('hidden');
    cycleCount = 0;
  } else if (videoPreview.duration) {
    // Show freq immediately if video is already loaded
    loopFreqEl.textContent = loopHz(videoPreview.duration);
    loopStatus.classList.remove('hidden');
  }
});

// On every loop: increment cycle, rewind, keep going
videoPreview.addEventListener('ended', () => {
  if (!loopEnabled) return;
  cycleCount++;
  cycleNumEl.textContent = String(cycleCount).padStart(3, '0');
  loopFreqEl.textContent = loopHz(videoPreview.duration);
  loopStatus.classList.remove('hidden');
  videoPreview.currentTime = 0;
  videoPreview.play();
});

// ── Telemetry helpers ─────────────────────────────────────────────────────
function updateTelemetryOnLoad(inferenceMs) {
  const duration = videoPreview.duration || 1;
  const boldHz   = videoFrames.length / duration;
  telemBoldFreq.textContent = boldHz.toFixed(2) + ' Hz';

  const s = inferenceMs / 1000;
  telemLatency.textContent  = s < 60
    ? s.toFixed(1) + ' s'
    : Math.round(s / 60) + ' min ' + (Math.round(s) % 60) + ' s';
}

function updateTelemetryPerFrame(activations) {
  const n = activations.length;
  // AI_CONF: normalised mean absolute activation → [0, 1]
  let sumAbs = 0;
  for (let i = 0; i < n; i++) sumAbs += Math.abs(activations[i]);
  const meanAbs = sumAbs / n;
  // Typical fMRI z-score magnitude ~0.3–2.0; map to feel like a confidence
  const conf = Math.min(0.9999, meanAbs / 2.5);
  telemAiConf.textContent = conf.toFixed(4);

  // CORTEX_SYNC: % of vertices with |activation| > 1 z-score
  let active = 0;
  for (let i = 0; i < n; i++) if (Math.abs(activations[i]) > 1.0) active++;
  telemCortexSync.textContent = ((active / n) * 100).toFixed(1) + '%';
}

function loopHz(duration) {
  if (!duration || duration === Infinity) return '—\u00a0Hz';
  const hz = 1 / duration;
  return hz < 0.01
    ? hz.toExponential(2) + '\u00a0Hz'
    : hz.toFixed(3) + '\u00a0Hz';
}

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
  showLoading('Uploading sequence…');
  stopBtn.disabled = false;

  try {
    const form = new FormData();
    form.append('file', file);

    const res = await fetch(`${API}/predict`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();

    let inferenceMs = 0;
    if (data.cached) {
      videoFrames = data.frames;
      inferenceMs = data.inference_ms || 0;
      setStatus(`${videoFrames.length} frames — cached · play video`, 'ok');
    } else if (data.task_id) {
      const result = await pollTask(data.task_id);
      videoFrames = result.frames;
      inferenceMs = result.inference_ms || 0;
      setStatus(`${videoFrames.length} frames — play video`, 'ok');
    } else if (data.frames) {
      videoFrames = data.frames;
      setStatus(`${videoFrames.length} frames — play video`, 'ok');
    }

    hideLoading();
    // Wait for duration to be available, then update telem
    const onMeta = () => { updateTelemetryOnLoad(inferenceMs); videoPreview.removeEventListener('loadedmetadata', onMeta); };
    if (videoPreview.duration) updateTelemetryOnLoad(inferenceMs);
    else videoPreview.addEventListener('loadedmetadata', onMeta);
    startVideoSync();

  } catch (e) {
    hideLoading();
    setStatus(`Error: ${e.message}`, 'err');
    console.error(e);
  }
});

async function pollTask(taskId) {
  const POLL_MS = 900;
  while (true) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const res = await fetch(`${API}/task/${taskId}`);
    if (!res.ok) throw new Error(`Poll error HTTP ${res.status}`);
    const data = await res.json();
    if (data.status === 'done') return data;
    if (data.status === 'error') throw new Error(data.error);
    // Still running — show the step label from the backend
    showLoading(data.progress || 'Processing…');
    setStatus('TRIBE v2 inference running…', 'busy');
  }
}

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
  SynapscapeGraph.update(videoFrames[idx]);
  frameInfo.textContent = `Frame: ${idx + 1} / ${videoFrames.length}`;
  updateTelemetryPerFrame(videoFrames[idx]);
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
        SynapscapeGraph.update(msg.activations);
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
  // Reset loop
  loopEnabled = false;
  cycleCount  = 0;
  loopBtn.classList.remove('btn-active');
  loopStatus.classList.add('hidden');

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
