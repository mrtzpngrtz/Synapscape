/**
 * graph.js — Synapscape Brain Region Connectivity Graph
 *
 * Renders as an overlay canvas inside #brainContainer, shown when the
 * "Graph" tab is active.  Surface / Particles / Graph share the same viewport.
 *
 * Public API
 *   SynapscapeGraph.init(container)   call once; container = #brainContainer
 *   SynapscapeGraph.update(arr)       Float32Array of raw vertex activations
 *   SynapscapeGraph.setColormap(str)  'rdbu' | 'hot' | 'viridis'
 *   SynapscapeGraph.show()            make overlay visible
 *   SynapscapeGraph.hide()            make overlay hidden
 *   SynapscapeGraph.toggle()          flip visibility; returns new state
 */

const SynapscapeGraph = (() => {

  // Fixed world-space extents (camera maps these to whatever CW×CH the
  // container happens to be at init time)
  const CAM_HW = 200;
  let   CAM_HH = 154;   // set in init() based on actual container dimensions
  let   CW     = 800;
  let   CH     = 600;

  const N_VERTS = 20484;

  // ── Vertex-range helper ───────────────────────────────────────────────────
  function vRange(lhS, lhE, rhS, rhE) {
    const lhN = lhE - lhS;
    const rhN = (rhS != null) ? rhE - rhS : 0;
    const a   = new Int32Array(lhN + rhN);
    for (let i = 0; i < lhN; i++) a[i]       = lhS + i;
    for (let i = 0; i < rhN; i++) a[lhN + i] = rhS + i;
    return a;
  }

  // ── ROI table ─────────────────────────────────────────────────────────────
  const ROIS = [
    // ── Frontal / cingulate (top) ────────────────────────────────────────────
    { name: 'PFC',      verts: vRange(    0,  520, 10242, 10762), x:   0, y: 128, r:16 },
    { name: 'ACC',      verts: vRange(  520,  940, 10762, 11182), x:   0, y:  88, r:14 },
    // ── Language ────────────────────────────────────────────────────────────
    { name: 'Broca',    verts: vRange( 1200, 1620, null,  null  ), x:-122, y:  62, r:13 },
    { name: 'PostPar',  verts: vRange( 2400, 2800, 12642, 13042), x: -32, y:  65, r:13 },
    { name: 'Angular',  verts: vRange( 2800, 3200, 13042, 13442), x:  65, y:  65, r:13 },
    { name: 'Wernicke', verts: vRange( 7550, 7870, 17792, 18112), x: 102, y:  48, r:13 },
    // ── Insula / thalamus (mid) ──────────────────────────────────────────────
    { name: 'Insula',   verts: vRange( 8200, 8520, 18442, 18762), x:  55, y:  14, r:13 },
    { name: 'Thalamus', verts: vRange( 9030, 9240, 19272, 19482), x:   0, y:   8, r:13 },
    // ── Auditory ────────────────────────────────────────────────────────────
    { name: 'STG',      verts: vRange( 6820, 7220, 17062, 17462), x: 110, y:   8, r:13 },
    { name: 'STS',      verts: vRange( 7220, 7550, 17462, 17792), x:  78, y:  30, r:13 },
    { name: 'A1',       verts: vRange( 6400, 6820, 16642, 17062), x: 128, y: -20, r:13 },
    // ── Medial temporal ─────────────────────────────────────────────────────
    { name: 'Hippo',    verts: vRange( 8520, 8830, 18762, 19072), x: -55, y: -15, r:13 },
    { name: 'Amygdala', verts: vRange( 8830, 9030, 19072, 19272), x: -88, y: -38, r:13 },
    // ── Ventral temporal ────────────────────────────────────────────────────
    { name: 'FFA',      verts: vRange( 5420, 5720, 15662, 15962), x:-118, y: -58, r:13 },
    { name: 'PPA',      verts: vRange( 5720, 6020, 15962, 16262), x: -62, y: -60, r:13 },
    // ── Visual ──────────────────────────────────────────────────────────────
    { name: 'MT',       verts: vRange( 5000, 5420, 15242, 15662), x:  78, y: -80, r:13 },
    { name: 'V4',       verts: vRange( 4100, 4500, 14342, 14742), x: -82, y: -86, r:13 },
    { name: 'V2',       verts: vRange( 3650, 4100, 13892, 14342), x:   0, y: -98, r:12 },
    { name: 'V1',       verts: vRange( 3200, 3650, 13442, 13892), x:   0, y:-128, r:12 },
    // ── Cerebellum (bottom) ──────────────────────────────────────────────────
    { name: 'Cerebel',  verts: vRange( 9240, 9660, 19482, 19902), x:-105, y:-128, r:12 },
  ];

  // ── Connectivity edges ────────────────────────────────────────────────────
  const EDGES = [
    [0,1], [1,2], [2,3], [1,3],
    [2,4], [4,5],
    [3,8],
    [6,7], [7,8], [8,9],
    [9,11], [9,10], [10,7],
    [11,12], [12,13], [13,14],
    [13,15], [14,15],
    [16,17], [16,5], [17,15],
    [18,6], [18,16], [18,13],
    [19,0], [19,13],
  ];

  // ── Module state ──────────────────────────────────────────────────────────
  let renderer2, scene2, camera2;
  let canvas2, lblCanvas;
  let visible  = false;
  let colormap = 'rdbu';

  // Typed arrays for fast per-frame aggregation
  let vertexToROI = null;
  const roiCounts = new Float64Array(ROIS.length);
  const roiSums   = new Float64Array(ROIS.length);
  const roiMeans  = new Float32Array(ROIS.length);

  const nodeDiscs = [];
  const nodeGlows = [];
  const edgeObjs  = [];

  // ── Build vertex→ROI lookup ───────────────────────────────────────────────
  function buildVertexIndex() {
    vertexToROI = new Int16Array(N_VERTS).fill(-1);
    for (let r = 0; r < ROIS.length; r++) {
      const vs = ROIS[r].verts;
      roiCounts[r] = vs.length;
      for (let i = 0; i < vs.length; i++) {
        const v = vs[i];
        if (v >= 0 && v < N_VERTS) vertexToROI[v] = r;
      }
    }
  }

  // ── Radial glow texture ───────────────────────────────────────────────────
  function makeGlowTex() {
    const sz  = 64;
    const c   = document.createElement('canvas');
    c.width   = sz; c.height = sz;
    const ctx = c.getContext('2d');
    const g   = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0,    'rgba(255,255,255,0.92)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.5,  'rgba(255,255,255,0.12)');
    g.addColorStop(1,    'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, sz, sz);
    return new THREE.CanvasTexture(c);
  }

  // ── World → canvas-pixel ──────────────────────────────────────────────────
  function w2px(wx, wy) {
    return {
      x: (wx + CAM_HW) / (CAM_HW * 2) * CW,
      y: (CAM_HH - wy) / (CAM_HH * 2) * CH,
    };
  }

  // ── init ──────────────────────────────────────────────────────────────────
  function init(container) {
    buildVertexIndex();

    CW    = container.clientWidth  || 800;
    CH    = container.clientHeight || 600;
    CAM_HH = Math.max(CAM_HW * (CH / CW), 155); // ensure bottom nodes (y=-128) always fit

    // Three.js canvas — sits on top of the brain canvas, fully opaque
    canvas2 = document.createElement('canvas');
    canvas2.width  = CW;
    canvas2.height = CH;
    Object.assign(canvas2.style, {
      position:     'absolute',
      inset:        '0',
      display:      'none',
      zIndex:       '15',
      pointerEvents:'none',
    });
    container.appendChild(canvas2);

    // 2D label overlay on top of the Three.js canvas
    lblCanvas = document.createElement('canvas');
    lblCanvas.width  = CW;
    lblCanvas.height = CH;
    Object.assign(lblCanvas.style, {
      position:     'absolute',
      inset:        '0',
      display:      'none',
      zIndex:       '16',
      pointerEvents:'none',
    });
    container.appendChild(lblCanvas);

    // Three.js renderer
    renderer2 = new THREE.WebGLRenderer({ canvas: canvas2, antialias: true });
    renderer2.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer2.setSize(CW, CH);
    renderer2.setClearColor(0x080808, 1);   // same dark bg as main brain view

    camera2 = new THREE.OrthographicCamera(-CAM_HW, CAM_HW, CAM_HH, -CAM_HH, 0, 100);
    camera2.position.z = 10;
    scene2  = new THREE.Scene();

    const glowTex = makeGlowTex();
    const discGeo = new THREE.CircleGeometry(1, 28);

    // Node objects
    for (let i = 0; i < ROIS.length; i++) {
      const { x, y, r } = ROIS[i];

      const glowMat = new THREE.SpriteMaterial({
        map:         glowTex,
        transparent: true,
        blending:    THREE.AdditiveBlending,
        opacity:     0.4,
      });
      const glow = new THREE.Sprite(glowMat);
      glow.position.set(x, y, 0);
      glow.scale.setScalar(r * 2.2);
      scene2.add(glow);
      nodeGlows.push(glow);

      const discMat = new THREE.MeshBasicMaterial({
        color:       0x888888,
        transparent: true,
        opacity:     0.9,
      });
      const disc = new THREE.Mesh(discGeo, discMat);
      disc.position.set(x, y, 1);
      disc.scale.setScalar(r);
      scene2.add(disc);
      nodeDiscs.push(disc);
    }

    // Edge objects
    for (const [a, b] of EDGES) {
      const pos = new Float32Array([
        ROIS[a].x, ROIS[a].y, 0.3,
        ROIS[b].x, ROIS[b].y, 0.3,
      ]);
      const geo  = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat  = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.1 });
      const line = new THREE.Line(geo, mat);
      scene2.add(line);
      edgeObjs.push({ line, mat, a, b });
    }

    drawLabels();
  }

  // ── Draw static node labels ───────────────────────────────────────────────
  function drawLabels() {
    const ctx = lblCanvas.getContext('2d');
    ctx.clearRect(0, 0, CW, CH);
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    for (const roi of ROIS) {
      const { x, y } = w2px(roi.x, roi.y);
      const rPx = roi.r * (CW / (CAM_HW * 2));
      ctx.font      = '9px "JetBrains Mono", "Roboto Mono", monospace';
      ctx.fillStyle = 'rgba(120,120,120,0.85)';
      ctx.fillText(roi.name, x, y + rPx + 4);
    }
  }

  // ── update — call each frame with raw vertex activations ──────────────────
  function update(activations) {
    if (!renderer2 || !visible) return;

    roiSums.fill(0);
    const len = Math.min(activations.length, N_VERTS);
    for (let v = 0; v < len; v++) {
      const r = vertexToROI[v];
      if (r >= 0) roiSums[r] += activations[v];
    }
    let minA =  Infinity;
    let maxA = -Infinity;
    for (let r = 0; r < ROIS.length; r++) {
      roiMeans[r] = roiCounts[r] > 0 ? roiSums[r] / roiCounts[r] : 0;
      if (roiMeans[r] < minA) minA = roiMeans[r];
      if (roiMeans[r] > maxA) maxA = roiMeans[r];
    }
    const range    = maxA - minA || 1;
    const maxAbsA  = Math.max(Math.abs(minA), Math.abs(maxA)) || 1;

    const fn = (typeof Colormaps !== 'undefined' && Colormaps[colormap])
               || ((t) => [t, t, t]);

    for (let i = 0; i < ROIS.length; i++) {
      const t       = (roiMeans[i] - minA) / range;
      const absNorm = Math.abs(roiMeans[i]) / maxAbsA;

      const [r, g, b] = fn(t);
      const sc = ROIS[i].r * (1.0 + absNorm * 2.2);

      nodeDiscs[i].material.color.setRGB(r, g, b);
      nodeDiscs[i].scale.setScalar(sc);

      nodeGlows[i].material.color.setRGB(r, g, b);
      nodeGlows[i].scale.setScalar(sc * 3.0);
      nodeGlows[i].material.opacity = 0.12 + absNorm * 0.55;
    }

    for (const { mat, a, b } of edgeObjs) {
      const actA = Math.abs(roiMeans[a]) / maxAbsA;
      const actB = Math.abs(roiMeans[b]) / maxAbsA;
      mat.opacity = 0.02 + actA * actB * 0.55;
    }

    renderer2.render(scene2, camera2);
  }

  // ── show / hide / toggle ──────────────────────────────────────────────────
  function show() {
    visible = true;
    canvas2.style.display   = 'block';
    lblCanvas.style.display = 'block';
    update(new Float32Array(N_VERTS));
  }

  function hide() {
    visible = false;
    canvas2.style.display   = 'none';
    lblCanvas.style.display = 'none';
  }

  function toggle() {
    if (visible) hide(); else show();
    return visible;
  }

  // ── setColormap ───────────────────────────────────────────────────────────
  function setColormap(name) {
    colormap = name;
  }

  return { init, update, setColormap, show, hide, toggle };
})();
