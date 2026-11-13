// Draws the molecular surface mesh with WebGL, lit the way ChimeraX lights a surface: smooth
// per-pixel shading from a key light, a fill light and ambient light with a specular highlight
// ("default"), or mostly ambient light shaded by ambient occlusion with a little key light and no
// highlight ("gentle"). Depth cueing fades only the back half toward the background, so the front
// stays crisp. The projection matches the 2D renderer (same rotation, perspective, pan and zoom),
// so the result is drawn straight into the ribbon canvas.

const VS = `
attribute vec3 a_pos; attribute vec3 a_nrm; attribute vec3 a_col; attribute float a_ao;
uniform mat3 u_rot; uniform float u_kz, u_kpx, u_R; uniform vec2 u_pan, u_O, u_size;
varying vec3 v_n, v_col, v_view; varying float v_ao, v_dt;
void main() {
  vec3 v = u_rot * a_pos;
  float sc = 1.0 / max(0.3, 1.0 - u_kz * v.z);
  vec2 s = u_O + vec2(v.x * sc + u_pan.x, -(v.y * sc + u_pan.y)) * u_kpx;   // device px, y down
  gl_Position = vec4(s.x / u_size.x * 2.0 - 1.0, 1.0 - s.y / u_size.y * 2.0, clamp(-v.z / (3.0 * u_R), -1.0, 1.0), 1.0);
  v_n = u_rot * a_nrm; v_col = a_col; v_ao = a_ao;
  v_dt = clamp((v.z + u_R) / (2.0 * u_R), 0.0, 1.0);                         // 0 at the back, 1 at the front
  v_view = u_kz > 0.0 ? vec3(0.0, 0.0, 1.0 / u_kz) - v : vec3(0.0, 0.0, 1.0);
}`;

const FS = `
precision mediump float;
uniform vec3 u_key, u_fill, u_bg; uniform float u_gentle, u_fog;
varying vec3 v_n, v_col, v_view; varying float v_ao, v_dt;
void main() {
  vec3 n = normalize(v_n);
  if (!gl_FrontFacing) n = -n;
  if (dot(n, v_view) < 0.0) n = -n;                       // two-sided, always facing the viewer
  float key = max(dot(n, u_key), 0.0), fill = max(dot(n, u_fill), 0.0);
  vec3 h = normalize(u_key + normalize(v_view));
  vec3 c;
  if (u_gentle > 0.5) {
    float amb = 0.25 + 0.95 * v_ao;
    c = v_col * (0.82 * amb + 0.22 * key);
  } else {
    float spec = pow(max(dot(n, h), 0.0), 30.0);
    c = v_col * (0.38 + 0.68 * key + 0.24 * fill) + vec3(0.28 * spec);
  }
  float fog = clamp((0.5 - v_dt) / 0.5, 0.0, 1.0) * u_fog;   // ChimeraX-style: back half only
  gl_FragColor = vec4(mix(c, u_bg, fog), 1.0);
}`;

export function createSurfaceGL() {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
  if (!gl) return null;
  const uintIdx = !!gl.getExtension("OES_element_index_uint");
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const A = name => gl.getAttribLocation(prog, name), U = name => gl.getUniformLocation(prog, name);
  const buf = { pos: gl.createBuffer(), nrm: gl.createBuffer(), col: gl.createBuffer(), ao: gl.createBuffer(), idx: gl.createBuffer() };
  let mesh = null, count = 0, idxType = gl.UNSIGNED_SHORT;

  function setMesh(m) {
    mesh = m;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.pos); gl.bufferData(gl.ARRAY_BUFFER, m.P, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.nrm); gl.bufferData(gl.ARRAY_BUFFER, m.N, gl.STATIC_DRAW);
    setAO(null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.idx);
    if (m.nv > 65535 && !uintIdx) {   // no 32-bit indices: draw what fits rather than nothing
      const keep = []; for (let t = 0; t < m.nt; t++) if (m.T[t * 3] < 65535 && m.T[t * 3 + 1] < 65535 && m.T[t * 3 + 2] < 65535) keep.push(m.T[t * 3], m.T[t * 3 + 1], m.T[t * 3 + 2]);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, Uint16Array.from(keep), gl.STATIC_DRAW); count = keep.length; idxType = gl.UNSIGNED_SHORT;
    } else if (m.nv > 65535) { gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.T, gl.STATIC_DRAW); count = m.T.length; idxType = gl.UNSIGNED_INT; }
    else { gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, Uint16Array.from(m.T), gl.STATIC_DRAW); count = m.T.length; idxType = gl.UNSIGNED_SHORT; }
  }
  function setColours(rgb) {   // Uint8Array, 3 per vertex
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.col); gl.bufferData(gl.ARRAY_BUFFER, rgb, gl.STATIC_DRAW);
  }
  function setAO(ao) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.ao); gl.bufferData(gl.ARRAY_BUFFER, ao || new Float32Array(mesh.nv).fill(1), gl.STATIC_DRAW);
  }

  // p: { W, H, rot (3×3 column-major), kz, kpx, R, pan: [x, y], O: [x, y], key, fill (unit vectors, view space), bg [r, g, b] 0–1, gentle, fog }
  function render(p) {
    if (canvas.width !== p.W || canvas.height !== p.H) { canvas.width = p.W; canvas.height = p.H; }
    gl.viewport(0, 0, p.W, p.H);
    gl.clearColor(0, 0, 0, 0); gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!mesh || !count) return canvas;
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.CULL_FACE);
    gl.useProgram(prog);
    const attr = (name, b, size, type, normalized) => { const l = A(name); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, type, normalized, 0, 0); };
    attr("a_pos", buf.pos, 3, gl.FLOAT, false); attr("a_nrm", buf.nrm, 3, gl.FLOAT, false);
    attr("a_col", buf.col, 3, gl.UNSIGNED_BYTE, true); attr("a_ao", buf.ao, 1, gl.FLOAT, false);
    gl.uniformMatrix3fv(U("u_rot"), false, p.rot);
    gl.uniform1f(U("u_kz"), p.kz); gl.uniform1f(U("u_kpx"), p.kpx); gl.uniform1f(U("u_R"), p.R);
    gl.uniform2fv(U("u_pan"), p.pan); gl.uniform2fv(U("u_O"), p.O); gl.uniform2f(U("u_size"), p.W, p.H);
    gl.uniform3fv(U("u_key"), p.key); gl.uniform3fv(U("u_fill"), p.fill); gl.uniform3fv(U("u_bg"), p.bg);
    gl.uniform1f(U("u_gentle"), p.gentle ? 1 : 0); gl.uniform1f(U("u_fog"), p.fog);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.idx);
    gl.drawElements(gl.TRIANGLES, count, idxType, 0);
    return canvas;
  }
  return { canvas, setMesh, setColours, setAO, render, get mesh() { return mesh; } };
}
