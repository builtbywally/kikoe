# Kik's body: the hologram

Asked for 2026-10-13: "build the hologram body for Kik … the Iron Man
effect that it has and the smoothness of it", after K.A.R.A, the assistant
of Augma Imaginarium (Bangkok). This file is what was learned taking theirs
apart, and how ours is built.

## What K.A.R.A is, from its site (augmaimaginarium.com/kara)

"K.A.R.A" names five different things, and only some of them are AI:

- **The assistant**, on a Mac and a phone: "Hey Kara" wakes it on both. It
  knows when you have finished speaking and speaks sentence by sentence
  while it is still generating. Claude is its main model, with a local model
  as a fallback.
- **The desk**: a morning brief (calendar, overnight messages, sleep,
  weather) and five tabs (Home, Life, Comms, Work, You) drawn from real data
  only. One inbox for Mail, Messages, Telegram, Slack, Discord, WhatsApp and
  LINE. Its own to-do list with spoken reminders. An Ultrahuman ring, and a
  keyboard key that calls her. Topic cards slide in over the sphere as she
  answers.
- **The red sphere** on the page is not WebGL. `/kara/engine.js` (436 KB,
  readable) draws 3D on a 2D canvas by hand. Fibonacci-sphere "neurons" sit
  on five shells named for a language model's parts (EMBED, ATTN, MLP, RESID,
  LOGITS), from a seeded random generator. Links to each point's two nearest
  neighbours are drawn only while a firing wave passes, with arcs, ribbons,
  ring layers carrying "code", and data blocks arriving. The callouts ("KV
  CACHE · 8,192 TOKENS HELD") are decoration. Its house rule: no glow.
- **The hologram body** is not published, only screenshots and a page:
  - a rigged model resampled into 400,000 skinned points that keep the
    texture's shading, a faint wireframe, and a hidden body pass so you
    cannot see through her;
  - idle life (breath, weight shifts, blinks, glances) and eyes that follow
    the pointer;
  - a face moved on the points, with four moods, a speaking rhythm and
    captions;
  - dozens of poses and one-off gestures (wave, bow, nod, shrug);
  - a palm-up hand that opens a data panel;
  - the sphere bursting into her, head first, and back again; dissolve, and
    vanish behind a rising scan line;
  - blue at rest, red and amber for alerts.

  Its debug bar: `SPACE sphere↔human · D dissolve · V vanish · R reset ·
  M menu · 100.0 ms`.
- **The "Ask me anything" helper** on their site is no model at all. It
  searches the site's own pages, runs a scripted four-question brief, and
  says "I'd rather not guess" when nothing matches.

The flood briefing they publish is Gemini, written every three hours under
six rules, and served as a static `kara.json`.

## How Kik's is built

Files: `packages/app/renderer/room/body.js` (the whole thing, commented at
the top), `body.css` (the stage and the HUD), and two generated files in
`vendor/`:
- `three-body.js` is three.js 0.186 with GLTFLoader and bloom.
- `kik-body.js` is the body. It is about 6 MB, so the Room loads all three
  the first time the body is opened (`showBody()` in `room.js`), never at
  start.

Rebuild both with `node scripts/build-body.mjs <models dir> [<dir with
node_modules/three>]`. The models dir holds:
- `body.vrm`: pixiv's `VRM1_Constraint_Twist_Sample` from the three-vrm
  repository. Its VRM licence allows redistribution, modification and
  commercial use, and needs no credit.
- `Xbot.glb`: Mixamo's X Bot from the three.js examples, for its moves.

The pipeline, in order:

1. **Points.** Every mesh except the face is resampled into 360k points
   (130k on a phone). Triangles are picked by area times a density per
   material kind, and a point on a transparent texel is drawn again, so hair
   reads as strands. Each point keeps the texture's luminance, merged skin
   weights remapped to one shared skeleton, a place on the sphere and its
   height. The face is a second cloud of 44k points that carries 14 VRoid
   face shapes, interpolated per point, so blinks, vowels and moods are the
   real blend shapes.
2. **Drawing.** Each cloud is a `SkinnedMesh` with `isMesh = false` and
   `isPoints = true`: the renderer skins anything that is a SkinnedMesh and
   draws GL_POINTS for anything that is isPoints. It is bound at the frame's
   world matrix, as GLTFLoader binds a mesh. The original meshes stay as a
   depth-only "hidden body", so you cannot see through her (hair is left
   out). A wireframe sits on top at 1.6 % opacity.
3. **Motion, every frame:**
   - the Mixamo clips play on their own rig, and each bone's change from
     rest is copied onto ours in world space, because the two rigs' bone
     axes differ;
   - then the procedural layers, as rotations about world axes: breath, the
     weight on one leg, glances, the head following the pointer (the eyes
     get there first), a pose for the state, a gesture;
   - then the sleeve aim constraints;
   - then the spring bones for hair and skirt (VRMC_springBone, spheres and
     capsules).

   Every value goes through a critically damped spring or exponential damp,
   so nothing snaps.
4. **Mouth.** The line being said is read letter by letter at 14.5 a second.
   A vowel opens its viseme (aa, ee, ih, oh, ou) and a consonant nearly
   closes the mouth. The caption lights each word when the mouth reaches it.
5. **Light:**
   - additive dots, brighter where the surface turns away (the rim), with
     flicker;
   - a scan line up her body every 7 to 12 seconds, and a glitch slice now
     and then;
   - a floor projector of dashed, turning rings with a pulse, a faint light
     cone, and drifting dust;
   - bloom, 0.55 strength.

   The tint follows Kik's state: blue idle, cyan listening, violet
   thinking, amber when it needs you, red when something failed.
6. **Sphere and body are the same points.** `uMorph` sends each point from
   its sphere place to its body place. A point leaves when the wave reaches
   its height (head first) and bursts outward on the way. Dissolve and
   vanish work the same way. On open she holds as a sphere for 1.1 seconds,
   forms, then waves.

What drives her from the Room:
- `setOrb()` passes the state: listening tilts her head toward you and
  tracks you; thinking puts a hand to her chin; asking raises the presenting
  hand and turns her amber.
- `speech` passes the line, which drives the mouth and the caption.
- "heard you" plays the nod clip, and "not for me" a shrug.
- `holo.panel({...})` opens the panel above her hand. Nothing calls it yet.

Keys while the view is open: space (sphere ↔ body), d (dissolve),
v (vanish), r (reset), w (wave); drag to turn her. K or the "kik" button in
the title bar opens and closes the view. The HUD shows the frame time. If
frames average over 24 ms, the body cloud draws fewer points; the points
were drawn at random, so any prefix is an even subset.

## Gotchas found building it

- **RenderPass into the composer's half-float target lost the clear
  colour,** and the stage came out grey. Use `scene.background`, not
  `setClearColor`.
- **GLTFLoader loads embedded images through blob: URLs,** which the Room's
  content security policy refuses. The build moves the base colour images out
  of the GLB as data: URLs, and body.js samples them on a canvas.
- **Pose axes.** An arm hanging down bends forward at the elbow about -x.
  An arm held out to the side lifts about z: -z for her right arm, +z for
  her left. Turning a hanging forearm about y only twists it.
- **Electron and arguments.** Electron run with an `http://` URL as a script
  argument exited 127 here. The capture scripts read their arguments from a
  JSON file instead.

## Not done yet

- Nothing calls the panel yet. An agent's status or test counts are the
  natural first use.
- The phone does not load her.
- The mouth follows the text, not the audio. Driving it from the TTS
  audio's level would match Kik's real timing.
- K.A.R.A has dozens of poses with an auto mode; Kik has three poses and
  three gestures.
