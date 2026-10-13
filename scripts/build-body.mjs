// Packs Kik's hologram body into one browser script for the Room and the
// phone, which load plain scripts with no bundler of their own.
//
// Two files go in:
//   body.vrm  pixiv's VRM1_Constraint_Twist_Sample (github.com/pixiv/three-vrm,
//             packages/three-vrm/examples/models). Its licence allows
//             redistribution, modification and commercial use, credit not
//             required. A VRM is a glTF: a skinned woman, face shapes (mouth
//             visemes, blinks, moods), spring bones for her hair and skirt,
//             and aim constraints for the sleeves.
//   Xbot.glb  Mixamo's X Bot from the three.js examples, for its moves:
//             idle, agree (a nod), headShake, sad_pose. body.js retargets
//             them onto the VRM skeleton through world-space rest poses.
//
// The body is repacked with only what the hologram reads: positions,
// normals, uvs, joints, weights, indices, the skins, 14 face shapes
// (positions only), and each material's base colour image beside it as a
// data: URL (the Room's content security policy refuses the blob: URLs
// GLTFLoader would make). Normal maps, MToon, the thumbnail and the other
// 43 face shapes are dropped.
//
// Then three.js (MIT) and the addons the hologram uses are bundled with
// esbuild into vendor/three-body.js as window.KikThree.
//
//   node scripts/build-body.mjs <dir with body.vrm and Xbot.glb> [<dir holding node_modules/three>]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.resolve(here, "..", "packages", "app", "renderer", "room", "vendor");
const models = process.argv[2];
const threeHome = process.argv[3] ?? path.resolve(here, "..");
if (!models) {
  console.error("usage: node scripts/build-body.mjs <models dir> [<dir with node_modules/three>]");
  process.exit(1);
}

// --- reading a GLB -----------------------------------------------------------

function readGlb(file) {
  const b = readFileSync(file);
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString("utf8"));
  const binStart = 20 + jsonLen + 8;
  const bin = b.subarray(binStart, binStart + b.readUInt32LE(20 + jsonLen));
  return { json, bin };
}

const COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const TYPED = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array };

/** An accessor as a tightly packed typed array; strides and sparse resolved. */
function readAccessor(g, i) {
  const a = g.json.accessors[i];
  const C = TYPED[a.componentType];
  const n = COMPS[a.type];
  const out = new C(a.count * n);
  if (a.bufferView != null) {
    const v = g.json.bufferViews[a.bufferView];
    const stride = v.byteStride ?? n * C.BYTES_PER_ELEMENT;
    const base = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const dv = new DataView(g.bin.buffer, g.bin.byteOffset);
    const get = {
      5126: (o) => dv.getFloat32(o, true),
      5125: (o) => dv.getUint32(o, true),
      5123: (o) => dv.getUint16(o, true),
      5121: (o) => dv.getUint8(o),
    }[a.componentType];
    for (let e = 0; e < a.count; e++) {
      for (let k = 0; k < n; k++) out[e * n + k] = get(base + e * stride + k * C.BYTES_PER_ELEMENT);
    }
  }
  if (a.sparse) {
    const s = a.sparse;
    const idx = readRaw(
      g,
      s.indices.bufferView,
      s.indices.byteOffset ?? 0,
      s.count,
      TYPED[s.indices.componentType],
      1,
    );
    const val = readRaw(g, s.values.bufferView, s.values.byteOffset ?? 0, s.count, C, n);
    for (let e = 0; e < s.count; e++) {
      for (let k = 0; k < n; k++) out[idx[e] * n + k] = val[e * n + k];
    }
  }
  return out;
}

function readRaw(g, view, offset, count, C, n) {
  const v = g.json.bufferViews[view];
  const off = g.bin.byteOffset + (v.byteOffset ?? 0) + offset;
  return new C(g.bin.buffer.slice(off, off + count * n * C.BYTES_PER_ELEMENT));
}

// --- writing a GLB -------------------------------------------------------------

function glbWriter() {
  const chunks = [];
  let length = 0;
  const bufferViews = [];
  const accessors = [];
  return {
    bufferViews,
    accessors,
    /** Add a typed array as a new accessor; returns its index. */
    add(arr, type, componentType, target, minmax) {
      const bytes = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
      const pad = (4 - (length % 4)) % 4;
      if (pad) {
        chunks.push(Buffer.alloc(pad));
        length += pad;
      }
      const v = { buffer: 0, byteOffset: length, byteLength: bytes.length };
      if (target) v.target = target;
      bufferViews.push(v);
      chunks.push(bytes);
      length += bytes.length;
      const acc = {
        bufferView: bufferViews.length - 1,
        componentType,
        count: arr.length / COMPS[type],
        type,
      };
      if (minmax) {
        const n = COMPS[type];
        acc.min = Array(n).fill(Number.POSITIVE_INFINITY);
        acc.max = Array(n).fill(Number.NEGATIVE_INFINITY);
        for (let i = 0; i < arr.length; i++) {
          acc.min[i % n] = Math.min(acc.min[i % n], arr[i]);
          acc.max[i % n] = Math.max(acc.max[i % n], arr[i]);
        }
      }
      accessors.push(acc);
      return accessors.length - 1;
    },
    finish(json) {
      const bin = Buffer.concat(chunks);
      json.buffers = [{ byteLength: bin.length }];
      json.bufferViews = bufferViews;
      json.accessors = accessors;
      let j = Buffer.from(JSON.stringify(json));
      j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
      const b = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
      const h = Buffer.alloc(12);
      h.writeUInt32LE(0x46546c67, 0);
      h.writeUInt32LE(2, 4);
      h.writeUInt32LE(12 + 8 + j.length + 8 + b.length, 8);
      const jh = Buffer.alloc(8);
      jh.writeUInt32LE(j.length, 0);
      jh.writeUInt32LE(0x4e4f534a, 4);
      const bh = Buffer.alloc(8);
      bh.writeUInt32LE(b.length, 0);
      bh.writeUInt32LE(0x004e4942, 4);
      return Buffer.concat([h, jh, j, bh, b]);
    },
  };
}

