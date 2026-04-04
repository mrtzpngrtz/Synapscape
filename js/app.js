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
const statusEl        = document.getElementById('status');
const videoInput      = document.getElementById('videoInput');
const webcamBtn       = document.getElementById('webcamBtn');
const stopBtn         = document.getElementById('stopBtn');
const videoWrapper    = document.getElementById('videoWrapper');
const webcamWrapper   = document.getElementById('webcamWrapper');
const videoPreview    = document.getElementById('videoPreview');
const webcamPreview   = document.getElementById('webcamPreview');
const frameInfo       = document.getElementById('frameInfo');
const loadingOverlay  = document.getElementById('loadingOverlay');
const loadingText     = document.getElementById('loadingText');
const colorbarCanvas  = document.getElementById('colorbarCanvas');
const volumeSlider    = document.getElementById('volumeSlider');
const volumeVal       = document.getElementById('volumeVal');
const loopBtn         = document.getElementById('loopBtn');
const loopStatus      = document.getElementById('loopStatus');
const cycleNumEl      = document.getElementById('cycleNum');
const loopFreqEl      = document.getElementById('loopFreq');
const telemBoldFreq   = document.getElementById('telemBoldFreq');
const telemCortexSync = document.getElementById('telemCortexSync');
const telemAiConf     = document.getElementById('telemAiConf');
const telemLatency    = document.getElementById('telemLatency');
// Surface settings
const colormapSelect  = document.getElementById('colormapSelect');
const fovSlider       = document.getElementById('fovSlider');
const fovVal          = document.getElementById('fovVal');
const zoomResetBtn    = document.getElementById('zoomResetBtn');
const blendSlider     = document.getElementById('blendSlider');
const blendVal        = document.getElementById('blendVal');
// Particles settings
const particleScaleSlider = document.getElementById('particleScaleSlider');
const particleScaleVal    = document.getElementById('particleScaleVal');
const fovSliderP          = document.getElementById('fovSliderP');
const fovValP             = document.getElementById('fovValP');
// Graph settings
const colormapSelectGraph = document.getElementById('colormapSelectGraph');
// Tab settings panels
const settingsSurface   = document.getElementById('settingsSurface');
const settingsParticles = document.getElementById('settingsParticles');
const settingsGraph     = document.getElementById('settingsGraph');
const settingsAffect    = document.getElementById('settingsAffect');
// Frame timeline
const frameTimeline     = document.getElementById('frameTimeline');
const timelineCanvas    = document.getElementById('timelineCanvas');
const timelinePlayhead  = document.getElementById('timelinePlayhead');
const timelineLabel     = document.getElementById('timelineLabel');

// ── State ─────────────────────────────────────────────────────────────────
let videoFrames = [];
let videoFPS    = 2;
let webcamWs    = null;
let loopEnabled = false;
let cycleCount  = 0;
let mediaRecorder = null;
let webcamStream  = null;
let activeColormap = 'rdbu';

// Per-tab view states — null means "use default on first visit"
const _defaultState = () => ({ azimuth: 0, elevation: 0, zoom: 1.0 });
const tabViewStates = { mesh: null, particles: null, emotion: null };
let   currentTab    = 'mesh';

// ── Timeline ──────────────────────────────────────────────────────────────
let timelineDragging = false;

function drawTimeline() {
  const W = frameTimeline.clientWidth;
  const H = frameTimeline.clientHeight;
  timelineCanvas.width  = W;
  timelineCanvas.height = H;
  const ctx = timelineCanvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const n = videoFrames.length;
  if (!n) {
    timelineLabel.textContent = '';
    return;
  }

  timelineLabel.textContent = `SEQ · ${n} FR`;

  // Baseline track
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, Math.round(H / 2) - 1, W, 2);

  // Frame ticks
  for (let i = 0; i < n; i++) {
    const x = Math.round((i / Math.max(n - 1, 1)) * (W - 1));
    const edge = (i === 0 || i === n - 1);
    ctx.fillStyle = edge ? '#3a3a3a' : '#262626';
    ctx.fillRect(x, edge ? 5 : 9, 1, H - (edge ? 10 : 18));
  }
}

function updateTimelinePlayhead() {
  if (!videoPreview.duration) return;
  const pct = (videoPreview.currentTime / videoPreview.duration) * 100;
  timelinePlayhead.style.left = pct.toFixed(2) + '%';
}

function seekFromTimeline(e) {
  if (!videoPreview.src || !videoPreview.duration) return;
  const rect = frameTimeline.getBoundingClientRect();
  const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
  videoPreview.currentTime = (x / rect.width) * videoPreview.duration;
}

frameTimeline.addEventListener('mousedown', (e) => {
  timelineDragging = true;
  seekFromTimeline(e);
});
window.addEventListener('mousemove', (e) => {
  if (timelineDragging) seekFromTimeline(e);
});
window.addEventListener('mouseup', () => { timelineDragging = false; });
window.addEventListener('resize', drawTimeline);
videoPreview.addEventListener('timeupdate', updateTimelinePlayhead);

