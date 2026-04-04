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
  let brainGroup   = null;   // parent of both — rotated by drag
  let _onReadyCb   = null;
  let meshLoaded   = false;
  let nVertices    = 0;
  let mode         = 'mesh';

  // ── 4 fixed cameras — brain group rotates, cameras stay still ─────────────
  const VIEWS = [
    { label: 'ANTERIOR',    pos: [   0, 0,  220], up: [0, 1, 0] },
    { label: 'POSTERIOR',   pos: [   0, 0, -220], up: [0, 1, 0] },
    { label: 'L · LATERAL', pos: [-220, 0,    0], up: [0, 1, 0] },
    { label: 'R · LATERAL', pos: [ 220, 0,    0], up: [0, 1, 0] },
  ];
  const cameras = [];

  // ── Drag / inertia state ──────────────────────────────────────────────────
  let isDragging = false;
  let lastMouse  = { x: 0, y: 0 };
  let velX = 0, velY = 0;

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
    scene.background = new THREE.Color(0x03030a);

    // — 4 cameras —
    for (const v of VIEWS) {
      const cam = new THREE.PerspectiveCamera(38, 1, 0.1, 900);
      cam.position.set(...v.pos);
      cam.up.set(...v.up);
      cam.lookAt(0, 0, 0);
      cameras.push(cam);
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

    // — Drag interaction —
    const startDrag = (x, y) => {
      isDragging = true;
      lastMouse  = { x, y };
      velX = velY = 0;
    };
    const moveDrag = (x, y) => {
      if (!isDragging || !brainGroup) return;
      const dx = x - lastMouse.x;
      const dy = y - lastMouse.y;
      lastMouse = { x, y };
      const s = 0.006;
      brainGroup.rotation.y += dx * s;
      brainGroup.rotation.x += dy * s;
      velX = dx * s;
      velY = dy * s;
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

    loadMesh();
    window.addEventListener('resize', resize);

    (function animate() {
      requestAnimationFrame(animate);
      if (!isDragging && brainGroup) {
        brainGroup.rotation.y += velX;
        brainGroup.rotation.x += velY;
        velX *= 0.90;
        velY *= 0.90;
      }
      renderViewports();
    })();
  }

  // ── Render 4 viewports on one canvas ─────────────────────────────────────
  function renderViewports() {
    const cw = renderer.domElement.clientWidth;
    const ch = renderer.domElement.clientHeight;
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

    // ── Parent group — both share rotation ───────────────────────────────
    brainGroup = new THREE.Group();
    brainGroup.rotation.x = 0.18; // slight forward tilt
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
    mode = m;
    if (brainMesh)     brainMesh.visible     = (m === 'mesh');
    if (particlesMesh) particlesMesh.visible = (m === 'particles');
  }

  // ── Public: update vertex colours (mesh) and particle sizes ──────────────
  function setActivations(activations, colormapName = 'rdbu') {
    if (!meshLoaded) return;

    const n = nVertices;
    let src = activations.length < n
      ? [...activations, ...new Array(n - activations.length).fill(0)]
      : activations;
    src = src.slice(0, n);

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
        sizeAttr.array[i] = BASE + (Math.abs(src[i]) / maxAbs) * RANGE;
      }
      sizeAttr.needsUpdate = true;
    }
  }

  function onReady(fn) {
    _onReadyCb = fn;
    if (meshLoaded) fn(nVertices);
  }

  return { init, setActivations, setMode, onReady };
})();