// --- the body -------------------------------------------------------------------

// the face shapes kept, by VRoid name; expressions below are rebuilt on them
const SHAPES = [
  "Fcl_EYE_Close",
  "Fcl_EYE_Close_L",
  "Fcl_EYE_Close_R",
  "Fcl_MTH_A",
  "Fcl_MTH_I",
  "Fcl_MTH_U",
  "Fcl_MTH_E",
  "Fcl_MTH_O",
  "Fcl_ALL_Joy",
  "Fcl_ALL_Fun",
  "Fcl_ALL_Sorrow",
  "Fcl_ALL_Surprised",
  "Fcl_ALL_Angry",
  "Fcl_BRW_Surprised",
];

function packBody(g) {
  const j = g.json;
  const w = glbWriter();
  const vrm = j.extensions.VRMC_vrm;
  const short = (n) => n.replace(/^.*\./, "");

  const tex = {};
  const materials = j.materials.map((m) => {
    const t = m.pbrMetallicRoughness?.baseColorTexture;
    if (t) {
      const im = j.images[j.textures[t.index].source];
      const v = j.bufferViews[im.bufferView];
      const bytes = g.bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
      tex[m.name] = `data:${im.mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
    }
    return { name: m.name };
  });

  const shapeIndex = {}; // old index -> new index, per mesh
  const meshes = j.meshes.map((m, mi) => {
    const names = (m.extras?.targetNames ?? []).map(short);
    const keep = SHAPES.map((s) => names.indexOf(s)).filter((i) => i >= 0);
    shapeIndex[mi] = Object.fromEntries(keep.map((old, k) => [old, k]));
    const out = {
      name: m.name,
      primitives: m.primitives.map((p) => {
        const attributes = {};
        for (const [k, type, ct, target] of [
          ["POSITION", "VEC3", 5126, 34962],
          ["NORMAL", "VEC3", 5126, 34962],
          ["TEXCOORD_0", "VEC2", 5126, 34962],
          ["JOINTS_0", "VEC4", null, 34962],
          ["WEIGHTS_0", "VEC4", 5126, 34962],
        ]) {
          const ai = p.attributes[k];
          if (ai == null) continue;
          const arr = readAccessor(g, ai);
          const comp = ct ?? j.accessors[ai].componentType;
          attributes[k] = w.add(arr, type, comp, target, k === "POSITION");
        }
        const ia = readAccessor(g, p.indices);
        const prim = {
          attributes,
          indices: w.add(ia, "SCALAR", j.accessors[p.indices].componentType, 34963),
          material: p.material,
        };
        if (keep.length && p.targets) {
          prim.targets = keep.map((old) => ({
            POSITION: w.add(readAccessor(g, p.targets[old].POSITION), "VEC3", 5126, 34962, true),
          }));
        }
        return prim;
      }),
    };
    if (keep.length) out.extras = { targetNames: keep.map((i) => names[i]) };
    return out;
  });

  const skins = j.skins.map((s) => ({
    joints: s.joints,
    inverseBindMatrices: w.add(readAccessor(g, s.inverseBindMatrices), "MAT4", 5126),
    ...(s.skeleton != null ? { skeleton: s.skeleton } : {}),
  }));

  const nodes = j.nodes.map((n) => {
    const { extensions, extras, ...c } = n;
    return c;
  });

  const glb = w.finish({
    asset: { version: "2.0", generator: "kikoe build-body" },
    scene: j.scene ?? 0,
    scenes: j.scenes,
    nodes,
    meshes,
    materials,
    skins,
  });

  // what the hologram needs from the VRM extensions, by node name
  const nn = (i) => j.nodes[i].name;
  const humanoid = Object.fromEntries(
    Object.entries(vrm.humanoid.humanBones).map(([k, v]) => [k, nn(v.node)]),
  );
  const expressions = {};
  for (const [k, e] of Object.entries(vrm.expressions.preset)) {
    const binds = (e.morphTargetBinds ?? [])
      .map((b) => {
        const mesh = j.nodes[b.node].mesh;
        const idx = shapeIndex[mesh]?.[b.index];
        return idx == null ? null : [j.meshes[mesh].name, idx, b.weight];
      })
      .filter(Boolean);
    if (binds.length) expressions[k] = binds;
  }
  const sb = j.extensions.VRMC_springBone;
  const springs = sb.springs.map((s) => ({
    name: s.name,
    joints: s.joints.map((jt) => ({
      node: nn(jt.node),
      stiffness: jt.stiffness ?? 1,
      gravityPower: jt.gravityPower ?? 0,
      gravityDir: jt.gravityDir ?? [0, -1, 0],
      dragForce: jt.dragForce ?? 0.5,
      hitRadius: jt.hitRadius ?? 0,
    })),
    colliders: (s.colliderGroups ?? []).flatMap((gi) => sb.colliderGroups[gi].colliders),
  }));
  const colliders = sb.colliders.map((c) => ({ node: nn(c.node), ...c.shape }));
  const constraints = j.nodes
    .map((n) => [n.name, n.extensions?.VRMC_node_constraint?.constraint])
    .filter(([, c]) => c)
    .map(([name, c]) => {
      const [kind, v] = Object.entries(c)[0];
      return {
        node: name,
        kind,
        source: nn(v.source),
        axis: v.aimAxis ?? v.rollAxis,
        weight: v.weight ?? 1,
      };
    });
  return { glb, tex, humanoid, expressions, springs, colliders, constraints };
}

// --- the moves: rotation tracks by bone name, and the rig they were made on -----

const round = (x) => Math.round(x * 10000) / 10000;

function moves(g, names) {
  const j = g.json;
  const clips = {};
  for (const a of j.animations) {
    if (!names.includes(a.name)) continue;
    const tracks = [];
    let duration = 0;
    for (const ch of a.channels) {
      if (ch.target.path !== "rotation") continue;
      const name = j.nodes[ch.target.node].name;
      if (/Hand(Thumb|Index|Middle|Ring|Pinky)/.test(name)) continue; // the body keeps its own fingers
      const s = a.samplers[ch.sampler];
      const times = Array.from(readAccessor(g, s.input), round);
      duration = Math.max(duration, times[times.length - 1]);
      tracks.push([name, times, Array.from(readAccessor(g, s.output), round)]);
    }
    clips[a.name] = { duration, tracks };
  }
  // the source rig: each mixamorig node's parent and rest rotation, so the
  // moves can be played on it and read back in world space
  const parent = {};
  j.nodes.forEach((n, i) => {
    for (const c of n.children ?? []) parent[c] = i;
  });
  const rig = j.nodes
    .map((n, i) => [n, i])
    .filter(([n]) => n.name?.startsWith("mixamorig:"))
    .map(([n, i]) => ({
      name: n.name,
      parent:
        parent[i] != null && j.nodes[parent[i]].name.startsWith("mixamorig:")
          ? j.nodes[parent[i]].name
          : null,
      q: n.rotation ?? [0, 0, 0, 1],
      t: n.translation ?? [0, 0, 0],
    }));
  return { clips, rig };
}

const body = packBody(readGlb(path.join(models, "body.vrm")));
const m = moves(readGlb(path.join(models, "Xbot.glb")), ["idle", "agree", "headShake", "sad_pose"]);

const data = `/*! Kik's hologram body. Generated by scripts/build-body.mjs; do not edit.
 Body: VRM1_Constraint_Twist_Sample, (c) 2022 pixiv Inc., VRM Public License 1.0
 (redistribution, modification and commercial use allowed; credit not required).
 Moves: X Bot, a Mixamo character as shipped in the three.js examples. */
window.KIK_BODY = ${JSON.stringify({
  glb: body.glb.toString("base64"),
  tex: body.tex,
  humanoid: body.humanoid,
  expressions: body.expressions,
  springs: body.springs,
  colliders: body.colliders,
  constraints: body.constraints,
  moves: m.clips,
  rig: m.rig,
})};
`;
writeFileSync(path.join(vendor, "kik-body.js"), data);
console.log(
  "kik-body.js",
  (data.length / 1024).toFixed(0),
  "KB; glb",
  (body.glb.length / 1024).toFixed(0),
  "KB; expressions",
  Object.keys(body.expressions).join(" "),
);

// --- three.js and the addons, one IIFE ------------------------------------------

const threeDir = path.join(threeHome, "node_modules", "three");
const version = JSON.parse(readFileSync(path.join(threeDir, "package.json"), "utf8")).version;
const license = readFileSync(path.join(threeDir, "LICENSE"), "utf8").trim();
await build({
  stdin: {
    contents: `
      export * from "three";
      export { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
      export { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
      export { RenderPass } from "three/addons/postprocessing/RenderPass.js";
      export { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
      export { OutputPass } from "three/addons/postprocessing/OutputPass.js";
    `,
    resolveDir: threeHome,
  },
  bundle: true,
  format: "iife",
  globalName: "KikThree",
  target: "es2020",
  minify: true,
  outfile: path.join(vendor, "three-body.js"),
  banner: {
    js: `/*! three.js ${version} with GLTFLoader and bloom — https://threejs.org\n${license}\n*/`,
  },
  logLevel: "warning",
});
console.log("three-body.js built from three", version);
