# The K.A.R.A experience for Kik: the plan

Asked for 2026-10-13: "I want the K.A.R.A experience exactly." The source
material is three things:
- K.A.R.A's site (augmaimaginarium.com/kara and its project pages);
- the shipped JavaScript of that site;
- its maker's reel ("A Weekend with K.A.R.A's AI Ecosystem", @tonythetechie,
  2026-10-07).

`docs/HOLOGRAM.md` has the site taken apart. This file is the whole
experience, piece by piece: what Kik has, what is missing, and the order to
build it in.

## What the experience is, seen in the reel

One assistant, seen on every surface in the room:

1. **The hologram.** A woman of light with a bob, a fitted dress and heels.
   - She forms out of a sphere and runs at 60 fps.
   - **Moods:** neutral, happy, concerned, thinking.
   - **Modes:** speak, sphere, auto, idle, hover (sitting in the air), talk,
     present right, present left, operate.
   - A live briefing panel opens above her palm.
   - Rings mark where her eyes look in close-up.
   - Red for alerts.
2. **The desk on the TV.** A wall-sized hot-pink dashboard:
   - her neuron sphere in the centre and glowing ribbons along the bottom;
   - Home, Life, Comms, Work and You tabs, with weather, air, health and
     the day as glowing line charts;
   - a city map;
   - topic cards that slide in over the sphere as she answers.
3. **The Holo Keyboard.** A curved, arc-shaped command keyboard on an iPad.
   File Management, New, Open, Save, Copy, Paste, Stack, Return, and a KARA
   key that calls her.
4. **Holo-Explorer.** A 3D object over the webcam feed, moved with bare
   hands:
   - pinch and hold for a menu; a fist moves it; flick a finger to spin it;
   - pull two fists apart to explode it, pinch a part to pull it out, clap
     to reassemble it;
   - mirror, depth, black-and-white and dim toggles.
5. **The phone and the watch.** A K.A.R.A app on a flip phone with a talk
   orb, and a K.A.R.A face on an Apple Watch.
6. **The life behind it.**
   - A morning brief: calendar, overnight messages, sleep, weather.
   - One inbox for Mail, Messages, Telegram, Slack, Discord, WhatsApp and
     LINE.
   - Her own to-dos with spoken reminders.
   - A health ring for sleep, HRV, heart rate and steps; GitHub.
   - "Hey Kara" wakes her on the Mac and the phone. She speaks sentence by
     sentence while still thinking. Claude is the main model, with a local
     fallback.

## Where Kik stands against it

| K.A.R.A | Kik today | Gap |
|---|---|---|
| Hologram body, morph, dissolve, vanish, idle life, wave, panel | Built 2026-10-13 (`body.js`) | Figure looks young; 3 poses not 9 modes; no mood buttons, auto mode, hover, operate or gaze rings; nothing feeds the panel; mouth follows text, not audio |
| Desk on the TV | The Room: board, cards, agents, a dotted orb | No life dashboard, no tabs, no sphere-centred layout, no pink look |
| Neuron sphere | thinking-orbs (2D dots) | No layered neuron sphere |
| Holo Keyboard | None | All of it |
| Holo-Explorer (hand gestures) | None | All of it |
| Phone app | Phone page with talk orb, voice, cards | Close; no home dashboard on the phone |
| Watch face | None | Needs a native watch app |
| Morning brief, calendar | Built (`morning()`, `refreshAgenda`) | None |
| Mail, Drive, Docs | Jev `desk` action | Read-only, one place |
| Telegram, Slack, Discord, WhatsApp, LINE, Messages | None | All of it |
| To-dos and spoken reminders | `reminders.ts` | No to-do list of its own, no card |
| Weather | One-off look-up (`lookup.ts`) | No standing weather panel |
| Health ring | None | All of it |
| GitHub | Browse and agents | No issues and PRs panel |
| Wake word | Name gate through Whisper; push to talk | No real wake-word model, on desktop or phone |
| Sentence streaming, endpointing | Built | None |
| Claude main, local fallback | Claude; Piper and Kokoro voices local | No local model for the mind |
| Voice | Piper/Kokoro (fixed 2026-10-13); ElevenLabs refusing on a billing error | Pay the ElevenLabs invoice, or pick a local voice as the default |

