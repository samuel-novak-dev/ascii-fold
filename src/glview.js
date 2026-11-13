// Draws the model with WebGL. The molecular surface is lit like ChimeraX's "lighting gentle":
// smooth per-pixel shading, mostly ambient light darkened by ambient occlusion, a little key
// light, no highlight, and depth cueing only in the back half. The cartoon keeps every helix and
// strand one even colour that darkens with distance from the camera along the line of sight
// (loops keep a touch of roundness); optionally a helix's outside turns (toward the side chains)
// are lightened and its inside (seen through the gaps) darkened. With WebGL2 it renders
// into an antialiased offscreen buffer, then outlines every depth jump, like ChimeraX's silhouettes.
// The projection matches the 2D renderer (same rotation, perspective, pan and zoom), so the result
// is drawn straight into the model canvas. A see-through surface ("glass") can go over the cartoon:
// only its front-most layer, lit like the surface, more opaque where it turns away (a rim), with
// a light outline, and hidden wherever the cartoon or a ligand comes out in front of it.

const VS = `
attribute vec3 a_pos; attribute vec3 a_nrm; attribute vec3 a_col; attribute float a_ao; attribute float a_band; attribute float a_face;
uniform mat3 u_rot; uniform float u_kz, u_kpx, u_R; uniform vec2 u_pan, u_O, u_size;
varying vec3 v_n, v_col, v_view; varying float v_ao, v_dt, v_dist, v_band, v_face;
void main() {
  vec3 v = u_rot * a_pos;
  float sc = 1.0 / max(0.3, 1.0 - u_kz * v.z);
  vec2 s = u_O + vec2(v.x * sc + u_pan.x, -(v.y * sc + u_pan.y)) * u_kpx;   // device px, y down
  gl_Position = vec4(s.x / u_size.x * 2.0 - 1.0, 1.0 - s.y / u_size.y * 2.0, clamp(-v.z / (3.0 * u_R), -1.0, 1.0), 1.0);
  v_n = u_rot * a_nrm; v_col = a_col; v_ao = a_ao;
  v_dt = clamp((v.z + u_R) / (2.0 * u_R), 0.0, 1.0);                         // 0 at the back, 1 at the front
  v_view = u_kz > 0.0 ? vec3(0.0, 0.0, 1.0 / u_kz) - v : vec3(0.0, 0.0, 1.0);
  v_dist = u_kz > 0.0 ? length(v_view) : -v.z;   // distance to the camera (orthographic: depth)
  v_band = a_band; v_face = a_face;
}`;

const FS = `
precision mediump float;
uniform vec3 u_key, u_bg; uniform float u_fog, u_mode, u_depth, u_faces, u_alpha; uniform vec2 u_drange;
varying vec3 v_n, v_col, v_view; varying float v_ao, v_dt, v_dist, v_band, v_face;
void main() {
  vec3 n = normalize(v_n);
  float facing = dot(n, v_view);                           // the mesh's own normal: > 0 when its front faces us
  if (facing < 0.0) n = -n;                                // two-sided, always facing the viewer
  float key = max(dot(n, u_key), 0.0);
  if (u_mode > 0.5) {   // cartoon: even colour per element, darker further from the camera
    // 0 at the model's front-most point in this view, 1 at its back-most: the front stays full colour
    float dc = clamp((v_dist - u_drange.x) / max(1e-3, u_drange.y - u_drange.x), 0.0, 1.0);
    vec3 c = v_col * (1.0 - u_depth * dc) * mix(0.8 + 0.2 * key, 1.0, v_band);
    if (u_faces > 0.5 && v_face != 0.0) c = v_face * facing >= 0.0 ? mix(c, vec3(1.0), 0.16) : c * 0.58;   // helix outside / inside
    gl_FragColor = vec4(c, 1.0);
    return;
  }
  vec3 c = v_col * (0.82 * (0.25 + 0.95 * v_ao) + 0.22 * key);
  float fog = clamp((0.5 - v_dt) / 0.5, 0.0, 1.0) * u_fog;   // ChimeraX-style: back half only
  c = mix(c, u_bg, fog);
  if (u_alpha < 1.0) {   // glass: premultiplied, more opaque at grazing angles
    float a = u_alpha + (1.0 - u_alpha) * 0.55 * pow(1.0 - abs(dot(n, normalize(v_view))), 3.0);
    gl_FragColor = vec4(c * a, a);
    return;
  }
  gl_FragColor = vec4(c, 1.0);
}`;

