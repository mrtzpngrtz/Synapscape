/**
 * emotion.js — Synapscape Affect Decoder View
 *
 * Architecture:
 *   • Ring markers + callout lines are added to BrainRenderer's brainGroup,
 *     so they follow drag rotation and share the same world space.
 *   • Brain renders in particles / single L·LATERAL mode (brain.js).
 *   • Labels are drawn each frame on a 2D canvas by projecting world positions
 *     through BrainRenderer.getCamera(2) — no CSS2DRenderer needed.
 *
 * Public API
 *   EmotionView.init(container)
 *   EmotionView.show() / hide() / toggle()
 *   EmotionView.setEmotion(name)
 *   EmotionView.update(activations)
 */

const EmotionView = (() => {

  const N_VERTS = 20484;

  function vRange(lhS, lhE, rhS, rhE) {
    const lhN = lhE - lhS;
    const rhN = (rhS != null) ? rhE - rhS : 0;
    const a   = new Int32Array(lhN + rhN);
    for (let i = 0; i < lhN; i++) a[i]       = lhS + i;
    for (let i = 0; i < rhN; i++) a[lhN + i] = rhS + i;
    return a;
  }

  // Positions in brainGroup local space (same as brainMesh vertex space)
  const REGIONS = [
    { name: 'PREFRONTAL',    verts: vRange(   0,  520, 10242, 10762), pos: [-58,  48,  22] },
    { name: 'MOTOR',         verts: vRange( 940, 1200, 11182, 11442), pos: [-60,  58,  -5] },
    { name: "BROCA'S",       verts: vRange(1200, 1620,  null,  null ), pos: [-62,  12,  18] },
    { name: 'SOMATOSENSORY', verts: vRange(1620, 2200, 11862, 12442), pos: [-64,  48, -22] },
    { name: 'PARIETAL',      verts: vRange(2400, 3200, 12642, 13442), pos: [-66,  36, -42] },
    { name: "WERNICKE'S",    verts: vRange(7550, 7870, 17792, 18112), pos: [-64,   5, -42] },
    { name: 'TEMPORAL',      verts: vRange(7220, 7550, 17462, 17792), pos: [-68,  -8, -12] },
    { name: 'VISUAL',        verts: vRange(3200, 4100, 13442, 14342), pos: [-48, -22, -55] },
    { name: 'INSULA',        verts: vRange(8200, 8520, 18442, 18762), pos: [-62,   5,   5] },
  ];

  const EMOTIONS = {
    FEAR:     [52,  38, 28, 30, 32, 30, 58, 28, 92],
    JOY:      [85,  32, 44, 28, 48, 40, 52, 68, 38],
    ANGER:    [48,  72, 36, 58, 44, 28, 46, 24, 82],
    SADNESS:  [35,  22, 38, 25, 30, 42, 48, 18, 78],
    SURPRISE: [70,  42, 55, 48, 85, 62, 60, 92, 45],
    DISGUST:  [44,  28, 32, 38, 36, 38, 42, 22, 95],
    CALM:     [55,  18, 24, 20, 28, 25, 32, 38, 18],
    FOCUS:    [92,  55, 88, 48, 90, 78, 45, 58, 40],
  };

  // ── State ─────────────────────────────────────────────────────────────────
  let wrapper, lblCanvas, lblCtx;
  let container2d = null;
  let visible   = false;
  let rafHandle = null;

  let fromAct    = new Array(9).fill(0);
  let targetAct  = new Array(9).fill(0);
  let currentAct = new Array(9).fill(0);
  let animStart  = null;
  const ANIM_MS  = 300;

  let vertexToROI    = null;
  const roiCounts    = new Float64Array(9);
  const roiSums      = new Float64Array(9);
  let liveMode       = true;
  let liveBtnEl      = null;
  let activeEmotionBtn = null;

  // 3D objects added to brainGroup
  const markerMeshes = [];   // TorusGeometry rings
  const markerGroup  = new THREE.Group();  // added to / removed from brainGroup

  // Reusable projection vector
  const _proj = new THREE.Vector3();

  function easeInOut(t) { return t < 0.5 ? 2*t*t : -1+(4-2*t)*t; }

  function buildVertexIndex() {
    vertexToROI = new Int16Array(N_VERTS).fill(-1);
    for (let r = 0; r < REGIONS.length; r++) {
      const vs = REGIONS[r].verts;
      roiCounts[r] = vs.length;
      for (let i = 0; i < vs.length; i++) {
        const v = vs[i];
        if (v >= 0 && v < N_VERTS) vertexToROI[v] = r;
      }
    }
  }

  function update(activations) {
    if (!liveMode || !vertexToROI) return;
    roiSums.fill(0);
    const len = Math.min(activations.length, N_VERTS);
    for (let v = 0; v < len; v++) {
      const r = vertexToROI[v];
      if (r >= 0) roiSums[r] += activations[v];
    }
    let minA =  Infinity, maxA = -Infinity;
    for (let r = 0; r < 9; r++) {
      const m = roiCounts[r] > 0 ? roiSums[r] / roiCounts[r] : 0;
      if (m < minA) minA = m;
      if (m > maxA) maxA = m;
    }
    const range = maxA - minA || 1;
    fromAct = [...currentAct];
    for (let r = 0; r < 9; r++) {
      const m = roiCounts[r] > 0 ? roiSums[r] / roiCounts[r] : 0;
      targetAct[r] = ((m - minA) / range) * 100;
    }
    animStart = performance.now();
  }

  // ── Project world position → canvas pixel ─────────────────────────────────
  function toScreen(worldPos, cam, W, H) {
    _proj.copy(worldPos).project(cam);
    return {
      x: ( _proj.x + 1) / 2 * W,
      y: (-_proj.y + 1) / 2 * H,
    };
  }

  function animate(ts) {
    if (!visible) return;
    rafHandle = requestAnimationFrame(animate);

    if (animStart !== null) {
      const raw = Math.min((ts - animStart) / ANIM_MS, 1);
      const e   = easeInOut(raw);
      for (let i = 0; i < 9; i++) {
        currentAct[i] = fromAct[i] + (targetAct[i] - fromAct[i]) * e;
      }
      if (raw >= 1) animStart = null;
    }

    // Update ring materials
    for (let i = 0; i < 9; i++) {
      const t  = currentAct[i] / 100;
      const sc = 1.0 + t * 2.2;
      markerMeshes[i].scale.setScalar(sc);
      const bright = 0.22 + t * 0.78;
      markerMeshes[i].material.color.setRGB(bright, bright, bright);
      markerMeshes[i].material.emissiveIntensity = t * 1.1;
    }

    // Draw 2D labels + callout lines
    const cam = BrainRenderer.getCamera(2);
    const W   = lblCanvas.width;
    const H   = lblCanvas.height;
    lblCtx.clearRect(0, 0, W, H);

    lblCtx.font = '7px "JetBrains Mono", monospace';

    for (let i = 0; i < 9; i++) {
      const a  = currentAct[i];
      const t  = a / 100;

      // Get current world position of ring (follows brainGroup rotation)
      markerMeshes[i].getWorldPosition(_proj);
      const sp = toScreen(_proj, cam, W, H);

      // Skip if behind camera
      if (_proj.z > 1) continue;

      const alpha = 0.25 + t * 0.75;

      // Callout endpoint — push up/down based on Y position
      const offY = REGIONS[i].pos[1] >= 0 ? -32 : 32;
      const offX = REGIONS[i].pos[2] >= 0 ?  28 : -28;
      const lx = sp.x + offX;
      const ly = sp.y + offY;

      // Callout line
      lblCtx.beginPath();
      lblCtx.moveTo(sp.x, sp.y);
      lblCtx.lineTo(lx, ly);
      lblCtx.strokeStyle = `rgba(120,120,120,${(alpha * 0.6).toFixed(2)})`;
      lblCtx.lineWidth = 0.8;
      lblCtx.stroke();

      // Label text
      const name = REGIONS[i].name;
      const pct  = Math.round(a) + '%';
      const tw   = lblCtx.measureText(name).width;
      const alignRight = REGIONS[i].pos[2] < 0;
      const tx = alignRight ? lx - tw - 2 : lx + 2;

      lblCtx.fillStyle = `rgba(160,160,160,${alpha.toFixed(2)})`;
      lblCtx.fillText(name, tx, ly - 1);
      lblCtx.fillStyle = `rgba(220,220,220,${alpha.toFixed(2)})`;
      lblCtx.font = '8.5px "JetBrains Mono", monospace';
      lblCtx.fillText(pct, tx, ly + 9);
      lblCtx.font = '7px "JetBrains Mono", monospace';
    }
  }

  function init(container) {
    container2d = container;

    // ── Wrapper (transparent — brain canvas shows through) ────────────────────
    wrapper = document.createElement('div');
    wrapper.id = 'emotionWrapper';
    Object.assign(wrapper.style, {
      position: 'absolute', inset: '0', display: 'none',
      zIndex: '17', pointerEvents: 'none',
    });
    container.appendChild(wrapper);

    // ── Button bar ────────────────────────────────────────────────────────────
    const bar = document.createElement('div');
    bar.id = 'emotionBar';
    Object.assign(bar.style, {
      position: 'absolute', top: '0', left: '0', right: '0',
      display: 'flex', alignItems: 'center', gap: '5px',
      padding: '9px 14px 8px',
      background: 'rgba(8,8,8,0.82)',
      borderBottom: '1px solid #1c1c1c',
      userSelect: 'none', pointerEvents: 'auto', zIndex: '2',
    });
    wrapper.appendChild(bar);

    const barLabel = document.createElement('span');
    barLabel.textContent = 'AFFECT\u00b7STATE';
    Object.assign(barLabel.style, {
      fontFamily: "'JetBrains Mono', monospace", fontSize: '7.5px',
      letterSpacing: '0.16em', color: '#404040', marginRight: '8px',
    });
    bar.appendChild(barLabel);

    liveBtnEl = document.createElement('button');
    liveBtnEl.textContent = 'LIVE';
    liveBtnEl.className = 'btn btn-active';
    Object.assign(liveBtnEl.style, { fontSize: '7.5px', padding: '3px 10px', letterSpacing: '0.13em' });
    liveBtnEl.addEventListener('click', () => {
      liveMode = true;
      liveBtnEl.classList.add('btn-active');
      if (activeEmotionBtn) { activeEmotionBtn.classList.remove('btn-active'); activeEmotionBtn = null; }
    });
    bar.appendChild(liveBtnEl);

    const sep = document.createElement('span');
    Object.assign(sep.style, { width: '1px', background: '#222', alignSelf: 'stretch', margin: '0 4px', flexShrink: '0' });
    bar.appendChild(sep);

    Object.keys(EMOTIONS).forEach(name => {
      const btn = document.createElement('button');
      btn.textContent = name;
      btn.className = 'btn';
      Object.assign(btn.style, { fontSize: '7.5px', padding: '3px 10px', letterSpacing: '0.13em' });
      btn.addEventListener('click', () => {
        if (activeEmotionBtn) activeEmotionBtn.classList.remove('btn-active');
        btn.classList.add('btn-active');
        activeEmotionBtn = btn;
        setEmotion(name);
      });
      bar.appendChild(btn);
    });

    // ── 2D label canvas ───────────────────────────────────────────────────────
    lblCanvas = document.createElement('canvas');
    Object.assign(lblCanvas.style, {
      position: 'absolute', inset: '0',
      width: '100%', height: '100%',
      pointerEvents: 'none',
    });
    wrapper.appendChild(lblCanvas);
    lblCtx = lblCanvas.getContext('2d');

    // Size canvas to container
    function resizeCanvas() {
      lblCanvas.width  = container.clientWidth  || 900;
      lblCanvas.height = container.clientHeight || 620;
    }
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // ── Ring markers (added to brainGroup so they follow drag) ───────────────
    const ringGeo = new THREE.TorusGeometry(1.0, 0.09, 6, 32);

    REGIONS.forEach((reg, i) => {
      const p = new THREE.Vector3(...reg.pos);
      const ringMat = new THREE.MeshStandardMaterial({
        color:             new THREE.Color(0.22, 0.22, 0.22),
        emissive:          new THREE.Color(0.1,  0.1,  0.1),
        emissiveIntensity: 0.1,
        roughness:         0.3,
        metalness:         0.05,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.copy(p);
      ring.rotation.y = Math.PI / 2;   // face the L·LATERAL camera (along +X)
      ring.scale.setScalar(1.0);
      markerGroup.add(ring);
      markerMeshes.push(ring);
    });

    buildVertexIndex();
    currentAct.fill(0);
    targetAct.fill(0);
  }

  function setEmotion(name) {
    const vals = EMOTIONS[name];
    if (!vals) return;
    liveMode = false;
    if (liveBtnEl) liveBtnEl.classList.remove('btn-active');
    fromAct   = [...currentAct];
    targetAct = [...vals];
    animStart = performance.now();
  }

  const _vlEls = () => document.querySelectorAll('.vl, .view-divider, .reticle');

  function show() {
    visible = true;
    wrapper.style.display = 'block';
    BrainRenderer.setMode('particles');
    BrainRenderer.setSingleView(2);
    BrainRenderer.addToBrainGroup(markerGroup);
    _vlEls().forEach(el => el.style.visibility = 'hidden');
    animStart = null;
    rafHandle = requestAnimationFrame(animate);
  }

  function hide() {
    visible = false;
    wrapper.style.display = 'none';
    BrainRenderer.clearSingleView();
    BrainRenderer.removeFromBrainGroup(markerGroup);
    _vlEls().forEach(el => el.style.visibility = '');
    if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
  }

  function toggle() {
    if (visible) hide(); else show();
    return visible;
  }

  return { init, show, hide, toggle, setEmotion, update };
})();