## The plan, in order of how much of the feeling each buys

Each phase ships on its own, with the usual loop (tests, lint, typecheck,
screenshot, a spoken line, commit, installer). It is done when the
acceptance line is true on this machine.

### Phase 1: She looks and moves like K.A.R.A (the hologram, finished) — built 2026-10-13, except the new body (waiting on decision 1)

1. **Her body.** The figure is the one thing code cannot fix.
   - **Recommended:** make her in **VRoid Studio** (free, about 20 minutes):
     an adult, a bob, a fitted dress, heels. Export it as VRM.
     `scripts/build-body.mjs` takes a VRM as it is, face shapes and hair
     physics included.
   - **Fallback:** a CC-BY rigged woman from Sketchfab, with a small Mixamo
     bone map.
2. **Moods:** neutral, happy, concerned, thinking.
   - Each is a face-shape mix plus a posture (concerned: brows up, head
     forward, hands together) plus a tint.
   - Driven by Kik's state, by what the brain says (a mood tag on each
     line), and by a button row like K.A.R.A's.
3. **Modes:** idle, talk, speak, sphere, hover, present right, present
   left, operate, auto.
   - Hover is a seated pose floating in the air with a slow bob.
   - Operate is both hands working a panel in front of her.
   - Auto cycles the poses every 8 to 15 seconds while idle.
   - Blending stays on springs.
4. **Gaze rings.** Two thin rings track her eyes in close-up. Add a
   close-up camera, on double-click and while she speaks for long.
5. **The panel is fed.** When Kik speaks about an agent, its status, test
   counts and diff stats appear above her palm. The morning brief raises
   the weather and the day.
6. **The mouth follows the sound.** The speaker posts the level of what it
   plays (as the mic already does) and the jaw follows it. The visemes stay
   for vowel shape.
7. **Pose authoring.** A small pose file and a debug key to capture the
   current pose, so new poses are data, not code.

**Acceptance:** side by side with the reel, she reads as the same kind of
being. A visitor names her mood without being told. She is never still.
No frame is over 17 ms on this machine.

### Phase 2: The desk on the TV (K.A.R.A's pink dashboard) — built 2026-10-13

1. **A desk view in the Room** (and full-screen on a second display, via
   the existing viewer link), sphere-centred:
   - a neuron sphere, our own, after `engine.js`: shells, firing waves,
     arcs, rings;
   - ribbons of particles along the bottom;
   - a dock with Home, Life, Comms, Work and You.
2. **Panels from real data only:**
   - Home: weather, air, the day;
   - Life: health, to-dos;
   - Comms: the unified inbox;
   - Work: agents, PRs, CI;
   - You: sleep and activity.
   - Glowing line charts in the dataviz palette.
3. **Topic cards slide in over the sphere** as Kik answers. This reuses the
   board's card kinds.
4. **A look switch:** ember (Kikoe's) or neon (K.A.R.A's magenta). The
   hologram tint and the desk follow it.
5. **A city map panel** (MapLibre and OpenFreeMap, no key) for anything
   with a place in it.

**Acceptance:** on the TV from across the room, it reads at a glance, and
it updates without a touch for a day.

### Phase 3: She hears her name anywhere (voice parity) — built 2026-10-13 on the desktop; the phone keeps hold-to-talk; no local mind (the user keeps the Claude Code subscription)

1. **A real wake word, "Hey Kik"**: openWakeWord or the sherpa-onnx keyword
   spotter, local, on the desktop. The phone page uses the same model in the
   browser (ONNX Runtime Web), or hold to talk.
2. **A local fallback for the mind:** Ollama with a small model when Claude
   is unreachable, said out loud once ("I'm on my own model for now").
3. **The default voice is local and good.** Kokoro first, and ElevenLabs
   only when its account answers. A billing refusal demotes it for the day
   instead of being retried on every line.

