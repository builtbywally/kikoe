// Kik's hologram body: a person made of light who stands in the Room.
//
// How it is made (after K.A.R.A's digital human; docs/HOLOGRAM.md):
// - A rigged VRM body (vendor/kik-body.js) is resampled into a few hundred
//   thousand points on its surface. Each point carries the shading of the
//   texture under it, the skin weights of its triangle and a place on a
//   sphere. The face is sampled six times denser and carries the face
//   shapes, so she blinks, speaks and smiles with the real blend shapes.
// - The GPU draws the points as skinned meshes in POINTS mode, so they
//   follow the skeleton for free. A hidden copy of the body writes depth
//   only, so you never see through her; a faint wireframe sits on top.
// - Every frame, in order: the moves (Mixamo clips played on their own rig
//   and copied across in world space), the procedural layers (breath,
//   weight, glances, the head following you, a pose, a gesture), the sleeve
//   constraints, then the spring bones (hair and skirt), each smoothed so
//   nothing ever snaps.
// - Sphere and body are the same points: "morph" sends each one from its
//   place on the sphere to its place on the body, head first, bursting
//   outward on the way. Dissolve and vanish are the same trick.
// - Bloom, additive dots, a rim that brightens where the surface turns
//   away, a scan line, flicker, glitches and a projector on the floor make
//   it light rather than a model.
//
// API: window.KikBody.mount(host) returns { show, hide, state, say, quiet,
// panel, gesture, morph, dissolve, vanish, reset, destroy }.
(() => {
  const T = window.KikThree;
  const DATA = window.KIK_BODY;
  if (!T || !DATA) return;

  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const phoneish = Math.min(screen.width, screen.height) < 700;

  // --- tunables -------------------------------------------------------------
  const BODY_POINTS = phoneish ? 130000 : 360000;
  const FACE_POINTS = phoneish ? 16000 : 44000;
  // relative density by material kind (VRoid names end in the kind)
  const DENSITY = { SKIN: 1, CLOTH: 1, HAIR: 0.55, FACE: 1, EYE: 1 };
  // the hologram's colour by Kik's state: blue at rest, amber when it needs
  // you, red when something failed (as K.A.R.A does), cyan while listening
  const TINT = {
    idle: [0.36, 0.72, 1.0],
    listening: [0.42, 0.88, 1.0],
    thinking: [0.55, 0.62, 1.0],
    speaking: [0.4, 0.78, 1.0],
    asking: [1.0, 0.66, 0.28],
    failed: [1.0, 0.34, 0.3],
  };

  // --- small maths ----------------------------------------------------------
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));
  /** A critically damped spring: smooth, never overshoots, frame-rate free. */
  function spring(s, target, omega, dt) {
    const f = 1 + 2 * dt * omega;
    const oo = omega * omega;
    const det = 1 / (f + dt * dt * oo);
    const x = (f * s.x + dt * s.v + dt * dt * oo * target) * det;
    s.v = (s.v + dt * oo * (target - s.x)) * det;
    s.x = x;
  }
  const sp = (x = 0) => ({ x, v: 0 });
  /** Smooth wandering in about [-1, 1]: sines at unrelated rates. */
  const wander = (t, seed) =>
    Math.sin(t * 0.31 + seed) * 0.5 +
    Math.sin(t * 0.73 + seed * 2.1) * 0.3 +
    Math.sin(t * 1.37 + seed * 3.7) * 0.2;
  const smooth = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  /** 0 → 1 → 0 over a gesture's life: ease in, hold, ease out. */
  const envelope = (t, dur, inT = 0.4, outT = 0.5) =>
    t < 0 || t > dur ? 0 : Math.min(smooth(0, inT, t), 1 - smooth(dur - outT, dur, t));
  const sanitize = (n) => T.PropertyBinding.sanitizeNodeName(n);

  function b64ToBuffer(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  // --- shaders --------------------------------------------------------------
  const POINT_VS = /* glsl */ `
    uniform float uTime, uMorph, uSize, uScale, uDissolve, uVanish, uScan, uGlitch, uGlitchY;
    uniform vec3 uCenter; uniform float uRadius;
    attribute vec3 aSphere;
    attribute vec3 aMisc;   // seed, height 0..1, texture shading
    varying float vAlpha, vLum, vRim, vScan, vSeed, vBody;
    #include <common>
    #include <morphtarget_pars_vertex>
    #include <skinning_pars_vertex>
    void main() {
      vec3 transformed = position;
      #include <morphinstance_vertex>
      #include <morphtarget_vertex>
      vec3 objectNormal = normal;
      #include <skinbase_vertex>
      #include <skinnormal_vertex>
      #include <skinning_vertex>
      vec3 body = (modelMatrix * vec4(transformed, 1.0)).xyz;
      vec3 n = normalize(mat3(modelMatrix) * objectNormal);

      // the sphere: the same point, on a turning, breathing ball
      float c = cos(uTime * 0.21), s = sin(uTime * 0.21);
      vec3 q = vec3(c * aSphere.x + s * aSphere.z, aSphere.y, -s * aSphere.x + c * aSphere.z);
      q *= 1.0 + 0.035 * sin(uTime * 1.4 + aMisc.x * 6.2831);
      vec3 ball = uCenter + q * uRadius;

      // head first: each point leaves when the wave reaches its height
      float delay = (1.0 - aMisc.y) * 0.62 + aMisc.x * 0.18;
      float t = clamp(uMorph * 1.8 - delay, 0.0, 1.0);
      float e = t * t * (3.0 - 2.0 * t);
      vec3 swirl = vec3(sin(aMisc.x * 41.0 + uTime * 0.9), cos(aMisc.x * 29.0 - uTime * 0.7),
                        sin(aMisc.x * 17.0 + uTime * 0.6));
      vec3 away = normalize(ball - uCenter + 1e-4);
      vec3 p = mix(ball, body, e) + (away * 0.55 + swirl * 0.3) * sin(3.14159 * t) * 0.7;

      // dissolve: points let go from the feet up and drift away
      float d = clamp(uDissolve * 1.6 - aMisc.y * 0.5 - aMisc.x * 0.1, 0.0, 1.0);
      p += vec3(swirl.x * 0.4, 0.9 + swirl.y * 0.2, swirl.z * 0.4) * d * d;

      // glitch: a thin slice slips sideways for a few frames
      p.x += uGlitch * 0.04 * step(abs(p.y - uGlitchY), 0.022);

      vec4 mv = viewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      float r = fract(aMisc.x * 91.7);
      gl_PointSize = uSize * (0.5 + r * r * 1.4) * uScale / -mv.z;

      vec3 toEye = normalize(cameraPosition - p);
      vRim = (1.0 - abs(dot(toEye, n))) * e;
      vLum = aMisc.z;
      // the scan line sweeping up, and the bright edge of a vanish
      vScan = exp(-pow((p.y - uScan) * 16.0, 2.0)) * e + exp(-pow((p.y - uVanish) * 40.0, 2.0)) * 2.0;
      vAlpha = (1.0 - d) * step(uVanish, p.y);
      vSeed = aMisc.x;
      vBody = e;
    }`;

  const POINT_FS = /* glsl */ `
    uniform vec3 uColor, uHot; uniform float uTime, uBright;
    varying float vAlpha, vLum, vRim, vScan, vSeed, vBody;
    void main() {
      vec2 q = gl_PointCoord - 0.5;
      float r = length(q);
      if (r > 0.5 || vAlpha <= 0.0) discard;
      float dot_ = smoothstep(0.5, 0.05, r);
      float flick = 0.86 + 0.14 * sin(uTime * 21.0 + vSeed * 517.0);
      float lit = (0.22 + 0.78 * vLum) * (0.55 + 1.5 * vRim * vRim) + vScan * 1.6;
      lit = mix(0.45, lit, vBody);  // on the sphere every dot is even, and dimmer: they are packed tight
      vec3 col = mix(uColor, uHot, clamp(vRim * 0.45 + vScan, 0.0, 1.0));
      gl_FragColor = vec4(col * lit * flick * uBright, dot_ * vAlpha);
    }`;

  const FLOOR_VS = /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
  const FLOOR_FS = /* glsl */ `
    uniform vec3 uColor; uniform float uTime, uOn;
    varying vec2 vUv;
    float ring(float r, float at, float w) { return smoothstep(w, 0.0, abs(r - at)); }
    void main() {
      vec2 p = vUv * 2.0 - 1.0;
      float r = length(p), a = atan(p.y, p.x);
      float glow = exp(-r * 3.4) * 0.45;
      float dash1 = step(0.5, fract(a * 6.0 / 6.2831 + uTime * 0.05));
      float dash2 = step(0.3, fract(a * 24.0 / 6.2831 - uTime * 0.08));
      float rings = ring(r, 0.38, 0.006) * dash1 * 0.9 + ring(r, 0.52, 0.004) * 0.5
                  + ring(r, 0.64, 0.01) * dash2 * 0.45 + ring(r, 0.9, 0.003) * 0.25;
      float pulse = ring(r, fract(uTime * 0.18) * 0.95, 0.03) * (1.0 - fract(uTime * 0.18)) * 0.4;
      float a_ = (glow + rings + pulse) * smoothstep(1.0, 0.85, r) * uOn;
      gl_FragColor = vec4(uColor * a_, a_);
    }`;

  const BEAM_VS = /* glsl */ `
    varying vec2 vUv; varying float vFacing;
    void main() {
      vUv = uv;
      vec3 n = normalize(normalMatrix * normal);
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vFacing = abs(dot(n, normalize(-mv.xyz)));
      gl_Position = projectionMatrix * mv;
    }`;
  const BEAM_FS = /* glsl */ `
    uniform vec3 uColor; uniform float uTime, uOn;
    varying vec2 vUv; varying float vFacing;
    void main() {
      float up = pow(1.0 - vUv.y, 2.4);
      float streak = 0.75 + 0.25 * sin(vUv.x * 80.0 + uTime * 0.6) * sin(vUv.x * 31.0 - uTime * 0.4);
      float a = up * (1.0 - vFacing) * 0.07 * streak * uOn;
      gl_FragColor = vec4(uColor * a, a);
    }`;

  const DUST_VS = /* glsl */ `
    uniform float uTime, uScale;
    attribute float aSeed;
    varying float vA;
    void main() {
      vec3 p = position;
      p.y = mod(p.y + uTime * (0.02 + aSeed * 0.05), 3.2) - 0.2;
      p.x += sin(uTime * 0.2 + aSeed * 30.0) * 0.08;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = (1.0 + aSeed * 2.5) * uScale / -mv.z;
      vA = 0.25 + 0.75 * fract(aSeed * 13.7);
    }`;
  const DUST_FS = /* glsl */ `
    uniform vec3 uColor; uniform float uOn;
    varying float vA;
    void main() {
      float r = length(gl_PointCoord - 0.5);
      if (r > 0.5) discard;
      float a = smoothstep(0.5, 0.0, r) * vA * 0.22 * uOn;
      gl_FragColor = vec4(uColor * a, a);
    }`;

  // --- loading ----------------------------------------------------------------

  function parseBody() {
    return new Promise((resolve, reject) => {
      new T.GLTFLoader().parse(b64ToBuffer(DATA.glb), "", resolve, reject);
    });
  }

  /** Each material's base colour, as pixels with alpha, at most 512 px. */
  async function loadTextures() {
    const out = {};
    await Promise.all(
      Object.entries(DATA.tex).map(
        ([name, url]) =>
          new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
              const w = Math.min(512, img.naturalWidth);
              const h = Math.min(512, img.naturalHeight);
              const c = document.createElement("canvas");
              c.width = w;
              c.height = h;
              const g = c.getContext("2d", { willReadFrequently: true });
              g.drawImage(img, 0, 0, w, h);
              out[name] = { w, h, px: g.getImageData(0, 0, w, h).data };
              resolve();
            };
            img.onerror = () => resolve();
            img.src = url;
          }),
      ),
    );
    return out;
  }

  // --- sampling: the body's surface as points ---------------------------------

  /**
   * Resample a set of skinned meshes into n points. Triangles are picked by
   * area times their material's density; a point whose texel is transparent
   * (between hair strands) is drawn again. Each point gets its bind-pose
   * position and normal, skin weights merged from its triangle's corners and
   * remapped to the shared skeleton, the texture's shading, a place on the
   * sphere, its height, and (for the face) its share of every face shape.
   */
  function samplePoints(meshes, n, tex, frame, union, withMorphs) {
    const tris = [];
    let total = 0;
    const a = new T.Vector3();
    const b = new T.Vector3();
    const c = new T.Vector3();
    for (const m of meshes) {
      const g = m.geometry;
      const pos = g.attributes.position;
      const idx = g.index;
      const kind = (m.material.name.match(/_([A-Z]+)$/) ?? [])[1] ?? "SKIN";
      const dens = DENSITY[kind] ?? 1;
      for (let t = 0; t < idx.count / 3; t++) {
        a.fromBufferAttribute(pos, idx.getX(t * 3));
        b.fromBufferAttribute(pos, idx.getX(t * 3 + 1));
        c.fromBufferAttribute(pos, idx.getX(t * 3 + 2));
        const area = b.sub(a).cross(c.sub(a)).length() * 0.5 * dens;
        if (area <= 0) continue;
        total += area;
        tris.push(total, m, t);
      }
    }
    const count = tris.length / 3;
    let seed = 0x4b494b + n;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const shapes = withMorphs ? meshes[0].geometry.morphAttributes.position.length : 0;

    const P = new Float32Array(n * 3);
    const N = new Float32Array(n * 3);
    const SI = new Float32Array(n * 4);
    const SW = new Float32Array(n * 4);
    const SPH = new Float32Array(n * 3);
    const MISC = new Float32Array(n * 3);
    const MORPH = [];
    for (let k = 0; k < shapes; k++) MORPH.push(new Float32Array(n * 3));
    const p = new T.Vector3();
    const nn = new T.Vector3();
    const tmp = new T.Vector3();
    const world = new T.Vector3();
    const w = new Map();
    const golden = Math.PI * (3 - Math.sqrt(5));
    const bary = [0, 0, 0];
    const corners = [0, 0, 0];

    for (let i = 0; i < n; i++) {
      let m;
      let tu = 0;
      let tv = 0;
      let lum = 0.6;
      for (let attempt = 0; attempt < 10; attempt++) {
        const r0 = rnd() * total;
        let lo = 0;
        let hi = count - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (tris[mid * 3] < r0) lo = mid + 1;
          else hi = mid;
        }
        m = tris[lo * 3 + 1];
        const t = tris[lo * 3 + 2];
        const idx = m.geometry.index;
        corners[0] = idx.getX(t * 3);
        corners[1] = idx.getX(t * 3 + 1);
        corners[2] = idx.getX(t * 3 + 2);
        let u = rnd();
        let v = rnd();
        if (u + v > 1) {
          u = 1 - u;
          v = 1 - v;
        }
        bary[0] = 1 - u - v;
        bary[1] = u;
        bary[2] = v;
        const uv = m.geometry.attributes.uv;
        tu = 0;
        tv = 0;
        for (let k = 0; k < 3; k++) {
          tu += uv.getX(corners[k]) * bary[k];
          tv += uv.getY(corners[k]) * bary[k];
        }
        const img = tex[m.material.name];
        if (!img) break;
        const x = clamp(Math.floor((tu - Math.floor(tu)) * img.w), 0, img.w - 1);
        const y = clamp(Math.floor((tv - Math.floor(tv)) * img.h), 0, img.h - 1);
        const o = (y * img.w + x) * 4;
        if (img.px[o + 3] < 90 && attempt < 9) continue; // between strands: try again
        const l = (0.299 * img.px[o] + 0.587 * img.px[o + 1] + 0.114 * img.px[o + 2]) / 255;
        lum = 0.3 + 0.7 * l ** 0.55;
        break;
      }
      const g = m.geometry;
      const pos = g.attributes.position;
      const nor = g.attributes.normal;
      const si = g.attributes.skinIndex;
      const sw = g.attributes.skinWeight;
      const remap = union.remap.get(m);
      p.set(0, 0, 0);
      nn.set(0, 0, 0);
      w.clear();
      for (let k = 0; k < 3; k++) {
        const ci = corners[k];
        const f = bary[k];
        p.addScaledVector(tmp.fromBufferAttribute(pos, ci), f);
        nn.addScaledVector(tmp.fromBufferAttribute(nor, ci), f);
        for (let j = 0; j < 4; j++) {
          const bw = sw.getComponent(ci, j) * f;
          if (bw <= 0) continue;
          const bi = remap[si.getComponent(ci, j)];
          w.set(bi, (w.get(bi) ?? 0) + bw);
        }
        for (let k2 = 0; k2 < shapes; k2++) {
          const ma = g.morphAttributes.position[k2];
          MORPH[k2][i * 3] += ma.getX(ci) * f;
          MORPH[k2][i * 3 + 1] += ma.getY(ci) * f;
          MORPH[k2][i * 3 + 2] += ma.getZ(ci) * f;
        }
      }
      // all meshes share one frame (the VRM's): bake each mesh's own
      // transform in, so one points object can hold them all
      p.applyMatrix4(union.toFrame.get(m));
      nn.transformDirection(union.toFrame.get(m));
      P[i * 3] = p.x;
      P[i * 3 + 1] = p.y;
      P[i * 3 + 2] = p.z;
      N[i * 3] = nn.x;
      N[i * 3 + 1] = nn.y;
      N[i * 3 + 2] = nn.z;
      const top = [...w.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
      const sum = top.reduce((s, e) => s + e[1], 0) || 1;
      for (let j = 0; j < 4; j++) {
        SI[i * 4 + j] = top[j]?.[0] ?? 0;
        SW[i * 4 + j] = (top[j]?.[1] ?? 0) / sum;
      }
      // a place on the sphere: most on the shell, some inside
      const y = 1 - ((i + 0.5) / n) * 2;
      const rr = Math.sqrt(1 - y * y);
      const th = golden * i;
      const depth = rnd() < 0.9 ? 0.985 + rnd() * 0.03 : 0.3 + rnd() * 0.65;
      SPH[i * 3] = Math.cos(th) * rr * depth;
      SPH[i * 3 + 1] = y * depth;
      SPH[i * 3 + 2] = Math.sin(th) * rr * depth;
      world.copy(p).applyMatrix4(frame.matrixWorld);
      MISC[i * 3] = rnd();
      MISC[i * 3 + 1] = clamp((world.y - union.minY) / (union.maxY - union.minY), 0, 1);
      MISC[i * 3 + 2] = lum;
    }
    // triangles were drawn at random, so any prefix is an even subset: the
    // draw range is the level of detail
    const geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.BufferAttribute(P, 3));
    geo.setAttribute("normal", new T.BufferAttribute(N, 3));
    geo.setAttribute("skinIndex", new T.BufferAttribute(SI, 4));
    geo.setAttribute("skinWeight", new T.BufferAttribute(SW, 4));
    geo.setAttribute("aSphere", new T.BufferAttribute(SPH, 3));
    geo.setAttribute("aMisc", new T.BufferAttribute(MISC, 3));
    if (shapes) {
      geo.morphAttributes.position = MORPH.map((m) => new T.BufferAttribute(m, 3));
      geo.morphTargetsRelative = true;
    }
    return geo;
  }

  /**
   * One skeleton for every mesh: the union of their bones, each mesh's joint
   * indices remapped to it, and each mesh's transform relative to the frame
   * all points will live in.
   */
  function unionSkeleton(meshes, frame) {
    const bones = [];
    const inverses = [];
    const at = new Map();
    const remap = new Map();
    const toFrame = new Map();
    const inv = frame.matrixWorld.clone().invert();
    for (const m of meshes) {
      const map = m.skeleton.bones.map((b, i) => {
        if (!at.has(b)) {
          at.set(b, bones.length);
          bones.push(b);
          inverses.push(m.skeleton.boneInverses[i].clone());
        }
        return at.get(b);
      });
      remap.set(m, map);
      toFrame.set(m, inv.clone().multiply(m.matrixWorld));
    }
    const box = new T.Box3();
    for (const m of meshes) {
      const bb = new T.Box3().setFromBufferAttribute(m.geometry.attributes.position);
      bb.applyMatrix4(m.matrixWorld);
      box.union(bb);
    }
    return {
      skeleton: new T.Skeleton(bones, inverses),
      remap,
      toFrame,
      minY: box.min.y,
      maxY: box.max.y,
    };
  }

  // --- the moves: Mixamo clips on their own rig, copied across ----------------

  // Mixamo bone -> VRM humanoid bone
  const MIXAMO = {
    Hips: "hips",
    Spine: "spine",
    Spine1: "chest",
    Spine2: "upperChest",
    Neck: "neck",
    Head: "head",
    LeftShoulder: "leftShoulder",
    LeftArm: "leftUpperArm",
    LeftForeArm: "leftLowerArm",
    LeftHand: "leftHand",
    RightShoulder: "rightShoulder",
    RightArm: "rightUpperArm",
    RightForeArm: "rightLowerArm",
    RightHand: "rightHand",
    LeftUpLeg: "leftUpperLeg",
    LeftLeg: "leftLowerLeg",
    LeftFoot: "leftFoot",
    LeftToeBase: "leftToes",
    RightUpLeg: "rightUpperLeg",
    RightLeg: "rightLowerLeg",
    RightFoot: "rightFoot",
    RightToeBase: "rightToes",
  };

  function sourceRig() {
    const byName = {};
    const root = new T.Object3D();
    for (const n of DATA.rig) {
      const b = new T.Bone();
      b.name = sanitize(n.name);
      b.quaternion.set(n.q[0], n.q[1], n.q[2], n.q[3]);
      b.position.set(n.t[0], n.t[1], n.t[2]);
      byName[n.name] = b;
    }
    for (const n of DATA.rig) (n.parent ? byName[n.parent] : root).add(byName[n.name]);
    root.updateMatrixWorld(true);
    const clips = {};
    for (const [name, clip] of Object.entries(DATA.moves)) {
      clips[name] = new T.AnimationClip(
        name,
        clip.duration,
        clip.tracks.map(
          ([bone, times, values]) =>
            new T.QuaternionKeyframeTrack(`${sanitize(bone)}.quaternion`, times, values),
        ),
      );
    }
    return { root, byName, clips };
  }

  // --- spring bones (VRMC_springBone 1.0, spheres and capsules) ---------------

  function springBones(node) {
    const v = () => new T.Vector3();
    const colliders = DATA.colliders.map((c) => ({
      node: node(c.node),
      sphere: c.sphere,
      capsule: c.capsule,
    }));
    const chains = [];
    for (const s of DATA.springs) {
      const joints = [];
      for (let i = 0; i < s.joints.length - 1; i++) {
        const j = s.joints[i];
        const bone = node(j.node);
        const child = node(s.joints[i + 1].node);
        if (!bone || !child) continue;
        joints.push({
          ...j,
          bone,
          child,
          rest: bone.quaternion.clone(),
          axis: child.position.clone().normalize(),
          length: 0,
          tail: v(),
          prev: v(),
        });
      }
      chains.push({
        joints,
        colliders: s.colliders.map((i) => colliders[i]).filter((c) => c.node),
      });
    }
    const wp = v();
    const next = v();
    const tmp = v();
    const c0 = v();
    const c1 = v();
    const q = new T.Quaternion();
    const pq = new T.Quaternion();
    const g = v();
    function reset() {
      for (const ch of chains) {
        for (const j of ch.joints) {
          j.bone.quaternion.copy(j.rest);
          j.bone.updateMatrixWorld(true);
          j.child.getWorldPosition(j.tail);
          j.prev.copy(j.tail);
          j.length = j.bone.getWorldPosition(wp).distanceTo(j.tail);
        }
      }
    }
    function collide(ch, j) {
      for (const c of ch.colliders) {
        const m = c.node.matrixWorld;
        let r = 0;
        if (c.sphere) {
          c0.fromArray(c.sphere.offset).applyMatrix4(m);
          r = c.sphere.radius;
        } else if (c.capsule) {
          c0.fromArray(c.capsule.offset).applyMatrix4(m);
          c1.fromArray(c.capsule.tail).applyMatrix4(m);
          // closest point on the capsule's segment
          tmp.subVectors(c1, c0);
          const t = clamp(next.clone().sub(c0).dot(tmp) / (tmp.lengthSq() || 1), 0, 1);
          c0.addScaledVector(tmp, t);
          r = c.capsule.radius;
        } else continue;
        const d = next.distanceTo(c0);
        const min = r + j.hitRadius;
        if (d < min && d > 1e-6) {
          next
            .sub(c0)
            .multiplyScalar(min / d)
            .add(c0);
          // back onto the bone's length
          next.sub(wp).setLength(j.length).add(wp);
        }
      }
    }
    function update(dt) {
      for (const ch of chains) {
        for (const j of ch.joints) {
          j.bone.getWorldPosition(wp);
          j.bone.parent.getWorldQuaternion(pq);
          // inertia, the pull back to rest, gravity
          next.copy(j.tail).add(tmp.subVectors(j.tail, j.prev).multiplyScalar(1 - j.dragForce));
          q.copy(pq).multiply(j.rest);
          next.add(
            tmp
              .copy(j.axis)
              .applyQuaternion(q)
              .multiplyScalar(j.stiffness * dt * j.length * 6),
          );
          next.add(g.fromArray(j.gravityDir).multiplyScalar(j.gravityPower * dt * j.length * 6));
          next.sub(wp).setLength(j.length).add(wp);
          collide(ch, j);
          j.prev.copy(j.tail);
          j.tail.copy(next);
          // turn the bone so its child sits on the new tail
          tmp.subVectors(next, wp).applyQuaternion(q.invert()).normalize();
          j.bone.quaternion
            .copy(j.rest)
            .multiply(new T.Quaternion().setFromUnitVectors(j.axis, tmp));
          j.bone.updateMatrixWorld(true);
        }
      }
    }
    return { reset, update };
  }

  // --- poses: rotations about world axes, by humanoid bone ---------------------
  // x is the viewer's right, y up, z toward the viewer. Kik faces +z, so her
  // right hand is on the viewer's left (-x).
  const X = new T.Vector3(1, 0, 0);
  const Y = new T.Vector3(0, 1, 0);
  const Z = new T.Vector3(0, 0, 1);
  // An arm hanging down bends forward at the elbow about -x; an arm held
  // out to the side lifts about z (the right arm by -z, the left by +z).
  const POSES = {
    // listening: a little closer, the head tilted toward you
    listening: [
      ["chest", X, 0.05],
      ["head", Z, 0.08],
      ["head", X, 0.05],
    ],
    // thinking: weight back, chin up, the right hand at the chin
    thinking: [
      ["chest", X, -0.03],
      ["head", X, -0.08],
      ["head", Y, 0.16],
      ["rightUpperArm", X, -0.55],
      ["rightUpperArm", Z, 0.32],
      ["rightLowerArm", X, -2.15],
      ["rightHand", X, 0.35],
      ["leftUpperArm", Z, -0.05],
      ["leftLowerArm", X, -1.2],
      ["leftLowerArm", Z, -0.5],
    ],
    // presenting: the right hand raised forward, palm up, a panel above it
    present: [
      ["rightUpperArm", X, -0.45],
      ["rightUpperArm", Z, -0.3],
      ["rightLowerArm", X, -1.15],
      ["rightHand", Z, 1.4],
      ["head", Y, -0.2],
      ["head", X, 0.06],
    ],
    // the same with the left hand, the panel on the other side
    presentL: [
      ["leftUpperArm", X, -0.45],
      ["leftUpperArm", Z, 0.3],
      ["leftLowerArm", X, -1.15],
      ["leftHand", Z, -1.4],
      ["head", Y, 0.2],
      ["head", X, 0.06],
    ],
    // hovering: sitting on nothing, one leg over the other, hands in the lap
    hover: [
      ["spine", X, -0.06],
      ["leftUpperLeg", X, -1.4],
      ["leftLowerLeg", X, 1.45],
      ["rightUpperLeg", X, -1.25],
      ["rightUpperLeg", Z, 0.22],
      ["rightLowerLeg", X, 1.15],
      ["leftUpperArm", X, -0.35],
      ["leftLowerArm", X, -0.7],
      ["rightUpperArm", X, -0.35],
      ["rightLowerArm", X, -0.7],
      ["head", Z, 0.06],
    ],
    // operating: both hands on a panel at the waist, eyes on the work
    operate: [
      ["leftUpperArm", X, -0.22],
      ["leftUpperArm", Z, -0.1],
      ["leftLowerArm", X, -0.95],
      ["rightUpperArm", X, -0.22],
      ["rightUpperArm", Z, 0.1],
      ["rightLowerArm", X, -0.95],
      ["neck", X, 0.12],
      ["head", X, 0.22],
    ],
    // talking: hands up a little, ready to move with the words
    talk: [
      ["leftUpperArm", X, -0.15],
      ["leftLowerArm", X, -0.75],
      ["rightUpperArm", X, -0.15],
      ["rightLowerArm", X, -0.75],
    ],
  };
  // a posture for each mood, layered on whatever pose she holds
  const MOOD_POSES = {
    happy: [
      ["chest", X, -0.04],
      ["head", Z, 0.07],
      ["head", X, -0.03],
    ],
    concerned: [
      ["chest", X, 0.07],
      ["neck", X, 0.06],
      ["head", X, 0.06],
      ["head", Z, -0.06],
      ["leftShoulder", Z, 0.06],
      ["rightShoulder", Z, -0.06],
    ],
    thinking: [
      ["head", Z, -0.08],
      ["head", X, -0.05],
    ],
  };
  // each mood's face, as VRM expressions, and its colour
  const MOOD_FACE = {
    neutral: { relaxed: 0.08 },
    happy: { happy: 0.38, relaxed: 0.1 },
    concerned: { sad: 0.5, surprised: 0.12 },
    thinking: { relaxed: 0.15 },
  };
  const MOOD_TINT = {
    happy: [0.42, 0.95, 0.88],
    concerned: [1.0, 0.45, 0.42],
    thinking: [0.6, 0.6, 1.0],
  };
  // what a line sounds like it means, for the mood it is said in
  const SOUNDS_CONCERNED =
    /\b(fail(ed|s|ing)?|error|broke(n)?|red|sorry|can'?t|cannot|couldn'?t|problem|denied|blocked|crash(ed)?|wrong|stuck|lost|careful)\b/i;
  const SOUNDS_HAPPY =
    /\b(done|passed|passing|green|great|ready|fixed|works|nice|good news|shipped|merged|perfect|welcome|hello|hi)\b|!/i;
  // the modes the bar offers, and the pose each one holds
  const MODE_POSE = {
    idle: "",
    talk: "talk",
    hover: "hover",
    presentR: "present",
    presentL: "presentL",
    operate: "operate",
  };
  const AUTO_CYCLE = ["idle", "hover", "presentR", "idle", "operate", "presentL", "talk"];
  // one-off gestures: a duration and rotations scaled by an envelope; the
  // time argument adds motion within the hold (the wave's hand)
  const GESTURES = {
    wave: {
      dur: 2.6,
      at: (t) => [
        ["rightUpperArm", Z, -1.15],
        ["rightUpperArm", X, -0.25],
        ["rightLowerArm", Z, -1.35 + Math.sin(t * 8.5) * 0.28],
        ["head", Z, 0.08],
      ],
    },
    bow: {
      dur: 2.0,
      at: () => [
        ["spine", X, 0.3],
        ["chest", X, 0.12],
        ["head", X, 0.2],
      ],
    },
    shrug: {
      dur: 1.7,
      at: () => [
        ["leftShoulder", Z, 0.2],
        ["rightShoulder", Z, -0.2],
        ["leftLowerArm", X, -1.1],
        ["rightLowerArm", X, -1.1],
        ["leftLowerArm", Z, 0.5],
        ["rightLowerArm", Z, -0.5],
        ["head", Z, 0.14],
      ],
    },
  };
  // the order bones are turned in: parents first, so world axes stay world axes
  const ORDER = [
    "hips",
    "spine",
    "chest",
    "upperChest",
    "neck",
    "head",
    "leftShoulder",
    "leftUpperArm",
    "leftLowerArm",
    "leftHand",
    "rightShoulder",
    "rightUpperArm",
    "rightLowerArm",
    "rightHand",
    "leftEye",
    "rightEye",
    "leftUpperLeg",
    "leftLowerLeg",
    "rightUpperLeg",
    "rightLowerLeg",
  ];

  // the bones the moves drive: the posed ones, then the feet
  const RETARGET = [...ORDER, "leftFoot", "leftToes", "rightFoot", "rightToes"];

  // --- mount ----------------------------------------------------------------

  function mount(host) {
    host.classList.add("holo");
    const canvas = document.createElement("canvas");
    canvas.className = "holo-canvas";
    host.appendChild(canvas);
    const hud = document.createElement("div");
    hud.className = "holo-hud";
    hud.innerHTML = `
      <div class="holo-tag"><b>KIK</b> · hologram · <span data-k="state">quiet</span> · <span data-k="ms"></span></div>
      <svg class="holo-wires" aria-hidden="true"></svg>
      <div class="holo-panel" hidden></div>
      <div class="holo-caption" aria-live="polite"></div>
      <div class="holo-gaze" aria-hidden="true"><i></i><i></i></div>
      <div class="holo-keys">space: sphere ↔ body · d: dissolve · v: vanish · r: reset · z: close-up</div>
      <div class="holo-bar" role="toolbar" aria-label="Kik's body">
        <span class="hb-group" data-group="mood">
          <button data-mood="neutral">neutral</button><button data-mood="happy">happy</button><button data-mood="concerned">concerned</button><button data-mood="thinking">thinking</button>
        </span>
        <span class="hb-group">
          <button data-act="speak">speak</button><button data-act="sphere">sphere</button><button data-act="auto">auto</button>
        </span>
        <span class="hb-group" data-group="mode">
          <button data-mode="idle">idle</button><button data-mode="hover">hover</button><button data-mode="talk">talk</button><button data-mode="presentR">present r</button><button data-mode="presentL">present l</button><button data-mode="operate">operate</button>
        </span>
        <span class="hb-group">
          <button data-act="close">close-up</button>
        </span>
      </div>
      <div class="holo-loading">gathering the light…</div>`;
    host.appendChild(hud);
    const $ = (k) => hud.querySelector(k);
    const tagState = $('[data-k="state"]');
    const tagMs = $('[data-k="ms"]');
    const wires = $(".holo-wires");
    const panelEl = $(".holo-panel");
    const captionEl = $(".holo-caption");
    const loadingEl = $(".holo-loading");
    const gazeEl = $(".holo-gaze");
    const barEl = $(".holo-bar");

    const renderer = new T.WebGLRenderer({ canvas, antialias: false, alpha: false });
    const scene = new T.Scene();
    // the background, not the clear colour: RenderPass into a half-float
    // target lost the clear and the stage came out grey
    scene.background = new T.Color(0x040507);
    const camera = new T.PerspectiveCamera(26, 1, 0.05, 50);
    const stage = new T.Group(); // turns when dragged
    scene.add(stage);
    const composer = new T.EffectComposer(renderer);
    composer.addPass(new T.RenderPass(scene, camera));
    const bloom = new T.UnrealBloomPass(new T.Vector2(256, 256), 0.55, 0.35, 0.16);
    composer.addPass(bloom);
    composer.addPass(new T.OutputPass());

    const tint = new T.Color().setRGB(...TINT.idle);
    const tintTarget = new T.Color().setRGB(...TINT.idle);
    const tintGoal = new T.Color().setRGB(...TINT.idle);
    const hot = new T.Color(0.9, 0.97, 1);

    // the floor projector, its beam and the dust in the air
    const floorU = { uColor: { value: tint }, uTime: { value: 0 }, uOn: { value: 0 } };
    const floor = new T.Mesh(
      new T.PlaneGeometry(2.2, 2.2),
      new T.ShaderMaterial({
        uniforms: floorU,
        vertexShader: FLOOR_VS,
        fragmentShader: FLOOR_FS,
        transparent: true,
        depthWrite: false,
        blending: T.AdditiveBlending,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    stage.add(floor);
    const beam = new T.Mesh(
      new T.CylinderGeometry(0.38, 0.56, 2.1, 64, 1, true),
      new T.ShaderMaterial({
        uniforms: floorU,
        vertexShader: BEAM_VS,
        fragmentShader: BEAM_FS,
        transparent: true,
        depthWrite: false,
        side: T.DoubleSide,
        blending: T.AdditiveBlending,
      }),
    );
    beam.position.y = 1.05;
    stage.add(beam);
    const dustN = 1600;
    const dustP = new Float32Array(dustN * 3);
    const dustS = new Float32Array(dustN);
    for (let i = 0; i < dustN; i++) {
      dustP[i * 3] = (Math.random() - 0.5) * 6;
      dustP[i * 3 + 1] = Math.random() * 3.2;
      dustP[i * 3 + 2] = (Math.random() - 0.5) * 4 - 0.5;
      dustS[i] = Math.random();
    }
    const dustGeo = new T.BufferGeometry();
    dustGeo.setAttribute("position", new T.BufferAttribute(dustP, 3));
    dustGeo.setAttribute("aSeed", new T.BufferAttribute(dustS, 1));
    const dustU = {
      uColor: { value: tint },
      uTime: { value: 0 },
      uScale: { value: 1 },
      uOn: { value: 1 },
    };
    const dust = new T.Points(
      dustGeo,
      new T.ShaderMaterial({
        uniforms: dustU,
        vertexShader: DUST_VS,
        fragmentShader: DUST_FS,
        transparent: true,
        depthWrite: false,
        blending: T.AdditiveBlending,
      }),
    );
    dust.frustumCulled = false;
    scene.add(dust);

    // state, all of it smoothed
    const S = {
      visible: false,
      built: false,
      building: null,
      t: 0,
      state: "idle",
      label: "quiet",
      morph: sp(0), // 0 sphere, 1 body
      morphTo: 1,
      dissolve: sp(0),
      dissolveTo: 0,
      vanish: -1,
      vanishTo: -1,
      turn: 0,
      turnV: 0,
      dragging: false,
      lastDrag: 0,
      look: { yaw: sp(), pitch: sp() },
      eyes: { yaw: sp(), pitch: sp() },
      lookTarget: { yaw: 0, pitch: 0 },
      pointerAt: -10,
      glanceAt: 0,
      glance: { yaw: 0, pitch: 0 },
      blink: 0,
      blinkAt: 2,
      blinkPhase: -1,
      double: false,
      talking: false,
      talkStarted: 0,
      words: [],
      text: "",
      visemes: { aa: sp(), ih: sp(), ou: sp(), ee: sp(), oh: sp() },
      mood: { happy: sp(), relaxed: sp(), sad: sp(), surprised: sp() },
      surpriseUntil: 0,
      pose: {},
      poseTo: "",
      // the mood: pinned from the bar, or read from the line, or from the state
      moodPin: "",
      moodLine: "",
      moodLineUntil: 0,
      moodNow: "neutral",
      moodPose: { happy: sp(), concerned: sp(), thinking: sp() },
      // the mode: what the bar asked for, or what auto chose
      mode: "idle",
      auto: false,
      autoAt: 0,
      autoIndex: 0,
      lift: sp(0),
      close: sp(0),
      closeTo: 0,
      // the voice as it is heard (the daemon's meter), for the mouth and hands
      level: sp(0),
      levelTo: 0,
      levelAt: -10,
      gesture: null,
      scanAt: 1.2,
      glitch: 0,
      glitchAt: 4,
      glitchY: 1,
      frames: [],
      lod: BODY_POINTS,
    };
    for (const k of Object.keys(POSES)) S.pose[k] = sp();
    let rootObj = null;

    let U = null; // the point uniforms, shared by the body and the face
    let bodyPts = null;
    let facePts = null;
    let wire = [];
    const depth = [];
    let faceSrc = [];
    let human = null;
    let rig = null;
    let mixer = null;
    let rest = null;
    let springs = null;
    let constraints = [];
    let hand = null;
    let raf = 0;
    let last = 0;
    let height = 1.5;
    let baseY = 0;

    async function build() {
      const [gltf, tex] = await Promise.all([parseBody(), loadTextures()]);
      const root = gltf.scene;
      rootObj = root;
      stage.add(root);
      root.updateMatrixWorld(true);
      const nodes = {};
      root.traverse((o) => {
        nodes[o.name] = o;
      });
      const node = (name) => nodes[sanitize(name)];
      human = {};
      for (const [k, name] of Object.entries(DATA.humanoid)) human[k] = node(name);

      const meshes = [];
      root.traverse((o) => {
        if (o.isSkinnedMesh) meshes.push(o);
      });
      const isFace = (m) => !!m.geometry.morphAttributes.position?.length;
      const isHair = (m) => /_HAIR$/.test(m.material.name);
      // the frame every point lives in: the first mesh's parent
      const frame = meshes[0].parent;
      const union = unionSkeleton(meshes, frame);
      height = union.maxY - union.minY;

      U = {
        uTime: { value: 0 },
        uMorph: { value: 0 },
        uSize: { value: 2.3 },
        uScale: { value: 1 },
        uDissolve: { value: 0 },
        uVanish: { value: -1 },
        uScan: { value: -10 },
        uGlitch: { value: 0 },
        uGlitchY: { value: 1 },
        uCenter: { value: new T.Vector3(0, height * 0.62, 0) },
        uRadius: { value: height * 0.27 },
        uColor: { value: tint },
        uHot: { value: hot },
        uBright: { value: phoneish ? 0.17 : 0.1 },
      };
      const pointsOf = (geo, bright) => {
        const mat = new T.ShaderMaterial({
          uniforms: { ...U, uBright: { value: U.uBright.value * bright } },
          vertexShader: POINT_VS,
          fragmentShader: POINT_FS,
          transparent: true,
          depthWrite: false,
          blending: T.AdditiveBlending,
        });
        // A skinned mesh drawn as points: the renderer skins anything that
        // is a SkinnedMesh and draws GL_POINTS for anything that is isPoints.
        const o = new T.SkinnedMesh(geo, mat);
        o.isMesh = false;
        o.isPoints = true;
        o.frustumCulled = false;
        o.renderOrder = 2;
        frame.add(o);
        // bound like GLTFLoader binds a mesh: at the frame's world transform
        o.bind(union.skeleton, frame.matrixWorld.clone());
        return o;
      };
      bodyPts = pointsOf(
        samplePoints(
          meshes.filter((m) => !isFace(m)),
          BODY_POINTS,
          tex,
          frame,
          union,
          false,
        ),
        1,
      );
      faceSrc = meshes.filter(isFace);
      facePts = pointsOf(samplePoints(faceSrc, FACE_POINTS, tex, frame, union, true), 0.5);
      facePts.morphTargetInfluences = new Array(
        faceSrc[0].geometry.morphAttributes.position.length,
      ).fill(0);

      // the hidden body (depth only, so the far side of her is hidden) and
      // the faint wireframe; hair is left out of both, it is mostly air
      const depthMat = new T.MeshBasicMaterial({
        colorWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: 2,
        polygonOffsetUnits: 4,
      });
      const wireMat = new T.MeshBasicMaterial({
        color: tint,
        wireframe: true,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: T.AdditiveBlending,
      });
      for (const m of meshes) {
        m.frustumCulled = false;
        if (isHair(m)) {
          m.visible = false;
          continue;
        }
        m.material = depthMat;
        m.renderOrder = 0;
        depth.push(m);
        if (isFace(m)) continue;
        const w = new T.SkinnedMesh(m.geometry, wireMat);
        w.frustumCulled = false;
        w.renderOrder = 1;
        m.parent.add(w);
        w.position.copy(m.position);
        w.quaternion.copy(m.quaternion);
        w.scale.copy(m.scale);
        w.bind(m.skeleton, m.bindMatrix);
        wire.push(w);
      }
      wire = { list: wire, mat: wireMat };

      // the moves, on their own rig
      rig = sourceRig();
      mixer = new T.AnimationMixer(rig.root);
      mixer.clipAction(rig.clips.idle).play();
      baseY = root.position.y;
      rest = {};
      for (const [mx, hb] of Object.entries(MIXAMO)) {
        const s = rig.byName[`mixamorig:${mx}`];
        const t = human[hb];
        if (!s || !t) continue;
        rest[hb] = {
          src: s,
          tgt: t,
          rs: s.getWorldQuaternion(new T.Quaternion()),
          rt: t.getWorldQuaternion(new T.Quaternion()),
          local: t.quaternion.clone(),
        };
      }
      constraints = DATA.constraints
        .filter((c) => c.kind === "aim")
        .map((c) => ({
          ...c,
          n: node(c.node),
          s: node(c.source),
          rest: node(c.node)?.quaternion.clone(),
        }))
        .filter((c) => c.n && c.s);
      springs = springBones(node);
      springs.reset();
      hand = human.rightHand;
      // VRoid's proportions are young; a smaller head reads as a woman
      human.head.scale.setScalar(0.88);

      S.built = true;
      loadingEl.hidden = true;
      resize();
    }

    // --- the layers, every frame ---------------------------------------------

    const qA = new T.Quaternion();
    const qB = new T.Quaternion();
    const qC = new T.Quaternion();
    const vA = new T.Vector3();
    const vB = new T.Vector3();

    /** The moves: each source bone's change from rest, in world space, onto ours. */
    function retarget() {
      rig.root.updateMatrixWorld(true);
      for (const hb of RETARGET) {
        const r = rest[hb];
        if (!r) continue;
        r.src.getWorldQuaternion(qA); // Ws
        qA.multiply(qB.copy(r.rs).invert()).multiply(r.rt); // D * Rt
        r.tgt.parent.getWorldQuaternion(qC);
        r.tgt.quaternion.copy(qC.invert().multiply(qA));
        r.tgt.updateMatrixWorld(true);
      }
    }

    /** Turn a humanoid bone about a world axis through its own pivot. */
    function turnBone(name, axis, angle) {
      const b = human[name];
      if (!b || !angle) return;
      b.parent.getWorldQuaternion(qA);
      qB.copy(qA).invert();
      qC.setFromAxisAngle(axis, angle);
      // local' = parent^-1 * turn * parent * local
      b.quaternion.premultiply(qA).premultiply(qC).premultiply(qB);
      b.updateMatrixWorld(true);
    }
    function applyLayers(list) {
      const byBone = new Map();
      for (const [bone, axis, angle] of list) {
        if (!byBone.has(bone)) byBone.set(bone, []);
        byBone.get(bone).push([axis, angle]);
      }
      for (const bone of ORDER) {
        for (const [axis, angle] of byBone.get(bone) ?? []) turnBone(bone, axis, angle);
      }
    }

    /** The sleeve helpers: turn each so its axis points at its source. */
    const AXES = {
      PositiveX: new T.Vector3(1, 0, 0),
      NegativeX: new T.Vector3(-1, 0, 0),
      PositiveY: new T.Vector3(0, 1, 0),
      NegativeY: new T.Vector3(0, -1, 0),
      PositiveZ: new T.Vector3(0, 0, 1),
      NegativeZ: new T.Vector3(0, 0, -1),
    };
    function solveConstraints() {
      for (const c of constraints) {
        c.n.quaternion.copy(c.rest);
        c.n.updateMatrixWorld(true);
        c.n.getWorldQuaternion(qA);
        vA.copy(AXES[c.axis] ?? AXES.PositiveX).applyQuaternion(qA);
        c.s.getWorldPosition(vB).sub(c.n.getWorldPosition(new T.Vector3())).normalize();
        qC.setFromUnitVectors(vA, vB);
        c.n.parent.getWorldQuaternion(qB);
        // local = parent^-1 * (turn * world)
        c.n.quaternion.copy(qB.invert().multiply(qC.multiply(qA)));
        c.n.updateMatrixWorld(true);
      }
    }

    const VOWEL = { a: "aa", e: "ee", i: "ih", o: "oh", u: "ou", y: "ih" };
    function animate(dt) {
      const t = S.t;
      mixer.update(dt);
      retarget();
      const L = [];

      // breath, weight, a little sway: never still
      const breath = Math.sin(t * 1.25) * 0.5 + 0.5;
      L.push(["chest", X, -0.02 * breath]);
      L.push(["upperChest", X, -0.012 * breath]);
      L.push(["leftShoulder", Z, 0.02 * breath]);
      L.push(["rightShoulder", Z, -0.02 * breath]);
      // a standing pose with weight on one leg: hips tilt, the free knee
      // bends, the shoulders answer the hips
      const shift = 0.6 + 0.4 * wander(t * 0.15, 0.7);
      L.push(["hips", Z, 0.05 * shift + wander(t * 0.4, 1.3) * 0.015]);
      L.push(["spine", Z, -0.04 * shift - wander(t * 0.4, 1.3) * 0.012]);
      L.push(["chest", Z, -0.02 * shift]);
      L.push(["leftUpperLeg", Z, -0.1]);
      L.push(["rightUpperLeg", Z, 0.08 + 0.03 * shift]);
      L.push(["leftUpperLeg", X, -0.12 * shift]);
      L.push(["leftLowerLeg", X, 0.24 * shift]);
      L.push(["leftUpperArm", Z, 0.1]);
      L.push(["rightUpperArm", Z, -0.1]);
      L.push(["leftLowerArm", X, -0.18]);
      L.push(["rightLowerArm", X, -0.18]);

      // the pose: the state's when it has one (thinking, listening, asking),
      // else the mode's; auto walks through the modes while she is idle
      if (S.auto && S.state === "idle" && !S.talking && t > S.autoAt) {
        S.autoIndex = (S.autoIndex + 1) % AUTO_CYCLE.length;
        S.mode = AUTO_CYCLE[S.autoIndex];
        S.autoAt = t + 8 + Math.random() * 7;
        markBar();
      }
      const fromMode = MODE_POSE[S.mode] ?? "";
      const pose = S.poseTo || (S.talking && !fromMode ? "talk" : fromMode);
      for (const [name, s] of Object.entries(S.pose)) {
        spring(s, pose === name ? 1 : 0, 4.5, dt);
        if (s.x > 0.001) for (const [b, ax, a] of POSES[name]) L.push([b, ax, a * s.x]);
      }
      // hovering lifts her off the floor and bobs
      spring(S.lift, pose === "hover" ? 0.42 + Math.sin(t * 1.1) * 0.025 : 0, 2.2, dt);
      if (rootObj) rootObj.position.y = baseY + S.lift.x;
      // the mood's posture
      S.moodNow =
        S.moodPin ||
        (t < S.moodLineUntil ? S.moodLine : "") ||
        (S.state === "failed" ? "concerned" : S.state === "thinking" ? "thinking" : "neutral");
      for (const [name, s] of Object.entries(S.moodPose)) {
        spring(s, S.moodNow === name ? 1 : 0, 3, dt);
        if (s.x > 0.001) for (const [b, ax, a] of MOOD_POSES[name]) L.push([b, ax, a * s.x]);
      }
      // the voice as heard: a held level decays when the meter goes quiet
      if (t - S.levelAt > 0.25) S.levelTo = 0;
      spring(S.level, S.levelTo, 22, dt);
      // talking hands: small beats on the louder syllables, never in sync
      if (S.talking || pose === "talk") {
        const beat = S.level.x;
        const r = wander(t * 2.3, 5.1);
        const l = wander(t * 2.1, 9.4);
        L.push(["rightLowerArm", X, -0.25 * beat * (0.6 + 0.4 * r)]);
        L.push(["leftLowerArm", X, -0.2 * beat * (0.6 + 0.4 * l)]);
        L.push(["rightHand", Z, 0.25 * beat * r]);
        L.push(["leftHand", Z, -0.25 * beat * l]);
        L.push(["head", X, 0.05 * beat]);
      }
      // operating: the fingers' work, as small hand moves
      if (pose === "operate") {
        L.push(["rightHand", X, Math.sin(t * 7.3) * 0.08 * S.pose.operate.x]);
        L.push(["leftHand", X, Math.sin(t * 6.1 + 1.7) * 0.08 * S.pose.operate.x]);
      }
      if (S.gesture) {
        const g = GESTURES[S.gesture.name];
        const gt = t - S.gesture.at;
        const env = envelope(gt, g.dur);
        if (gt > g.dur) S.gesture = null;
        else for (const [b, ax, a] of g.at(gt)) L.push([b, ax, a * env]);
      }

      // where she looks: at you (the pointer), else a glance, else ahead
      if (t > S.glanceAt) {
        S.glanceAt = t + 2.5 + Math.random() * 4.5;
        const away = S.state === "thinking" ? 1 : Math.random() < 0.55 ? 0 : 0.6;
        S.glance = {
          yaw: (Math.random() - 0.5) * 0.5 * away,
          pitch: (S.state === "thinking" ? -0.14 : (Math.random() - 0.5) * 0.12) * away,
        };
      }
      const following = t - S.pointerAt < 3 || S.state === "listening" || S.close.x > 0.5;
      const ty = following ? S.lookTarget.yaw : S.glance.yaw;
      const tp = following ? S.lookTarget.pitch : S.glance.pitch;
      // the eyes get there first, the head follows
      spring(S.eyes.yaw, ty - S.turn, 18, dt);
      spring(S.eyes.pitch, tp, 18, dt);
      spring(S.look.yaw, ty - S.turn * 0.5, 5, dt);
      spring(S.look.pitch, tp, 5, dt);
      L.push(["neck", Y, S.look.yaw * 0.35]);
      L.push(["head", Y, S.look.yaw * 0.5]);
      L.push(["neck", X, S.look.pitch * 0.3]);
      L.push(["head", X, S.look.pitch * 0.6]);
      const ey = clamp((S.eyes.yaw - S.look.yaw * 0.85) * 0.9, -0.35, 0.35);
      const ep = clamp((S.eyes.pitch - S.look.pitch * 0.9) * 0.9, -0.25, 0.25);
      L.push(["leftEye", Y, ey], ["rightEye", Y, ey], ["leftEye", X, ep], ["rightEye", X, ep]);

      applyLayers(L);
      solveConstraints();
      springs.update(Math.min(dt, 1 / 30));

      // blinks: every few seconds, sometimes twice, and on a big glance
      if (S.blinkPhase < 0 && t > S.blinkAt) {
        S.blinkPhase = 0;
        S.double = Math.random() < 0.18;
      }
      if (S.blinkPhase >= 0) {
        S.blinkPhase += dt;
        const bp = S.blinkPhase;
        S.blink = bp < 0.07 ? bp / 0.07 : bp < 0.18 ? 1 - (bp - 0.07) / 0.11 : 0;
        if (bp > 0.18) {
          if (S.double) {
            S.double = false;
            S.blinkPhase = 0;
          } else {
            S.blinkPhase = -1;
            S.blinkAt = t + 2 + Math.random() * 4.5;
          }
        }
      }

      // the mouth: the vowel of the letter being said, from the line itself
      const target = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
      if (S.talking && S.text) {
        const el = t - S.talkStarted;
        const at = Math.floor(el * 14.5); // letters per second
        // the meter, when it is talking, says how open; the letter says which shape
        const heard = t - S.levelAt < 0.4;
        const open = heard ? S.level.x : 0.8;
        if (at < S.text.length) {
          const ch = S.text[at].toLowerCase();
          const v = VOWEL[ch];
          if (v) target[v] = 0.25 + 0.75 * open;
          else if (/[a-z]/.test(ch)) target[heard ? "aa" : "ih"] = heard ? 0.6 * open : 0.15;
        } else if (heard) target.aa = 0.7 * open;
        captionTick(el);
        if (at >= S.text.length + 8 && !heard) S.talking = false;
      }
      for (const [k, s] of Object.entries(S.visemes)) spring(s, target[k], 32, dt);
      const face = MOOD_FACE[S.moodNow] ?? MOOD_FACE.neutral;
      spring(S.mood.happy, face.happy ?? 0, 3, dt);
      spring(S.mood.relaxed, face.relaxed ?? 0, 2, dt);
      spring(S.mood.sad, face.sad ?? 0, 2.5, dt);
      spring(S.mood.surprised, t < S.surpriseUntil ? 0.35 : (face.surprised ?? 0), 6, dt);

      // the face shapes, from the expressions
      const infl = facePts.morphTargetInfluences;
      infl.fill(0);
      const add = (expr, wgt) => {
        if (wgt <= 0.001) return;
        for (const [, idx, bw] of DATA.expressions[expr] ?? []) infl[idx] += wgt * bw;
      };
      // a smile half-closes VRoid's eyes, so the blink takes what is left
      const happy = S.mood.happy.x;
      add("happy", happy);
      add("relaxed", S.mood.relaxed.x);
      add("sad", S.mood.sad.x);
      add("surprised", S.mood.surprised.x);
      add("blink", S.blink * (1 - happy));
      for (const [k, s] of Object.entries(S.visemes)) add(k, s.x);
      for (let i = 0; i < infl.length; i++) infl[i] = clamp(infl[i], 0, 1);
      for (const m of faceSrc)
        if (m.morphTargetInfluences) m.morphTargetInfluences.splice(0, infl.length, ...infl);
    }

    // --- captions, word by word ---------------------------------------------

    function captionTick(el) {
      if (!S.words.length) return;
      // a word lands when the mouth reaches its first letter
      let shown = 0;
      let at = 0;
      for (const w of S.words) {
        if (at > el * 14.5) break;
        shown++;
        at += w.length + 1;
      }
      if (captionEl.dataset.n !== String(shown)) {
        captionEl.dataset.n = String(shown);
        captionEl.innerHTML = S.words
          .map((w, i) => `<span class="${i < shown ? "on" : ""}">${esc(w)}</span>`)
          .join(" ");
      }
    }
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

    // --- gaze rings: where her eyes are, in a close-up ------------------------

    const ge = new T.Vector3();
    function placeGaze() {
      const on = S.close.x;
      if (on < 0.05 || !human?.leftEye) {
        if (gazeEl.style.opacity !== "0") gazeEl.style.opacity = "0";
        return;
      }
      gazeEl.style.opacity = String(Math.min(1, on * 1.4));
      const w = host.clientWidth;
      const h = host.clientHeight;
      [human.leftEye, human.rightEye].forEach((eye, i) => {
        eye.getWorldPosition(ge);
        // in front of the eyeball, where the iris is
        ge.z += 0.012;
        ge.project(camera);
        const ring = gazeEl.children[i];
        ring.style.transform = `translate(${(ge.x * 0.5 + 0.5) * w}px, ${(-ge.y * 0.5 + 0.5) * h}px) translate(-50%, -50%)`;
      });
    }

    // --- the panel above her hand -------------------------------------------

    const pv = new T.Vector3();
    function placePanel() {
      if (panelEl.hidden || !hand) {
        if (wires.firstChild) wires.textContent = "";
        return;
      }
      const left = S.pose.presentL.x > S.pose.present.x;
      (left ? human.leftHand : hand).getWorldPosition(pv);
      pv.y += 0.05;
      pv.project(camera);
      const w = host.clientWidth;
      const h = host.clientHeight;
      const x = (pv.x * 0.5 + 0.5) * w;
      const y = (-pv.y * 0.5 + 0.5) * h;
      const pw = panelEl.offsetWidth;
      const ph = panelEl.offsetHeight;
      // the panel sits on the side of the raised hand
      const px0 = left ? clamp(x + 40, 16, w - pw - 16) : clamp(x - pw - 40, 16, w - pw - 16);
      const top = clamp(y - ph - 50, 48, h - ph - 16);
      panelEl.style.transform = `translate(${px0}px, ${top}px)`;
      const a = (Math.max(S.pose.present.x, S.pose.presentL.x) * 0.6).toFixed(2);
      const near = left ? px0 : px0 + pw;
      const far = left ? px0 + pw : px0;
      wires.innerHTML = [
        [far, top + ph],
        [near, top + ph],
        [near, top],
      ]
        .map(([px, py]) => `<line x1="${x}" y1="${y}" x2="${px}" y2="${py}" style="opacity:${a}"/>`)
        .join("");
    }

    // --- the frame ------------------------------------------------------------

    function frame(now) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - (last || now)) / 1000);
      last = now;
      S.t += dt;
      const t = S.t;

      // turning: inertia while free, then a slow return to facing you
      if (!S.dragging) {
        S.turn += S.turnV * dt;
        S.turnV *= Math.exp(-3 * dt);
        if (now - S.lastDrag > 3500) S.turn = damp(S.turn, 0, 0.8, dt);
      }
      stage.rotation.y = S.turn;

      // the colour: asking and failing keep theirs; otherwise a mood's, if any
      const moodTint = S.state !== "asking" && S.state !== "failed" ? MOOD_TINT[S.moodNow] : null;
      if (moodTint) tintGoal.setRGB(...moodTint);
      else tintGoal.copy(tintTarget);
      tint.lerp(tintGoal, 1 - Math.exp(-2.5 * dt));
      floorU.uTime.value = t;
      dustU.uTime.value = t;

      if (S.built) {
        animate(dt);
        spring(S.morph, S.morphTo, reduce ? 50 : 1.9, dt);
        spring(S.dissolve, S.dissolveTo, 1.6, dt);
        // vanish: a line rises from her feet and she is gone below it
        S.vanish = damp(S.vanish, S.vanishTo, 1.1, dt);
        if (t > S.scanAt) S.scanAt = t + 7 + Math.random() * 5;
        const since = t - (S.scanAt - 7);
        U.uTime.value = t;
        U.uMorph.value = S.morph.x;
        U.uDissolve.value = S.dissolve.x;
        U.uVanish.value = S.vanish;
        U.uScan.value = since >= 0 && since < 1.6 ? -0.1 + (since / 1.6) * (height + 0.3) : -10;
        if (t > S.glitchAt) {
          S.glitchAt = t + 5 + Math.random() * 9;
          S.glitch = 1;
          S.glitchY = 0.2 + Math.random() * height;
        }
        S.glitch = damp(S.glitch, 0, 14, dt);
        U.uGlitch.value = S.glitch * (Math.random() < 0.5 ? -1 : 1);
        U.uGlitchY.value = S.glitchY;
        const bodyOn = smooth(0.8, 1, S.morph.x) * (1 - S.dissolve.x);
        for (const m of depth) m.visible = bodyOn > 0.95 && S.vanish < 0;
        wire.mat.opacity = 0.016 * bodyOn;
        floorU.uOn.value = damp(floorU.uOn.value, 0.3 + 0.7 * bodyOn, 3, dt);
        placePanel();
        placeGaze();
      }

      // the camera breathes very slightly, so the room is never a photograph;
      // a close-up moves in on her face
      spring(S.close, S.closeTo, 2.6, dt);
      const c = S.close.x;
      const dist = (height * 0.62) / Math.tan(((camera.fov / 2) * Math.PI) / 180);
      const headY = human?.head ? human.head.getWorldPosition(ge).y + 0.06 : height * 0.92;
      const lift = S.lift.x;
      camera.position.set(
        Math.sin(t * 0.11) * 0.05 * (1 - c),
        (height * 0.62 + lift * 0.8) * (1 - c) + headY * c + Math.sin(t * 0.17) * 0.015,
        dist * (1 - c) + 0.95 * c,
      );
      camera.lookAt(0, (height * 0.5 + lift * 0.8) * (1 - c) + (headY - 0.05) * c, 0);
      composer.render(dt);

      // frame time, and fewer points if the machine is struggling
      S.frames.push(dt);
      if (S.frames.length > 90) {
        const avg = S.frames.reduce((a, b) => a + b, 0) / S.frames.length;
        S.frames.length = 0;
        tagMs.textContent = `${(avg * 1000).toFixed(1)} ms`;
        if (bodyPts && avg > 0.024 && S.lod > 80000) {
          S.lod = Math.floor(S.lod * 0.7);
          bodyPts.geometry.setDrawRange(0, S.lod);
        }
      }
    }

    function resize() {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      const dpr = Math.min(window.devicePixelRatio || 1, phoneish ? 2 : 1.5);
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      composer.setPixelRatio(dpr);
      composer.setSize(w, h);
      bloom.resolution.set(w / 2, h / 2);
      camera.aspect = w / h;
      // keep her whole on narrow screens
      camera.fov = w / h < 0.8 ? 26 / Math.max(0.55, w / h / 0.8) : 26;
      camera.updateProjectionMatrix();
      const scale = (h * dpr) / 800;
      if (U) U.uScale.value = scale;
      for (const o of [bodyPts, facePts]) if (o) o.material.uniforms.uScale.value = scale;
      dustU.uScale.value = scale * 2;
    }
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    // --- input ----------------------------------------------------------------

    let dragX = 0;
    let dragT = 0;
    host.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".holo-panel, .holo-bar")) return;
      S.dragging = true;
      dragX = e.clientX;
      dragT = performance.now();
      host.setPointerCapture?.(e.pointerId);
    });
    host.addEventListener("pointermove", (e) => {
      const r = host.getBoundingClientRect();
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
      S.lookTarget.yaw = clamp(nx * 0.6, -0.6, 0.6);
      S.lookTarget.pitch = clamp(ny * 0.3, -0.25, 0.25);
      S.pointerAt = S.t;
      if (!S.dragging) return;
      const now = performance.now();
      const dx = e.clientX - dragX;
      S.turn += dx * 0.008;
      S.turnV = (dx * 0.008) / Math.max(0.008, (now - dragT) / 1000);
      dragX = e.clientX;
      dragT = now;
      S.lastDrag = now;
    });
    host.addEventListener("dblclick", (e) => {
      if (!e.target.closest(".holo-bar, .holo-panel")) api.closeUp();
    });
    barEl.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.mood) api.mood(S.moodPin === b.dataset.mood ? "" : b.dataset.mood);
      else if (b.dataset.mode) api.mode(b.dataset.mode);
      else if (b.dataset.act === "speak") api.onAction?.("speak");
      else if (b.dataset.act === "sphere") api.morph();
      else if (b.dataset.act === "auto") api.auto(!S.auto);
      else if (b.dataset.act === "close") api.closeUp();
    });
    /** Light the bar's buttons for what is on. */
    function markBar() {
      for (const b of barEl.querySelectorAll("button")) {
        const on =
          (b.dataset.mood && b.dataset.mood === (S.moodPin || S.moodNow)) ||
          (b.dataset.mode && b.dataset.mode === S.mode) ||
          (b.dataset.act === "auto" && S.auto) ||
          (b.dataset.act === "close" && S.closeTo > 0.5) ||
          (b.dataset.act === "sphere" && S.morphTo < 0.5);
        b.classList.toggle("on", Boolean(on));
        if (b.dataset.mood) b.classList.toggle("pinned", b.dataset.mood === S.moodPin);
      }
    }
    setInterval(() => S.visible && markBar(), 400);
    const endDrag = () => {
      S.dragging = false;
      S.lastDrag = performance.now();
    };
    host.addEventListener("pointerup", endDrag);
    host.addEventListener("pointercancel", endDrag);
    const onKey = (e) => {
      if (!S.visible || e.target.closest?.("input, textarea, [contenteditable]")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === " ") api.morph();
      else if (k === "d") api.dissolve();
      else if (k === "v") api.vanish();
      else if (k === "r") api.reset();
      else if (k === "w") api.gesture("wave");
      else if (k === "h") api.mode(S.mode === "hover" ? "idle" : "hover");
      else if (k === "a") api.auto(!S.auto);
      else if (k === "z") api.closeUp();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);

    // --- the API ----------------------------------------------------------------

    const api = {
      async show() {
        if (S.visible) return;
        S.visible = true;
        host.hidden = false;
        resize();
        last = 0;
        raf = requestAnimationFrame(frame);
        if (!S.built) {
          // let the stage paint before the build takes its second
          await new Promise((r) => setTimeout(r, 30));
          S.building ??= build();
          await S.building;
        }
        // come out of the sphere every time she is opened, then say hello
        S.morph.x = reduce ? 1 : 0;
        S.morph.v = 0;
        S.morphTo = 0;
        clearTimeout(S.formTimer);
        S.formTimer = setTimeout(
          () => {
            S.morphTo = 1;
          },
          reduce ? 0 : 1100,
        );
        S.dissolveTo = 0;
        S.vanishTo = -1;
        if (!reduce) setTimeout(() => S.visible && api.gesture("wave"), 3600);
      },
      hide() {
        S.visible = false;
        cancelAnimationFrame(raf);
        host.hidden = true;
      },
      /** Kik's state from the Room: idle, listening, speaking, asking, failed; "thinking" as the label. */
      state(state, label) {
        const s = label === "thinking" ? "thinking" : state;
        if (s === "listening" && S.state !== "listening") S.surpriseUntil = S.t + 0.5;
        S.state = s;
        S.label = label ?? s;
        tagState.textContent = S.label;
        tintTarget.setRGB(...(TINT[s] ?? TINT.idle));
        S.poseTo =
          s === "thinking"
            ? "thinking"
            : s === "listening"
              ? "listening"
              : s === "asking"
                ? "present"
                : "";
        if (label === "heard you" && mixer) {
          const a = mixer.clipAction(rig.clips.agree);
          a.reset().setLoop(T.LoopOnce, 1).setEffectiveWeight(0.8).fadeIn(0.25).play();
          setTimeout(() => a.fadeOut(0.5), 900);
        }
        if (label === "not for me") api.gesture("shrug");
      },
      /** Kik starts to say a line: the mouth shapes its vowels, the caption writes itself. */
      say(text) {
        const line = String(text ?? "");
        // the line's mood holds while it is said and a little after
        S.moodLine = SOUNDS_CONCERNED.test(line)
          ? "concerned"
          : SOUNDS_HAPPY.test(line)
            ? "happy"
            : "";
        S.moodLineUntil = S.t + 3 + line.length / 14.5;
        S.talking = true;
        S.talkStarted = S.t;
        S.text = String(text ?? "").slice(0, 600);
        S.words = S.text.split(/\s+/).filter(Boolean).slice(0, 80);
        captionEl.dataset.n = "";
        captionEl.classList.add("on");
      },
      /** The line is over. */
      quiet() {
        S.talking = false;
        if (S.words.length) captionTick(1e4);
        setTimeout(() => {
          if (!S.talking) captionEl.classList.remove("on");
        }, 2200);
      },
      /** A panel above the raised hand: { kicker, figure, unit, text, rows: [[name, value, 0..1]], series } or null. */
      panel(p) {
        if (!p) {
          panelEl.hidden = true;
          if (/^present/.test(S.poseTo) && S.state !== "asking") S.poseTo = "";
          return;
        }
        const rows = (p.rows ?? [])
          .slice(0, 4)
          .map(
            ([n, v, lv]) =>
              `<div class="hp-row"><span>${esc(n)}</span><i style="width:${Math.round(clamp(Number(lv) || 0.5, 0, 1) * 100)}%"></i><b>${esc(v ?? "")}</b></div>`,
          )
          .join("");
        let spark = "";
        if (p.series?.length > 1) {
          const s = p.series;
          const mx = Math.max(...s);
          const mn = Math.min(...s);
          const pts = s
            .map((v, i) => `${(i / (s.length - 1)) * 200},${50 - ((v - mn) / (mx - mn || 1)) * 44}`)
            .join(" ");
          spark = `<svg viewBox="0 0 200 54" class="hp-spark"><polyline points="${pts}"/><polygon points="0,54 ${pts} 200,54"/></svg>`;
        }
        panelEl.innerHTML = `<div class="hp-k">${esc(p.kicker ?? "")}</div>${
          p.figure != null
            ? `<div class="hp-fig">${esc(p.figure)}<small>${esc(p.unit ?? "")}</small></div>`
            : ""
        }${p.text ? `<div class="hp-text">${esc(p.text)}</div>` : ""}${spark}${rows}`;
        panelEl.hidden = false;
        // the hand the mode raises, or the right
        S.poseTo = S.mode === "presentL" ? "presentL" : "present";
      },
      gesture(name) {
        if (GESTURES[name] && S.built) S.gesture = { name, at: S.t };
      },
      /** How loud the voice is as it is heard, 0..1 (the daemon's voice frames). */
      level(l) {
        S.levelTo = clamp(Number(l) || 0, 0, 1);
        S.levelAt = S.t;
      },
      /** Pin a mood (neutral, happy, concerned, thinking), or "" to let the day choose. */
      mood(m) {
        S.moodPin = MOOD_FACE[m] ? m : "";
        markBar();
      },
      /** Hold a mode: idle, talk, hover, presentR, presentL, operate. */
      mode(m) {
        if (!(m in MODE_POSE)) return;
        S.mode = m;
        S.auto = false;
        markBar();
      },
      /** Let her walk through the modes on her own while idle. */
      auto(on) {
        S.auto = Boolean(on);
        S.autoAt = S.t + 1;
        if (!S.auto) S.mode = "idle";
        markBar();
      },
      /** In on her face, with rings where her eyes look; again to step back. */
      closeUp(on) {
        S.closeTo = (on ?? !(S.closeTo > 0.5)) ? 1 : 0;
        markBar();
      },
      morph() {
        S.morphTo = S.morphTo > 0.5 ? 0 : 1;
      },
      dissolve() {
        S.dissolveTo = S.dissolveTo > 0.5 ? 0 : 1;
      },
      vanish() {
        S.vanishTo = S.vanishTo < 0 ? height + 0.2 : -1;
      },
      reset() {
        S.morphTo = 1;
        S.dissolveTo = 0;
        S.vanishTo = -1;
        S.turnV = 0;
        S.gesture = null;
        S.mode = "idle";
        S.auto = false;
        S.moodPin = "";
        S.closeTo = 0;
        api.panel(null);
        markBar();
      },
      destroy() {
        api.hide();
        ro.disconnect();
        window.removeEventListener("keydown", onKey);
        renderer.dispose();
        host.textContent = "";
      },
    };
    // for tuning from DevTools: KikBody.debug.bloom.strength = 0.3
    api.debug = {
      renderer,
      composer,
      camera,
      scene,
      bloom,
      beam,
      dust,
      floor,
      get wire() {
        return wire;
      },
      get U() {
        return U;
      },
    };
    return api;
  }

  window.KikBody = { mount };
})();
