/**
 * colormap.js
 * Maps a normalized float [0, 1] → [r, g, b] in [0, 1] range.
 * Also provides a function to map a raw activation array → normalized colors.
 */

const Colormaps = {
  // Blue → White → Red  (diverging, good for fMRI activations)
  rdbu: (t) => {
    if (t < 0.5) {
      const s = t * 2;          // 0→1
      return [s, s, 1.0];       // blue → white
    } else {
      const s = (t - 0.5) * 2; // 0→1
      return [1.0, 1.0 - s, 1.0 - s]; // white → red
    }
  },

  // Black → Red → Yellow → White
  hot: (t) => {
    const r = Math.min(1, t * 3);
    const g = Math.min(1, Math.max(0, t * 3 - 1));
    const b = Math.min(1, Math.max(0, t * 3 - 2));
    return [r, g, b];
  },

  // Viridis approximation (blue-green-yellow)
  viridis: (t) => {
    // 5-stop approximation
    const stops = [
      [0.267, 0.005, 0.329],
      [0.128, 0.566, 0.551],
      [0.369, 0.788, 0.383],
      [0.993, 0.906, 0.144],
    ];
    const seg = t * (stops.length - 1);
    const i = Math.min(Math.floor(seg), stops.length - 2);
    const f = seg - i;
    return stops[i].map((v, j) => v + (stops[i + 1][j] - v) * f);
  },
};

/**
 * Convert a raw activation array into a Float32Array of RGB vertex colors.
 * @param {number[]} activations  — raw float values (can be negative)
 * @param {string}   colormapName — key in Colormaps
 * @returns {Float32Array}         — interleaved RGB, length = activations.length * 3
 */
function activationsToColors(activations, colormapName = 'rdbu') {
  const fn = Colormaps[colormapName] || Colormaps.rdbu;
  const n = activations.length;

  // Normalize to [0, 1] across this frame
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < n; i++) {
    if (activations[i] < min) min = activations[i];
    if (activations[i] > max) max = activations[i];
  }
  const range = max - min || 1;

  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = (activations[i] - min) / range;
    const [r, g, b] = fn(t);
    colors[i * 3]     = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  return colors;
}

/**
 * Draw a horizontal colorbar gradient into a canvas element.
 */
function drawColorbar(canvas, colormapName = 'rdbu') {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const fn = Colormaps[colormapName] || Colormaps.rdbu;
  for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x / (w - 1));
    ctx.fillStyle = `rgb(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)})`;
    ctx.fillRect(x, 0, 1, h);
  }
}
