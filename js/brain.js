/**
 * brain.js  — 4-viewport brain renderer
 *
 * Views:  ANTERIOR · POSTERIOR · L·LATERAL · R·LATERAL
 * Input:  drag anywhere to rotate the brain mesh (with inertia)
 *
 * Modes:
 *   'mesh'      — PBR surface with vertex colour activation map
 *   'particles' — white glowing point cloud; activation magnitude → particle size
 *
 * Public API:
 *   BrainRenderer.init(canvasEl)
 *   BrainRenderer.setActivations(arr, colormapName)
 *   BrainRenderer.setMode('mesh' | 'particles')
 *   BrainRenderer.onReady(fn)
 */

const BrainRenderer = (() => {
  let renderer, scene;
  let brainMesh    = null;
  let particlesMesh = null;
  let brainGroup   = null;
  let _onReadyCb   = null;
  let meshLoaded   = false;
  let nVertices    = 0;

  let _prevActivations = null;
  let _blendAmount     = 0.5;
  let _zoom            = 1.0;
  let _fov             = 38;
  let _particleScale   = 1.0;
  let _singleView      = null;   // index into BASE_DIRS, or null for 4-up

  // ── Camera orbit state (Cinema 4D–style turntable) ───────────────────────
  // Horizontal drag = azimuth (around world Y).  Vertical drag = elevation.
  // Up vector is always (0,1,0) — no roll, no arcball weirdness.
  // Cameras orbit around the brain; brain never rotates.
  const DIST    = 220;
  // Base azimuth per viewport (radians, 0 = +Z front)
  const BASE_AZ = [0, Math.PI, -Math.PI / 2, Math.PI / 2]; // ANT · POST · L·LAT · R·LAT
  const ELEV_MAX = Math.PI * 0.48;   // ~86 °, prevent pole flip
  const SENSE    = 0.007;            // radians per pixel  (≈ 0.4 °/px, like C4D)
  const DECAY    = 0.86;

  let azimuth   = 0;   // shared orbit offset applied to all cameras
  let elevation = 0;
  let velAz     = 0;   // inertia velocities
  let velEl     = 0;
  const cameras = [];

  // ── Drag state ────────────────────────────────────────────────────────────
  let isDragging = false;
  let lastMouse  = { x: 0, y: 0 };

  // ── Particle shader ───────────────────────────────────────────────────────
  const PARTICLE_VERT = `
    attribute float aSize;
    varying   float vSize;
    void main() {
      vSize = aSize;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * (280.0 / -mv.z);
      gl_Position  = projectionMatrix * mv;
    }
  `;
  const PARTICLE_FRAG = `
    varying float vSize;
    void main() {
      vec2  uv = gl_PointCoord - 0.5;
      float d  = length(uv);
      if (d > 0.5) discard;
      // Gaussian-ish soft falloff
      float falloff    = 1.0 - smoothstep(0.0, 0.5, d);
      // Dim when small (resting), bright when large (active)
      float brightness = mix(0.25, 1.0, clamp((vSize - 1.0) / 5.5, 0.0, 1.0));
      gl_FragColor = vec4(1.0, 1.0, 1.0, falloff * brightness);
    }
  `;

  // ── init ──────────────────────────────────────────────────────────────────
  function init(canvas) {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setScissorTest(true);
    resize();

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x080808);

    // — 4 cameras (positions set dynamically in renderViewports via orbitQ) —
    for (let i = 0; i < 4; i++) {
      cameras.push(new THREE.PerspectiveCamera(38, 1, 0.1, 900));
    }

    // — Lighting (used by mesh mode) —
    scene.add(new THREE.AmbientLight(0xffffff, 0.30));
    const addDir = (hex, intensity, x, y, z) => {
      const l = new THREE.DirectionalLight(hex, intensity);
      l.position.set(x, y, z);
      scene.add(l);
    };
    addDir(0xffffff, 1.1,   1,  1,  1);
    addDir(0x99aaff, 0.45, -1,  0.5, -1);
    addDir(0xffffff, 0.30,  0, -1,  0);
    addDir(0xffeecc, 0.20,  0,  1, -1);

    // — Cinema 4D–style orbit drag —
    const startDrag = (x, y) => {
      isDragging = true;
      lastMouse  = { x, y };
      velAz = velEl = 0;
    };
    const moveDrag = (x, y) => {
      if (!isDragging) return;
      const dx = x - lastMouse.x;
      const dy = y - lastMouse.y;
      velAz      = -dx * SENSE;
      velEl      =  dy * SENSE;
      azimuth   += velAz;
      elevation  = Math.max(-ELEV_MAX, Math.min(ELEV_MAX, elevation + velEl));
      lastMouse  = { x, y };
    };
    const endDrag = () => {
      isDragging = false;
      canvas.style.cursor = 'grab';
    };

    canvas.style.cursor = 'grab';
    canvas.addEventListener('mousedown',  e => { canvas.style.cursor = 'grabbing'; startDrag(e.clientX, e.clientY); });
    canvas.addEventListener('mousemove',  e => moveDrag(e.clientX, e.clientY));
    canvas.addEventListener('mouseup',    () => endDrag());
    canvas.addEventListener('mouseleave', () => endDrag());

    canvas.addEventListener('touchstart', e => {
      if (e.touches.length === 1) { e.preventDefault(); startDrag(e.touches[0].clientX, e.touches[0].clientY); }
    }, { passive: false });
    canvas.addEventListener('touchmove', e => {
      if (e.touches.length === 1) { e.preventDefault(); moveDrag(e.touches[0].clientX, e.touches[0].clientY); }
    }, { passive: false });
    canvas.addEventListener('touchend', () => endDrag());

    // — Scroll zoom (responds to trackpad magnitude) —
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0012);
      _zoom = Math.max(0.25, Math.min(4.0, _zoom * factor));
      if (brainGroup) brainGroup.scale.setScalar(_zoom);
    }, { passive: false });

    // — Double-click to reset view —
    canvas.addEventListener('dblclick', () => {
      _zoom = 1.0;
      azimuth = elevation = velAz = velEl = 0;
      if (brainGroup) brainGroup.scale.setScalar(1.0);
    });

    // — Pinch zoom —
    let _pinchDist = null;
    canvas.addEventListener('touchstart', e => {
      if (e.touches.length === 2)
        _pinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                                e.touches[0].clientY - e.touches[1].clientY);
    }, { passive: false });
    canvas.addEventListener('touchmove', e => {
      if (e.touches.length !== 2 || _pinchDist === null) return;
      e.preventDefault();
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                           e.touches[0].clientY - e.touches[1].clientY);
      _zoom *= d / _pinchDist;
      _zoom = Math.max(0.2, Math.min(4.0, _zoom));
      if (brainGroup) brainGroup.scale.setScalar(_zoom);
      _pinchDist = d;
    }, { passive: false });
    canvas.addEventListener('touchend', e => { if (e.touches.length < 2) _pinchDist = null; });

    loadMesh();
    window.addEventListener('resize', resize);

    (function animate() {
      requestAnimationFrame(animate);
      // Inertia — continues after release, decays to stop
      if (!isDragging && (Math.abs(velAz) > 0.00005 || Math.abs(velEl) > 0.00005)) {
        azimuth   += velAz;
        elevation  = Math.max(-ELEV_MAX, Math.min(ELEV_MAX, elevation + velEl));
        velAz     *= DECAY;
        velEl     *= DECAY;
      }
      renderViewports();
    })();
  }

  // ── Render 4 viewports on one canvas ─────────────────────────────────────
  function renderViewports() {
    const cw = renderer.domElement.clientWidth;
    const ch = renderer.domElement.clientHeight;

    // Position cameras via spherical coords — azimuth+elevation shared offset
    for (let i = 0; i < 4; i++) {
      const az = BASE_AZ[i] + azimuth;
      const el = elevation;
      cameras[i].position.set(
        Math.sin(az) * Math.cos(el) * DIST,
        Math.sin(el) * DIST,
        Math.cos(az) * Math.cos(el) * DIST
      );
      cameras[i].up.set(0, 1, 0);   // world up always — no roll
      cameras[i].lookAt(0, 0, 0);
    }

    // Single-view mode (used by Affect tab)
    if (_singleView !== null) {
      renderer.setViewport(0, 0, cw, ch);
      renderer.setScissor(0, 0, cw, ch);
      cameras[_singleView].aspect = cw / ch;
      cameras[_singleView].updateProjectionMatrix();
      renderer.render(scene, cameras[_singleView]);
      return;
    }

    const hw = cw / 2;
    const hh = ch / 2;

    const vps = [
      [0,   hh, hw, hh],
      [hw,  hh, hw, hh],
      [0,   0,  hw, hh],
      [hw,  0,  hw, hh],
    ];

    for (let i = 0; i < 4; i++) {
      const [vx, vy, vw, vh] = vps[i];
      renderer.setViewport(vx, vy, vw, vh);
      renderer.setScissor(vx, vy, vw, vh);
      cameras[i].aspect = vw / vh;
      cameras[i].updateProjectionMatrix();
      renderer.render(scene, cameras[i]);
    }
  }

  // ── Load & parse OBJ ─────────────────────────────────────────────────────
  function loadMesh() {
    fetch('assets/fsaverage5.obj')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
      .then(parseOBJ)
      .catch(err => console.error('Brain mesh load error:', err));
  }

  function parseOBJ(text) {
    const posArr = [];
    const idxArr = [];

    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('v ')) {
        const p = line.split(/\s+/);
        posArr.push(+p[1], +p[2], +p[3]);
      } else if (line.startsWith('f ')) {
        const p = line.split(/\s+/);
        idxArr.push(parseInt(p[1]) - 1, parseInt(p[2]) - 1, parseInt(p[3]) - 1);
      }
    }

    nVertices = posArr.length / 3;
    console.log(`Brain mesh: ${nVertices} vertices, ${idxArr.length / 3} faces`);

    // ── Shared geometry base ─────────────────────────────────────────────
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    geo.setIndex(idxArr);
    geo.computeVertexNormals();
    geo.normalizeNormals();

    // Centre on origin
    geo.computeBoundingBox();
    const center = new THREE.Vector3();
    geo.boundingBox.getCenter(center);
    geo.translate(-center.x, -center.y, -center.z);

    // ── Mesh mode ────────────────────────────────────────────────────────
    const colors = new Float32Array(nVertices * 3).fill(0.32);
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const meshMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness:    0.68,
      metalness:    0.04,
    });

    brainMesh = new THREE.Mesh(geo, meshMat);

    // ── Particle mode ────────────────────────────────────────────────────
    const pGeo = new THREE.BufferGeometry();
    // Clone positions (already centred via geo.translate in-place)
    pGeo.setAttribute('position', new THREE.Float32BufferAttribute(posArr.slice(), 3));

    // Translate particle positions by the same centre offset
    const pos = pGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(i, pos.getX(i) - center.x, pos.getY(i) - center.y, pos.getZ(i) - center.z);
    }
    pos.needsUpdate = true;

    const sizes = new Float32Array(nVertices).fill(1.5);
    pGeo.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));

    const pMat = new THREE.ShaderMaterial({
      vertexShader:   PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent:    true,
      depthWrite:     false,
      blending:       THREE.AdditiveBlending,
    });

    particlesMesh = new THREE.Points(pGeo, pMat);
    particlesMesh.visible = false; // mesh mode is default

    // ── Parent group — brain is fixed, cameras orbit ─────────────────────
    brainGroup = new THREE.Group();
    brainGroup.add(brainMesh);
    brainGroup.add(particlesMesh);
    scene.add(brainGroup);

    meshLoaded = true;
    if (_onReadyCb) _onReadyCb(nVertices);
  }

  // ── Resize handler ───────────────────────────────────────────────────────
  function resize() {
    if (!renderer) return;
    const canvas = renderer.domElement;
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  }

  // ── Public: switch between mesh and particle views ───────────────────────
  function setMode(m) {
    if (brainMesh)     brainMesh.visible     = (m === 'mesh');
    if (particlesMesh) particlesMesh.visible = (m === 'particles');
  }

  // ── Public: zoom (0.2 – 4.0) ─────────────────────────────────────────────
  function setZoom(v) {
    _zoom = Math.max(0.2, Math.min(4.0, v));
    if (brainGroup) brainGroup.scale.setScalar(_zoom);
  }

  // ── Public: field of view in degrees (10 – 90) ────────────────────────────
  function setFOV(deg) {
    _fov = Math.max(10, Math.min(90, deg));
    for (const cam of cameras) {
      cam.fov = _fov;
      cam.updateProjectionMatrix();
    }
  }

  // ── Public: set blend amount (0 = hard cut, 1 = full interpolation) ───────
  function setBlend(amount) {
    _blendAmount = Math.max(0, Math.min(1, amount));
  }

  function setParticleScale(v) {
    _particleScale = Math.max(0.3, Math.min(3.0, v));
  }

  // ── Public: update vertex colours (mesh) and particle sizes ──────────────
  function setActivations(activations, colormapName = 'rdbu') {
    if (!meshLoaded) return;

    const n = nVertices;
    let next = activations.length < n
      ? [...activations, ...new Array(n - activations.length).fill(0)]
      : activations.slice(0, n);

    // Blend with previous frame
    let src = next;
    if (_prevActivations && _blendAmount > 0) {
      src = new Array(n);
      const t = _blendAmount;
      for (let i = 0; i < n; i++) {
        src[i] = _prevActivations[i] * t + next[i] * (1 - t);
      }
    }
    _prevActivations = next;

    // — Mesh: vertex colour map —
    if (brainMesh) {
      const colorAttr = brainMesh.geometry.attributes.color;
      const colors = activationsToColors(src, colormapName);
      colorAttr.array.set(colors);
      colorAttr.needsUpdate = true;
    }

    // — Particles: size from absolute activation magnitude —
    if (particlesMesh) {
      const sizeAttr = particlesMesh.geometry.attributes.aSize;
      const BASE = 1.0, RANGE = 5.5;
      let maxAbs = 0;
      for (let i = 0; i < n; i++) {
        const a = Math.abs(src[i]);
        if (a > maxAbs) maxAbs = a;
      }
      if (maxAbs === 0) maxAbs = 1;
      for (let i = 0; i < n; i++) {
        sizeAttr.array[i] = (BASE + (Math.abs(src[i]) / maxAbs) * RANGE) * _particleScale;
      }
      sizeAttr.needsUpdate = true;
    }
  }

  function onReady(fn) {
    _onReadyCb = fn;
    if (meshLoaded) fn(nVertices);
  }

  // ── Single-viewport mode (index 2 = L·LATERAL for Affect tab) ────────────
  function setSingleView(idx) { _singleView = idx; }
  function clearSingleView()  { _singleView = null; }
  function getCamera(idx)     { return cameras[idx]; }

  // Add/remove objects from brainGroup so they follow drag rotation
  function addToBrainGroup(obj)      { if (brainGroup) brainGroup.add(obj); }
  function removeFromBrainGroup(obj) { if (brainGroup) brainGroup.remove(obj); }

  // ── Per-tab view state save / restore ─────────────────────────────────────
  function getViewState() {
    return { azimuth, elevation, zoom: _zoom };
  }

  function setViewState(state) {
    if (!state) return;
    velAz = velEl = 0;
    azimuth   = state.azimuth   ?? 0;
    elevation = state.elevation ?? 0;
    _zoom     = state.zoom      ?? 1.0;
    if (brainGroup) brainGroup.scale.setScalar(_zoom);
  }

  return { init, setActivations, setBlend, setZoom, setFOV, setMode, setParticleScale, onReady, setSingleView, clearSingleView, getCamera, addToBrainGroup, removeFromBrainGroup, getViewState, setViewState };
})();
