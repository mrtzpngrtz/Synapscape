/**
 * graph.js — Synapscape Brain Region Connectivity Graph
 *
 * Renders a floating panel (400×300 px) showing mean activation per ROI as
 * a connectivity graph, synced to the same frame data as the 3-D brain view.
 *
 * ─── SWITCHING FROM DESIKAN-KILLIANY TO GLASSER 360 ───────────────────────
 * Each ROIS entry contains a `verts` Int32Array of fsaverage5 vertex indices.
 * To remap to Glasser MMP1.0 (360 parcels):
 *   1. Fetch `assets/glasser360_fsavg5_verts.json`  — object mapping
 *      parcel name → flat array of 0-based vertex indices (LH 0–10241,
 *      RH 10242–20483).
 *   2. After JSON.parse, replace ROIS[i].verts with
 *      Int32Array.from(atlasData[ROIS[i].name]) for each ROI.
 *   3. Call buildVertexIndex() once.  Everything downstream is atlas-agnostic.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Public API
 *   SynapscapeGraph.init()            call once after DOM ready
 *   SynapscapeGraph.update(arr)       Float32Array of raw vertex activations
 *   SynapscapeGraph.setColormap(str)  'rdbu' | 'hot' | 'viridis'
 *   SynapscapeGraph.toggle()          show / hide panel; returns current state
 */