// ── Init ──────────────────────────────────────────────────────────────────
BrainRenderer.init(document.getElementById('brainCanvas'));
SynapscapeGraph.init(document.getElementById('brainContainer'));
SynapscapeGraph.setColormap(activeColormap);
EmotionView.init(document.getElementById('brainContainer'));

// ── Surface settings ──────────────────────────────────────────────────────
fovSlider.addEventListener('input', () => {
  const v = parseInt(fovSlider.value);
  BrainRenderer.setFOV(v);
  fovVal.textContent = v + '°';
  fovSliderP.value = v;
  fovValP.textContent = v + '°';
});

zoomResetBtn.addEventListener('click', () => BrainRenderer.setZoom(1.0));

blendSlider.addEventListener('input', () => {
  const v = parseFloat(blendSlider.value);
  BrainRenderer.setBlend(v);
  blendVal.textContent = v.toFixed(2);
});
BrainRenderer.setBlend(parseFloat(blendSlider.value));

// ── Particles settings ────────────────────────────────────────────────────
particleScaleSlider.addEventListener('input', () => {
  const v = parseFloat(particleScaleSlider.value);
  BrainRenderer.setParticleScale(v);
  particleScaleVal.textContent = v.toFixed(2) + '×';
});

fovSliderP.addEventListener('input', () => {
  const v = parseInt(fovSliderP.value);
  BrainRenderer.setFOV(v);
  fovValP.textContent = v + '°';
  fovSlider.value = v;
  fovVal.textContent = v + '°';
});

// ── Colormap ──────────────────────────────────────────────────────────────
drawColorbar(colorbarCanvas, activeColormap);

function applyColormap(name) {
  activeColormap = name;
  colormapSelect.value = name;
  colormapSelectGraph.value = name;
  drawColorbar(colorbarCanvas, name);
  SynapscapeGraph.setColormap(name);
}

colormapSelect.addEventListener('change', () => applyColormap(colormapSelect.value));
colormapSelectGraph.addEventListener('change', () => applyColormap(colormapSelectGraph.value));

// ── Volume ────────────────────────────────────────────────────────────────
volumeSlider.addEventListener('input', () => {
  videoPreview.volume = parseFloat(volumeSlider.value);
  volumeVal.textContent = Math.round(volumeSlider.value * 100) + '%';
});
videoPreview.addEventListener('volumechange', () => {
  volumeSlider.value = videoPreview.volume;
  volumeVal.textContent = Math.round(videoPreview.volume * 100) + '%';
});

BrainRenderer.onReady((nVertices) => {
  loadingOverlay.classList.add('hidden');
  setStatus('Ready', 'ok');
  console.log(`Brain mesh loaded — ${nVertices} vertices`);
});

// ── Tab switching ─────────────────────────────────────────────────────────
const viewMeshBtn      = document.getElementById('viewMeshBtn');
const viewParticlesBtn = document.getElementById('viewParticlesBtn');
const viewGraphBtn     = document.getElementById('viewGraphBtn');
const viewEmotionBtn   = document.getElementById('viewEmotionBtn');

function setViewTab(tab) {
  // Save outgoing view state (graph has no 3D brain state)
  if (currentTab !== 'graph') {
    tabViewStates[currentTab] = BrainRenderer.getViewState();
  }
  currentTab = tab;

  viewMeshBtn.classList.toggle('tab-active',      tab === 'mesh');
  viewParticlesBtn.classList.toggle('tab-active',  tab === 'particles');
  viewGraphBtn.classList.toggle('tab-active',      tab === 'graph');
  viewEmotionBtn.classList.toggle('tab-active',    tab === 'emotion');

  settingsSurface.classList.toggle('hidden',   tab !== 'mesh');
  settingsParticles.classList.toggle('hidden', tab !== 'particles');
  settingsGraph.classList.toggle('hidden',     tab !== 'graph');
  settingsAffect.classList.toggle('hidden',    tab !== 'emotion');

  if (tab === 'graph') {
    SynapscapeGraph.show();
    EmotionView.hide();
    BrainRenderer.setMode('mesh');
  } else if (tab === 'emotion') {
    SynapscapeGraph.hide();
    EmotionView.show();  // handles setSingleView + setMode('particles')
    // Restore affect-tab state, or use default
    BrainRenderer.setViewState(tabViewStates.emotion || _defaultState());
  } else {
    SynapscapeGraph.hide();
    EmotionView.hide();
    BrainRenderer.setMode(tab);
    // Restore this tab's state, or use default
    BrainRenderer.setViewState(tabViewStates[tab] || _defaultState());
  }
}

viewMeshBtn.addEventListener('click',      () => setViewTab('mesh'));
viewParticlesBtn.addEventListener('click', () => setViewTab('particles'));
viewGraphBtn.addEventListener('click',     () => setViewTab('graph'));
viewEmotionBtn.addEventListener('click',   () => setViewTab('emotion'));

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
    drawTimeline();
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
  EmotionView.update(videoFrames[idx]);
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
        EmotionView.update(msg.activations);
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