**Acceptance:** "Hey Kik" from the sofa works nine times in ten, and never
wakes her during a film. The network unplugged still gets an answer.

### Phase 4: Her life (the integrations) — built 2026-10-13: to-dos, GitHub, Mail, Slack, Telegram, Discord, WhatsApp, the ring; LINE has no personal API, iMessage not wanted

1. **One inbox:**
   - Gmail is in.
   - Slack, Discord and Telegram through their bot and user APIs.
   - LINE through the Messaging API.
   - WhatsApp through WhatsApp Web (whatsapp-web.js), linked by QR, local
     only.
   - iMessage needs a Mac; on Windows it is not possible and is left out.
   - Spoken as "three new: two from Slack, one from your mother", read on
     request, answered by voice with confirmation.
2. **Her own to-do list:** a card and a desk panel. Reminders are spoken,
   and pushed to the phone (ntfy is already wired).
3. **Health:** the Ultrahuman ring API, or Oura's. Sleep, recovery, HRV
   and steps go into the morning brief and the You tab.
4. **Weather and air,** a standing panel (Open-Meteo, no key).
5. **GitHub:** PRs waiting on you, CI red or green, on the Work tab and
   spoken when they change.

**Acceptance:** the morning brief covers calendar, messages, sleep and
weather in under 30 seconds, every morning, unasked.

### Phase 5: The Holo Keyboard — built 2026-10-13

A page the daemon serves to a tablet or phone (like the phone page):
- the arc layout, glowing, with command keys: new, open, save, copy, paste,
  stack, return, file management;
- a mode key that turns it into a QWERTY arc;
- a KIK key that opens the mic.

Keys send verbs to the daemon (the `verbs` already exist), so "stack" stacks
the board and "save" keeps the card in focus.

**Acceptance:** the Room can be driven for ten minutes from the tablet
alone.

### Phase 6: Holo-Explorer (hand gestures over the camera) — built 2026-10-13; gestures not yet tried with real hands

- **The tracking:** MediaPipe Tasks hand landmarker in the Room,
  WebGL/WASM, local, about 30 fps.
- **The scene:** the hologram, or any 3D card, over the webcam feed, with
  mirror, depth, black-and-white and dim toggles.
- **The gestures, as K.A.R.A has them:**
  - pinch and hold: a menu;
  - fist: move;
  - point and flick: spin;
  - two fists apart, or palms together then apart: explode;
  - pinch a part: pull it out;
  - clap: assemble.
- **For Kik:** the same gestures move and spin her, and swipe board cards.

**Acceptance:** with no mouse, explode and reassemble her, and spin her,
on the first try, in ordinary room light.

### Phase 7: The phone and the watch

1. **The phone page gets a home:** her bust as the talk button, the day
   in cards, the inbox and to-dos.
2. **The watch face needs native code.** Apple Watch needs Xcode on a Mac;
   Wear OS needs Android Studio. Until then, a phone home-screen widget
   through the PWA is the closest. **Decision needed.**

## Decisions only you can make

1. **Her body:** make her in VRoid Studio (recommended), or buy or download
   a rigged woman.
2. **Her colour:** K.A.R.A's neon magenta, Kikoe's ember, or a switch.
3. **The TV:** which display the desk lives on.
4. **Accounts:** which messengers to connect first; whether you have an
   Ultrahuman or Oura ring; whether to pay the ElevenLabs invoice.
5. **The watch:** Apple or Android, and whether a Mac is available.

## Order and size

| Phase | Size | Starts |
|---|---|---|
| 1. Hologram finished | 2–3 days | now |
| 2. Desk on the TV | 3–4 days | after 1 |
| 3. Voice parity | 2–3 days | in parallel with 2 |
| 4. Integrations | a week (one messenger a day) | after 3 |
| 5. Holo Keyboard | 1–2 days | any time |
| 6. Holo-Explorer | 2–3 days | after 1 |
| 7. Phone and watch | 2 days, plus native if chosen | last |