const SynapscapeGraph = (() => {

  // ── Panel dimensions ──────────────────────────────────────────────────────
  const W   = 680;   // panel width  (px)
  const H   = 520;   // panel height (px)
  const HDR = 20;    // header bar   (px)
  const CW  = W;
  const CH  = H - HDR;

  // World-space extents are FIXED regardless of panel pixel size.
  // Increasing W/H makes each world unit render at more pixels (zoom in).
  // x ∈ [-200, 200],  y ∈ [-140, 140]  (anterior = +y, posterior = -y)
  const CAM_HW = 200;
  const CAM_HH = 140;

  const N_VERTS = 20484;   // fsaverage5: 10242 LH + 10242 RH

  // ── Vertex-range helper ───────────────────────────────────────────────────
  // Builds an Int32Array covering [lhStart, lhEnd) and, if given, [rhStart, rhEnd).
  // Pass null for rhStart/rhEnd for LH-only parcels (e.g. Broca).
  function vRange(lhS, lhE, rhS, rhE) {
    const lhN = lhE - lhS;
    const rhN = (rhS != null) ? rhE - rhS : 0;
    const a   = new Int32Array(lhN + rhN);
    for (let i = 0; i < lhN; i++) a[i]       = lhS + i;
    for (let i = 0; i < rhN; i++) a[lhN + i] = rhS + i;
    return a;
  }

  // ── ROI table ─────────────────────────────────────────────────────────────
  // `verts`  — approximate fsaverage5 vertex indices (LH 0–10241, RH 10242–20483).
  //            These are contiguous range estimates; replace with real atlas data
  //            (see header) for anatomically precise boundaries.
  // `x`, `y` — 2-D panel position in world units (anterior = top).
  // `r`      — base node radius in world units.
  const ROIS = [
    // ── Visual ──────────────────────────────────────────────────────────────
    { name: 'V1',       verts: vRange( 3200, 3650, 13442, 13892), x:   0, y:-118, r: 8 },
    { name: 'V2',       verts: vRange( 3650, 4100, 13892, 14342), x:  22, y: -98, r: 7 },
    { name: 'V4',       verts: vRange( 4100, 4500, 14342, 14742), x: -42, y: -82, r: 7 },
    { name: 'MT',       verts: vRange( 5000, 5420, 15242, 15662), x:  65, y: -68, r: 7 },
    // ── Ventral temporal ────────────────────────────────────────────────────
    { name: 'FFA',      verts: vRange( 5420, 5720, 15662, 15962), x: -72, y: -55, r: 7 },
    { name: 'PPA',      verts: vRange( 5720, 6020, 15962, 16262), x: -32, y: -55, r: 7 },
    // ── Auditory ────────────────────────────────────────────────────────────
    { name: 'A1',       verts: vRange( 6400, 6820, 16642, 17062), x:  90, y:  -8, r: 8 },
    { name: 'STG',      verts: vRange( 6820, 7220, 17062, 17462), x: 102, y:   8, r: 7 },
    { name: 'STS',      verts: vRange( 7220, 7550, 17462, 17792), x:  86, y:  24, r: 7 },
    // ── Language ────────────────────────────────────────────────────────────
    { name: 'Wernicke', verts: vRange( 7550, 7870, 17792, 18112), x:  68, y:  40, r: 7 },
    { name: 'Broca',    verts: vRange( 1200, 1620, null,  null  ), x: -90, y:  58, r: 7 },  // LH-dominant
    // ── Parietal ────────────────────────────────────────────────────────────
    { name: 'Angular',  verts: vRange( 2800, 3200, 13042, 13442), x:  56, y:  54, r: 7 },
    { name: 'PostPar',  verts: vRange( 2400, 2800, 12642, 13042), x:  18, y:  64, r: 7 },
    // ── Frontal / cingulate ──────────────────────────────────────────────────
    { name: 'PFC',      verts: vRange(    0,  520, 10242, 10762), x:   0, y: 122, r: 9 },
    { name: 'ACC',      verts: vRange(  520,  940, 10762, 11182), x:   0, y:  82, r: 8 },
    // ── Insula ──────────────────────────────────────────────────────────────
    { name: 'Insula',   verts: vRange( 8200, 8520, 18442, 18762), x:  42, y:  14, r: 7 },
    // ── Medial temporal ─────────────────────────────────────────────────────
    { name: 'Hippo',    verts: vRange( 8520, 8830, 18762, 19072), x: -42, y: -18, r: 7 },
    { name: 'Amygdala', verts: vRange( 8830, 9030, 19072, 19272), x: -68, y: -34, r: 7 },
    // ── Subcortical (vertices approximate — not on pial surface) ────────────
    { name: 'Thalamus', verts: vRange( 9030, 9240, 19272, 19482), x:   0, y:   6, r: 7 },
    { name: 'Cerebel',  verts: vRange( 9240, 9660, 19482, 19902), x:   0, y:-132, r: 8 },
  ];

  // ── Connectivity edges ────────────────────────────────────────────────────
  // Index pairs into ROIS. Based on known functional connectivity.
  const EDGES = [
    // Visual hierarchy
    [0,1], [1,2], [2,3], [1,3],         // V1–V2–V4–MT (triangle)
    [2,4], [4,5],                        // V4→FFA, FFA–PPA
    [3,8],                               // MT→STS (motion→multisensory)
    // Auditory / language
    [6,7], [7,8], [8,9],                 // A1–STG–STS–Wernicke
    [9,11], [9,10], [10,7],              // Wernicke–Angular, Wernicke–Broca, Broca–STG
    // Parietal–frontal (dorsal stream / executive)
    [11,12], [12,13], [13,14],           // Angular–PostPar–PFC–ACC
    [13,15], [14,15],                    // PFC–Insula, ACC–Insula
    // Medial temporal
    [16,17], [16,5], [17,15],            // Hippo–Amygdala, Hippo–PPA, Amygdala–Insula
    // Thalamo-cortical relay
    [18,6], [18,16], [18,13],            // Thalamus–A1, –Hippo, –PFC
    // Cerebellar
    [19,0], [19,13],                     // Cerebel–V1 (visuo-motor), –PFC
  ];

  // ── Module state ──────────────────────────────────────────────────────────
  let renderer2, scene2, camera2;
  let panel, canvas2, lblCanvas;
  let visible   = false;
  let colormap  = 'rdbu';

  // Typed arrays for fast per-frame aggregation
  let vertexToROI = null;                          // Int16Array[N_VERTS], –1 = unassigned
  const roiCounts = new Float64Array(ROIS.length); // vertex count per ROI
  const roiSums   = new Float64Array(ROIS.length); // activation sum scratch
  const roiMeans  = new Float32Array(ROIS.length); // computed mean per frame

  // Three.js objects (one entry per ROI / edge)
  const nodeDiscs = []; // THREE.Mesh  — filled circle
  const nodeGlows = []; // THREE.Sprite — additive soft glow
  const edgeObjs  = []; // { line: THREE.Line, mat, a, b }

  // ── Build vertex→ROI lookup (O(total_verts), called once at init) ─────────
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

  // ── World → canvas-pixel helper (for label overlay) ───────────────────────
  // World x∈[-200,200] → px x∈[0,CW],  world y∈[-140,140] → px y∈[CH,0]
  function w2px(wx, wy) {
    return {
      x: (wx + CAM_HW) / (CAM_HW * 2) * CW,
      y: (CAM_HH - wy) / (CAM_HH * 2) * CH,
    };
  }

  // ── init ──────────────────────────────────────────────────────────────────
  function init() {
    buildVertexIndex();

    // ── Panel container ───────────────────────────────────────────────────
    panel = document.createElement('div');
    Object.assign(panel.style, {
      position:       'fixed',
      bottom:         '0',
      right:          '0',
      width:          W + 'px',
      height:         H + 'px',
      background:     'rgba(8,8,8,0.88)',
      backdropFilter: 'blur(8px)',
      border:         '1px solid #282828',
      borderBottom:   'none',
      borderRight:    'none',
      display:        'none',
      zIndex:         '50',
    });

    // Header strip
    const hdr = document.createElement('div');
    Object.assign(hdr.style, {
      fontFamily:    "'JetBrains Mono','Roboto Mono',monospace",
      fontSize:      '7.5px',
      letterSpacing: '0.18em',
      color:         '#404040',
      textTransform: 'uppercase',
      padding:       '5px 10px 4px',
      borderBottom:  '1px solid #1a1a1a',
      userSelect:    'none',
    });
    hdr.textContent = 'CONN\u00b7GRAPH  \u00b7  DK\u2011PARCEL  \u00b7  FSAVG5  \u00b7  20 ROI';
    panel.appendChild(hdr);

    // Three.js canvas (WebGL)
    canvas2 = document.createElement('canvas');
    canvas2.width  = CW;
    canvas2.height = CH;
    Object.assign(canvas2.style, {
      display:  'block',
      position: 'absolute',
      top:      HDR + 'px',
      left:     '0',
    });
    panel.appendChild(canvas2);

    // Label overlay (Canvas 2D — crisp text, pointer-events none)
    lblCanvas = document.createElement('canvas');
    lblCanvas.width  = CW;
    lblCanvas.height = CH;
    Object.assign(lblCanvas.style, {
      display:        'block',
      position:       'absolute',
      top:            HDR + 'px',
      left:           '0',
      pointerEvents:  'none',
    });
    panel.appendChild(lblCanvas);
    document.body.appendChild(panel);

    // ── Three.js renderer ─────────────────────────────────────────────────
    renderer2 = new THREE.WebGLRenderer({ canvas: canvas2, alpha: true, antialias: true });
    renderer2.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer2.setSize(CW, CH);
    renderer2.setClearColor(0x000000, 0);

    // Orthographic camera — world unit = 1 px
    camera2 = new THREE.OrthographicCamera(
      -CAM_HW, CAM_HW,   // left, right
       CAM_HH, -CAM_HH,  // top, bottom
      0, 100
    );
    camera2.position.z = 10;

    scene2 = new THREE.Scene();

    const glowTex  = makeGlowTex();
    const discGeo  = new THREE.CircleGeometry(1, 28); // unit circle, reused

    // ── Node objects ──────────────────────────────────────────────────────
    for (let i = 0; i < ROIS.length; i++) {
      const { x, y, r } = ROIS[i];

      // Glow sprite (behind disc, additive)
      const glowMat = new THREE.SpriteMaterial({
        map:      glowTex,
        transparent: true,
        blending: THREE.AdditiveBlending,
        opacity:  0.4,
      });
      const glow = new THREE.Sprite(glowMat);
      glow.position.set(x, y, 0);
      glow.scale.setScalar(r * 3.5);
      scene2.add(glow);
      nodeGlows.push(glow);

      // Filled disc (on top of glow)
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

    // ── Edge objects (one THREE.Line per edge → individual opacity) ───────
    for (const [a, b] of EDGES) {
      const pos = new Float32Array([
        ROIS[a].x, ROIS[a].y, 0.3,
        ROIS[b].x, ROIS[b].y, 0.3,
      ]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat  = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.1 });
      const line = new THREE.Line(geo, mat);
      scene2.add(line);
      edgeObjs.push({ line, mat, a, b });
    }

    drawLabels();
  }

  // ── Draw static node labels on Canvas 2D overlay ─────────────────────────
  function drawLabels() {
    const ctx = lblCanvas.getContext('2d');
    ctx.clearRect(0, 0, CW, CH);
    ctx.font         = '9px "JetBrains Mono", "Roboto Mono", monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    for (const roi of ROIS) {
      const { x, y } = w2px(roi.x, roi.y);
      ctx.fillStyle = 'rgba(90,90,90,0.85)';
      ctx.fillText(roi.name, x, y + roi.r + 3);
    }
  }

  // ── update — call each frame with raw vertex activations ──────────────────
  // Target: < 2 ms.  The hot loop is O(N_VERTS) = 20 484 iterations.
  function update(activations) {
    if (!renderer2 || !visible) return;

    // 1. Aggregate: mean activation per ROI ─────────────────────────────────
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
    const range   = maxA - minA || 1;
    const maxAbsA = Math.max(Math.abs(minA), Math.abs(maxA)) || 1;

    // 2. Update nodes ────────────────────────────────────────────────────────
    const fn = (typeof Colormaps !== 'undefined' && Colormaps[colormap])
               || ((t) => [t, t, t]);   // greyscale fallback

    for (let i = 0; i < ROIS.length; i++) {
      const t       = (roiMeans[i] - minA) / range;   // 0–1 normalised
      const absNorm = Math.abs(roiMeans[i]) / maxAbsA; // 0–1 magnitude

      const [r, g, b] = fn(t);
      const sc = ROIS[i].r * (1.0 + absNorm * 2.2);  // swell with activation

      nodeDiscs[i].material.color.setRGB(r, g, b);
      nodeDiscs[i].scale.setScalar(sc);

      nodeGlows[i].material.color.setRGB(r, g, b);
      nodeGlows[i].scale.setScalar(sc * 3.4);
      nodeGlows[i].material.opacity = 0.08 + absNorm * 0.72;
    }

    // 3. Update edges: opacity = joint activation product ───────────────────
    for (const { mat, a, b } of edgeObjs) {
      const actA = Math.abs(roiMeans[a]) / maxAbsA;
      const actB = Math.abs(roiMeans[b]) / maxAbsA;
      mat.opacity = 0.03 + actA * actB * 0.82;
    }

    // 4. Render ──────────────────────────────────────────────────────────────
    renderer2.render(scene2, camera2);
  }

  // ── toggle ────────────────────────────────────────────────────────────────
  function toggle() {
    visible = !visible;
    panel.style.display = visible ? 'block' : 'none';
    if (visible) {
      // Paint a neutral frame immediately (zeros = all-grey baseline)
      update(new Float32Array(N_VERTS));
    }
    return visible;
  }

  // ── setColormap ───────────────────────────────────────────────────────────
  function setColormap(name) {
    colormap = name;
  }

  return { init, update, setColormap, toggle };
})();