// silhouettes: a pixel turns ink where a neighbour about u_w px away is nearer by more than u_thr
const EDGE_VS = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
const EDGE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_col, u_dep; uniform vec2 u_px; uniform float u_thr, u_w; uniform vec3 u_ink;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy * u_px;
  vec4 c = texture(u_col, uv);
  float d = texture(u_dep, uv).r, near = 0.0;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5235988;
    near = max(near, d - texture(u_dep, uv + vec2(cos(a), sin(a)) * u_w * u_px).r);
  }
  float k = smoothstep(u_thr, 2.0 * u_thr, near);
  o = c.a < 0.5 ? vec4(u_ink * k, k) : vec4(mix(c.rgb, u_ink, 0.85 * k), 1.0);
}`;

// glass over the canvas: its (premultiplied) colour, with a light outline from its depth
const GLASS_FS = `#version 300 es
precision highp float;
uniform sampler2D u_col, u_dep; uniform vec2 u_px; uniform float u_thr, u_w; uniform vec3 u_ink;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy * u_px;
  vec4 c = texture(u_col, uv);
  float d = texture(u_dep, uv).r, near = 0.0;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5235988;
    near = max(near, d - texture(u_dep, uv + vec2(cos(a), sin(a)) * u_w * u_px).r);
  }
  float e = 0.45 * smoothstep(u_thr, 2.0 * u_thr, near);
  o = c * (1.0 - e) + vec4(u_ink * e, e);
}`;

export function createGLView() {
  const canvas = document.createElement("canvas");
  let gl = canvas.getContext("webgl2", { antialias: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
  const gl2 = !!gl;
  if (!gl) gl = canvas.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
  if (!gl) return null;
  const uintIdx = gl2 || !!gl.getExtension("OES_element_index_uint");
  const compile = (vs, fs) => {
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  };
  const prog = compile(VS, FS), edge = gl2 ? compile(EDGE_VS, EDGE_FS) : null, glassComp = gl2 ? compile(EDGE_VS, GLASS_FS) : null;
  const A = name => gl.getAttribLocation(prog, name), U = (p, name) => gl.getUniformLocation(p, name);

  // one set of buffers per mesh slot ("cartoon", "surface"), so switching doesn't re-upload
  const slots = {};
  const slot = name => slots[name] || (slots[name] = { pos: gl.createBuffer(), nrm: gl.createBuffer(), col: gl.createBuffer(), ao: gl.createBuffer(), band: gl.createBuffer(), face: gl.createBuffer(),
                                                        idx: gl.createBuffer(), mesh: null, count: 0, idxType: gl.UNSIGNED_SHORT });
  function setMesh(name, m) {
    const s = slot(name); s.mesh = m;
    gl.bindBuffer(gl.ARRAY_BUFFER, s.pos); gl.bufferData(gl.ARRAY_BUFFER, m.P, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, s.nrm); gl.bufferData(gl.ARRAY_BUFFER, m.N, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, s.band); gl.bufferData(gl.ARRAY_BUFFER, m.band || new Float32Array(m.nv), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, s.face); gl.bufferData(gl.ARRAY_BUFFER, m.face || new Float32Array(m.nv), gl.STATIC_DRAW);
    setAO(name, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s.idx);
    if (m.nv > 65535 && !uintIdx) {   // no 32-bit indices: draw what fits rather than nothing
      const keep = []; for (let t = 0; t < m.nt; t++) if (m.T[t * 3] < 65535 && m.T[t * 3 + 1] < 65535 && m.T[t * 3 + 2] < 65535) keep.push(m.T[t * 3], m.T[t * 3 + 1], m.T[t * 3 + 2]);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, Uint16Array.from(keep), gl.STATIC_DRAW); s.count = keep.length; s.idxType = gl.UNSIGNED_SHORT;
    } else if (m.nv > 65535) { gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.T, gl.STATIC_DRAW); s.count = m.T.length; s.idxType = gl.UNSIGNED_INT; }
    else { gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, Uint16Array.from(m.T), gl.STATIC_DRAW); s.count = m.T.length; s.idxType = gl.UNSIGNED_SHORT; }
  }
  function setColours(name, rgb) { const s = slot(name); gl.bindBuffer(gl.ARRAY_BUFFER, s.col); gl.bufferData(gl.ARRAY_BUFFER, rgb, gl.STATIC_DRAW); }
  function setAO(name, ao) { const s = slot(name); gl.bindBuffer(gl.ARRAY_BUFFER, s.ao); gl.bufferData(gl.ARRAY_BUFFER, ao || new Float32Array(s.mesh.nv).fill(1), gl.STATIC_DRAW); }

  // WebGL2: draw into a multisampled buffer, resolve colour and depth into textures, then outline
  let fb = null;
  function buffers(W, H) {
    if (fb && fb.W === W && fb.H === H) return fb;
    if (fb) { gl.deleteFramebuffer(fb.ms); gl.deleteFramebuffer(fb.rs); gl.deleteRenderbuffer(fb.msC); gl.deleteRenderbuffer(fb.msD); gl.deleteTexture(fb.col); gl.deleteTexture(fb.dep); }
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES));
    const rb = fmt => { const r = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, r); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, fmt, W, H); return r; };
    const tex = (ifmt, fmt, type) => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, W, H, 0, fmt, type, null);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      return t; };
    const msC = rb(gl.RGBA8), msD = rb(gl.DEPTH_COMPONENT24), ms = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, ms);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, msC);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, msD);
    const col = tex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE), dep = tex(gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT), rs = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, rs);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, col, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, dep, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fb = { W, H, ms, rs, msC, msD, col, dep };
  }

  // p: { W, H, rot (3×3 column-major), kz, kpx, R, pan, O, key (view space), bg [r, g, b] 0–1, fog, ink [r, g, b] 0–1,
  //      edge: px or 0, mode: 0 lit surface, 1 depth-shaded cartoon, depth: darkening at the back 0–1, faces: bool,
  //      drange: [nearest, farthest] camera distance of the model in this view,
  //      glass: a slot drawn see-through over the rest (lit as a surface), glassAlpha: its opacity 0–1 }
  function uniforms(p, mode, alpha, fog) {
    gl.useProgram(prog);
    gl.uniformMatrix3fv(U(prog, "u_rot"), false, p.rot);
    gl.uniform1f(U(prog, "u_kz"), p.kz); gl.uniform1f(U(prog, "u_kpx"), p.kpx); gl.uniform1f(U(prog, "u_R"), p.R);
    gl.uniform2fv(U(prog, "u_pan"), p.pan); gl.uniform2fv(U(prog, "u_O"), p.O); gl.uniform2f(U(prog, "u_size"), p.W, p.H);
    gl.uniform3fv(U(prog, "u_key"), p.key); gl.uniform3fv(U(prog, "u_bg"), p.bg); gl.uniform1f(U(prog, "u_fog"), fog); gl.uniform1f(U(prog, "u_mode"), mode);
    gl.uniform1f(U(prog, "u_depth"), p.depth ?? 0.55); gl.uniform1f(U(prog, "u_faces"), p.faces ? 1 : 0);
    gl.uniform2fv(U(prog, "u_drange"), p.drange || [0, 1]); gl.uniform1f(U(prog, "u_alpha"), alpha);
  }
  const ATTRS = ["a_pos", "a_nrm", "a_col", "a_ao", "a_band", "a_face"];
  function draw(list) {
    const attr = (an, b, size, type, normalized) => { const l = A(an); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, type, normalized, 0, 0); };
    for (const s of list) {
      attr("a_pos", s.pos, 3, gl.FLOAT, false); attr("a_nrm", s.nrm, 3, gl.FLOAT, false);
      attr("a_col", s.col, 3, gl.UNSIGNED_BYTE, true); attr("a_ao", s.ao, 1, gl.FLOAT, false); attr("a_band", s.band, 1, gl.FLOAT, false); attr("a_face", s.face, 1, gl.FLOAT, false);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s.idx);
      gl.drawElements(gl.TRIANGLES, s.count, s.idxType, 0);
    }
    for (const an of ATTRS) gl.disableVertexAttribArray(A(an));
  }
  // the glass's front-most layer: depth first (it keeps whatever is already nearer), then colour where it won
  function drawGlass(p, g) {
    uniforms(p, 0, Math.max(0.02, Math.min(0.99, p.glassAlpha ?? 0.3)), 0);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    gl.colorMask(false, false, false, false); draw([g]); gl.colorMask(true, true, true, true);
    gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    draw([g]);
    gl.disable(gl.BLEND); gl.depthMask(true);
  }
  function render(p, names) {   // names: one mesh slot or several, drawn together into one depth buffer
    if (canvas.width !== p.W || canvas.height !== p.H) { canvas.width = p.W; canvas.height = p.H; }
    const list = (Array.isArray(names) ? names : [names]).map(n => slots[n]).filter(s => s && s.mesh && s.count);
    const g = p.glass && slots[p.glass] && slots[p.glass].mesh && slots[p.glass].count ? slots[p.glass] : null;
    const outline = gl2 && p.edge > 0, target = outline ? buffers(p.W, p.H) : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.ms : null);
    gl.viewport(0, 0, p.W, p.H);
    gl.clearColor(0, 0, 0, 0); gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (list.length) {
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.CULL_FACE);
      uniforms(p, p.mode || 0, 1, p.fog);
      draw(list);
    }
    if (!target) { if (g) drawGlass(p, g); return canvas; }   // WebGL1: straight into the canvas
    // resolve, then outline into the canvas
    const resolve = () => {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.ms); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.rs);
      gl.blitFramebuffer(0, 0, p.W, p.H, 0, 0, p.W, p.H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.blitFramebuffer(0, 0, p.W, p.H, 0, 0, p.W, p.H, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    };
    const pass = (pr, thr) => {
      gl.useProgram(pr);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, target.col); gl.uniform1i(U(pr, "u_col"), 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, target.dep); gl.uniform1i(U(pr, "u_dep"), 1);
      gl.uniform2f(U(pr, "u_px"), 1 / p.W, 1 / p.H);
      gl.uniform1f(U(pr, "u_thr"), thr / (6 * p.R));   // a depth jump of more than thr Å (depth spans 6R)
      gl.uniform1f(U(pr, "u_w"), p.edge); gl.uniform3fv(U(pr, "u_ink"), p.ink);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE0);
    };
    resolve();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    pass(edge, 1.6);
    if (g) {   // the glass into the (still deep) offscreen buffer, alone, then over the canvas
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.ms);
      gl.clear(gl.COLOR_BUFFER_BIT);
      drawGlass(p, g);
      resolve();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      pass(glassComp, 3);
      gl.disable(gl.BLEND);
    }
    return canvas;
  }
  const maxSize = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_TEXTURE_SIZE), ...gl.getParameter(gl.MAX_VIEWPORT_DIMS));
  return { canvas, gl2, maxSize, setMesh, setColours, setAO, render, mesh: name => slots[name] && slots[name].mesh };
}
