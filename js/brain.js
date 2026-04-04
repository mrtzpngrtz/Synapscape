/**
 * brain.js  — 4-viewport brain renderer
 *
 * Views:  ANTERIOR · POSTERIOR · L·LATERAL · R·LATERAL
 * Input:  drag anywhere to rotate the brain mesh (with inertia)
 *
 * Public API (unchanged):
 *   BrainRenderer.init(canvasEl)
 *   BrainRenderer.setActivations(arr, colormapName)
 *   BrainRenderer.onReady(fn)
 */

const BrainRenderer = (() => {
  let renderer, scene, brainMesh;
  let _onReadyCb = null;
  let meshLoaded  = false;
  let nVertices   = 0;

  // ── 4 fixed cameras — brain mesh rotates, cameras stay still ─────────────
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

    // — Lighting: key + cool fill + under-fill + warm top-rear —
    scene.add(new THREE.AmbientLight(0xffffff, 0.30));
    const addDir = (hex, intensity, x, y, z) => {
      const l = new THREE.DirectionalLight(hex, intensity);
      l.position.set(x, y, z);
      scene.add(l);
    };
    addDir(0xffffff, 1.1,   1,  1,  1);   // key
    addDir(0x99aaff, 0.45, -1,  0.5, -1); // cool fill
    addDir(0xffffff, 0.30,  0, -1,  0);   // under
    addDir(0xffeecc, 0.20,  0,  1, -1);   // warm rear

    // — Drag interaction —
    const startDrag = (x, y) => {
      isDragging = true;
      lastMouse  = { x, y };
      velX = velY = 0;
    };
    const moveDrag = (x, y) => {
      if (!isDragging || !brainMesh) return;
      const dx = x - lastMouse.x;
      const dy = y - lastMouse.y;
      lastMouse = { x, y };
      const s = 0.006;
      brainMesh.rotation.y += dx * s;
      brainMesh.rotation.x += dy * s;
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
      // Inertia
      if (!isDragging && brainMesh) {
        brainMesh.rotation.y += velX;
        brainMesh.rotation.x += velY;
        velX *= 0.90;
        velY *= 0.90;
      }
      renderViewports();
    })();
  }

  // ── Render 4 viewports on one canvas ─────────────────────────────────────
  // Three.js r128 setViewport/setScissor take CSS-pixel values (internally × pixelRatio).
  // WebGL y=0 is the BOTTOM of the canvas, so top-row quads have y = ch/2.
  function renderViewports() {
    const cw = renderer.domElement.clientWidth;
    const ch = renderer.domElement.clientHeight;
    const hw = cw / 2;
    const hh = ch / 2;

    //              left  bottom  w    h        → screen position
    const vps = [
      [0,   hh, hw, hh], // top-left  → ANTERIOR
      [hw,  hh, hw, hh], // top-right → POSTERIOR
      [0,   0,  hw, hh], // bot-left  → L · LATERAL
      [hw,  0,  hw, hh], // bot-right → R · LATERAL
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

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    geo.setIndex(idxArr);
    geo.computeVertexNormals();          // smooth shading
    geo.normalizeNormals();

    // Default flat-grey vertex colours
    const colors = new Float32Array(nVertices * 3).fill(0.32);
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    // Centre mesh on origin
    geo.computeBoundingBox();
    const center = new THREE.Vector3();
    geo.boundingBox.getCenter(center);
    geo.translate(-center.x, -center.y, -center.z);

    // PBR material — much smoother/richer than MeshPhong
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness:    0.68,
      metalness:    0.04,
    });

    brainMesh = new THREE.Mesh(geo, mat);
    // Tilt slightly forward for a nicer default angle
    brainMesh.rotation.x = 0.18;
    scene.add(brainMesh);
    meshLoaded = true;
    if (_onReadyCb) _onReadyCb(nVertices);
  }

  // ── Resize handler ───────────────────────────────────────────────────────
  function resize() {
    if (!renderer) return;
    const canvas = renderer.domElement;
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  }

  // ── Public: update vertex colours from activation array ──────────────────
  function setActivations(activations, colormapName = 'rdbu') {
    if (!meshLoaded || !brainMesh) return;
    const colorAttr = brainMesh.geometry.attributes.color;
    const n = colorAttr.count;
    let src = activations;
    if (src.length < n) src = [...src, ...new Array(n - src.length).fill(0)];
    const colors = activationsToColors(src.slice(0, n), colormapName);
    colorAttr.array.set(colors);
    colorAttr.needsUpdate = true;
  }

  function onReady(fn) {
    _onReadyCb = fn;
    if (meshLoaded) fn(nVertices);
  }

  return { init, setActivations, onReady };
})();
