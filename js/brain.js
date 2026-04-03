/**
 * brain.js
 * Parses fsaverage5.obj manually to create an indexed Three.js BufferGeometry
 * so that vertex colors map 1:1 with TRIBE v2 activation values (~20484 vertices).
 *
 * Public API:
 *   BrainRenderer.init(canvasEl)
 *   BrainRenderer.setActivations(arr, colormapName)
 *   BrainRenderer.onReady(fn)   — called with nVertices when mesh is loaded
 */

const BrainRenderer = (() => {
  let renderer, scene, camera, controls, brainMesh;
  let _onReadyCb = null;
  let meshLoaded = false;
  let nVertices = 0;

  function init(canvas) {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    resize();

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x03030a);

    camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
    camera.position.set(0, 0, 180);

    const ambient = new THREE.AmbientLight(0xffffff, 0.35);
    scene.add(ambient);
    const dir1 = new THREE.DirectionalLight(0xffffff, 0.7);
    dir1.position.set(1, 1, 1);
    scene.add(dir1);
    const dir2 = new THREE.DirectionalLight(0x8888ff, 0.2);
    dir2.position.set(-1, -0.5, -1);
    scene.add(dir2);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 80;
    controls.maxDistance = 400;

    loadMesh();
    window.addEventListener('resize', resize);

    (function animate() {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    })();
  }

  function loadMesh() {
    fetch('assets/fsaverage5.obj')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then(parseOBJ)
      .catch(err => console.error('Brain mesh load error:', err));
  }

  function parseOBJ(text) {
    const posArr = [];   // flat: x,y,z,...
    const idxArr = [];   // flat: a,b,c,...

    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('v ')) {
        const parts = line.split(/\s+/);
        posArr.push(+parts[1], +parts[2], +parts[3]);
      } else if (line.startsWith('f ')) {
        const parts = line.split(/\s+/);
        // OBJ faces are 1-indexed; support "v", "v/vt", "v/vt/vn" formats
        idxArr.push(
          parseInt(parts[1]) - 1,
          parseInt(parts[2]) - 1,
          parseInt(parts[3]) - 1
        );
      }
    }

    nVertices = posArr.length / 3;
    console.log(`Brain mesh: ${nVertices} vertices, ${idxArr.length / 3} faces`);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    geo.setIndex(idxArr);
    geo.computeVertexNormals();

    // Default grey vertex colors
    const colors = new Float32Array(nVertices * 3).fill(0.3);
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    // Center mesh
    geo.computeBoundingBox();
    const center = new THREE.Vector3();
    geo.boundingBox.getCenter(center);
    geo.translate(-center.x, -center.y, -center.z);

    const mat = new THREE.MeshPhongMaterial({
      vertexColors: true,
      shininess: 20,
      specular: new THREE.Color(0x111111),
    });

    brainMesh = new THREE.Mesh(geo, mat);
    scene.add(brainMesh);
    meshLoaded = true;
    if (_onReadyCb) _onReadyCb(nVertices);
  }

  function resize() {
    if (!renderer) return;
    const canvas = renderer.domElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    if (camera) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  /**
   * Update vertex colors from activation array.
   * activations.length should equal nVertices (~20484).
   */
  function setActivations(activations, colormapName = 'rdbu') {
    if (!meshLoaded || !brainMesh) return;

    const colorAttr = brainMesh.geometry.attributes.color;
    const n = colorAttr.count; // = nVertices

    // Pad or trim to match vertex count
    let src = activations;
    if (src.length < n) {
      src = [...src, ...new Array(n - src.length).fill(0)];
    }

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
