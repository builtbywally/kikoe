# Everything you might ask Kikoe, and what happens

Written 2026-09-24 against commit `23c0fe7`, which includes the hands
(`cb33d89`: `daemon/src/hands.ts`, seven tools in `brainTools()`, behind the
`hands` setting, off by default and off on your install). The goal it measures
against is yours, in your words: *"I need to be able to use Kikoe to the
extent of not using my computer any more — Kikoe runs everything for me."*

Every route below was checked in the code: `core/src/router.ts` (reflexes),
`daemon/src/jev.ts` (the switchboard), `daemon/src/daemon.ts` (`dispatch`,
`carryOut`, `brainTools`), `pc.ts`, `capability.ts`, `hands.ts`, `walkie.ts`,
`agents.ts`, `work.ts`. Every ★ was checked in `~/.kikoe/logs/daemon.log`
(759 routed sentences, 96 of them from the phone, 2026-09-05 to 2026-09-24).
Only your spoken sentences and the routing lines are quoted; no key, token
or file content.

## 1. How to read this

Each request is one row.

| column | what it says |
|---|---|
| **#** | an id, so the plan in section 5 can point at rows |
| **Example phrasing** | how you would say it, short. ★ means you said it (or a sentence very like it) and it is in the log, quoted as heard |
| **Route** | where it goes today, or would go |
| **Grade** | `read`, `write` or `irreversible`, as `capability.ts` would grade it |
| **Status** | `works`, `partial`, `broken` or `missing` |
| **Gap or note** | what is wrong or needed, in one line |

**Routes.**

- **reflex**: a control word in `router.ts` (`CONTROLS`, yes/no, hello). Instant, no model, never reaches an agent.
- **Jev→kik / think / agent / new_session / open / canvas / stop_agent**: the switchboard's seven actions. `kik` means the talking session (Haiku) answers, and may call its tools.
- **Kik tool `name`**: one of the talking session's tools (below).
- **hands (L1) `name`**: one of the seven hands tools, committed in `cb33d89` and offered to Kik only when the `hands` setting is on: `list_windows`, `read_window`, `focus_window`, `open_app`, `type_text`, `press_keys`, `press_button`. Jev decides first, so a sentence Jev sends to `open` never reaches them.
- **agent + connector X**: the coding agent (Claude Code in a project folder) with one of your connectors. Your Claude Code has Gmail, Google Calendar, Google Drive, Dolmapp, Figma, Supabase, Vercel, runnn-ing, Twelve Data and CoinGecko connected, and Slack, Canva, Zoom, QuickBooks, Xero and others listed but not signed in. **Kik's own sessions cannot use any of them**: `codebrain.ts` starts them with `--strict-mcp-config` and `--tools ""`. Only an agent session can, and whether the claude.ai connectors load under `claude -p` has not been tested.
- **connector needed**: nothing you have connects to it.
- **not possible**: ruled out by a decision, not by missing work.

**Kik's tools today** (committed, `brainTools()`): `think_deeply`, `approve`,
`deny`, `answer_board`, `instruct_agent`, `create_artifact`,
`design_artifact`, `update_artifact`, `read_board`, `remove_artifact`,
`start_agent`, `open_project`, `point_at`, `ask_user`, `remember`, `forget`,
`set_mode`, `clear_board`, `pin_note` — nineteen. With hands on, seven more.

**Grades.** `capability.ts` grades only Kik's hands today: a read is free, a
write is asked aloud (a yes to one app stands for two minutes), and anything
whose words say delete, send, post, publish, pay, order, shut down and the
like is `irreversible`: asked every time and never allowed ahead. Two things
sit outside it and the table says so where it matters: changes inside Kikoe
(cards, memory) are writes nobody is asked about, and the coding agent's own
actions are gated by Claude Code's permission prompt, which reaches you by
voice, not by `capability.ts`. The fixed "open" menu (`pc.ts`) is not asked
either, though a launch is a write.

**Statuses.**

- **works**: does it today through the installed app.
- **partial**: does some of it, only on one screen, slowly, or with a wrong turn on the way.
- **broken**: a path exists and does the wrong thing.
- **missing**: nothing handles it. Kik can talk about it and that is all.

## 2. The request catalogue

### 2.1 Talking to Kik

| # | Example phrasing | Route | Grade | Status | Gap or note |
|---|---|---|---|---|---|
| T1 | ★ "Hey Kiko, how are you?" | reflex (social) → talking session | read | works | The rules answer a hello when there is no model |
| T2 | ★ "What's 2+2?" / "Can you give me the answer of 10 plus 10?" | Jev→kik | read | works | Jev kik 0.99–1.00, answer in ~1 s |
| T3 | ★ "What time is it?" | Jev→kik | read | works | The local time rides in the live picture |
| T4 | ★ "What's the weather like?" … "and what about tomorrow?" | Jev→kik | read | works | `look_up` (weather): open-meteo, keyless; now, today and tomorrow in a sentence (09-24) |
| T5 | ★ "In terms of UI/UX, what do you think about the way that dashboard looks?" | Jev→kik | read | partial | Kik cannot see your screen or a site; it knows the code of cards it made, not how they render |
| T6 | ★ "What is your name?" / "Tell me about yourself." | Jev→kik | read | works | |
| T7 | "Explain how Tailscale works" (general knowledge) | Jev→kik | read | works | From the model's knowledge only |
| T8 | ★ "What do you mean let me look into that?" | Jev→kik | read | works | Asides (fillers, landed thoughts) are passed to the talking session since 2026-09-23 |
| T9 | ★ "Repeat" / "say that again" | reflex `repeat` | read | works | |
| T10 | ★ "Stop" / "quiet" / "shut up" | reflex `stop` | read | works | Stops Kik's voice, not the agent |
| T11 | "Hold on" / "wait" | reflex `pause` | read | works | ★ Also fired on game audio: "Wait, I'm a che- I'm a chew!…" paused Kik (09-09) |
| T12 | ★ "Go verbose" / "quieter" | reflex `mode` | read | works | |
| T13 | ★ "No thats wrong, I ship on thursdays not fridays" | Jev→kik → `forget` + `remember` | write | works | The correction rule tells Kik to fix its notes |
| T14 | "Carry on, what were you saying?" | — | read | missing | A line cut off by barge-in is lost (AUDIT 6, item 10) |
| T15 | ★ "How well can you hear me? Can you do a test?" | Jev→kik | read | partial | Kik cannot read the mic level or what Whisper heard; the doctor shows it on screen only |
| T16 | "What did you hear me say just now?" | — | read | missing | The heard log is in the Control Room only |
| T17 | ★ "What are you thinking about right now" | Jev→kik (inner note) | read | works | |
| T18 | ★ "I want you to be autonomous, but ask for my permission" | Jev→kik | read | partial | No autonomy setting; the permission gate and the watchers are the whole of it |
| T19 | ★ "I want you to edit yourself actually, could you do that?" | Jev→agent in kikoe | write | works | Kik does not volunteer that it can; the agent in the kikoe repo does the edit |
| T20 | ★ "quieter and with a twist of sass" | Jev→kik → `remember` | write | partial | No persona setting by voice; only a remembered preference |
| T21 | "Talk to me in Turkish" | Jev→kik | read | partial | ElevenLabs can speak it; the ear logs foreign speech as "(speaking in foreign language)", so Kik cannot hear Turkish or Arabic |
| T22 | "Be quiet until I say your name" (shared room) | Settings | read | partial | `shared_room` is a setting, not a voice command |
| T23 | ★ "So basically what you're saying is I should be investing with you…" (a call, not Kik) | Jev directed / "you" rule | read | broken | Any nameless sentence with "you" in it is addressed without asking Jev (`YOU_QUESTION`); see section 3, E1 |

### 2.2 The coding agents

| # | Example phrasing | Route | Grade | Status | Gap or note |
|---|---|---|---|---|---|
| A1 | ★ "add a retry to the token refresh" | Jev→agent | write | works | Idle agent: straight in. Busy: queued for its turn end. Mostly the screenshot harness in the log |
| A2 | ★ "open a new claude session in ClaudeTalks and tell it to reply with the single word ready" | Jev→new_session | write | works | new_session 0.97, ClaudeTalks 0.84, started 16 ms later |
| A3 | ★ "kik, in kikoe, create a file called HELLO-FROM-KIK.txt containing the single word hello" | Jev→agent (project named) | write | works | |
| A4 | ★ "Kiko, go build that please. Tell the agent to do it." | Kik tool `instruct_agent` | write | works | Kik writes the brief from the conversation |
| A5 | "Start a session in Billiar and fix the login bug" | Jev→new_session | write | works | A project heard under 0.5 gets "which project, X or Y?" |
| A6 | ★ "What is the agent doing right now?" | Jev→kik (tracker) | read | works | |
| A7 | ★ "kik, did the tests pass" | Jev→kik / rulebook | read | works | From hooks; the rulebook knows it with no model |
| A8 | ★ "kik, is anything waiting on me" | Jev→kik | read | works | |
| A9 | ★ "What sessions are they right now?" / "What is currently running?" | Jev→kik | read | works | |
| A10 | "Stop the agent" | reflex `agent` / Jev→stop_agent | write | works | Only stops runs Kik started, not a terminal session you opened |
| A11 | "Pause the agent for a minute" | — | write | missing | Only stop; "pause" pauses Kik's voice |
| A12 | "Yes" / "go ahead" to a permission | reflex answer | write | works | Bound to the right question before it is spoken |
| A13 | "No" / "deny" | reflex answer | read | works | |
| A14 | "Always allow that one" | — | write | missing | No voice path to Claude Code's allowlist; never for irreversible by rule |
| A15 | ★ "kik, what number did I ask you to remember just now" (said to the agent) | Jev→kik | read | works | The last job handed to each agent is kept and shown to Jev and Kik (`toldLine`, 09-24) |
| A16 | "Tell it to also add tests" (agent busy) | Jev→agent (queued) | write | partial | Works, but nothing on the canvas shows a queued instruction (AUDIT 6) |
| A17 | "What did it say?" / "read me its reply" | Jev→kik | read | partial | Kik has the narration and the reply card; long replies are not read out whole |
| A18 | "Read me the diff" | — | read | works | `work_card` read: the latest diff or run card, read back by Kik (09-24) |
| A19 | "Explain the change to api.ts" | card button `explain` / Jev→agent | read | partial | The button works; by voice it reaches the agent only as a new instruction |
| A20 | "Revert that file" | card button `revert` | write | works | `work_card` revert, by voice, still an instruction to the agent (09-24) |
| A21 | "Run that again" | card button `again` | write | partial | Button only |
| A22 | "Apply hunks two and four" | — | write | missing | |
| A23 | "Run the tests in kikoe" | Jev→agent | write | works | Result lands as a test card |
| A24 | "Commit this with a good message" | Jev→agent | write | works | Claude Code asks if git is not allowed |
| A25 | "Push it" | Jev→agent | write | works | `capability.ts` grades a plain push as write (only "force push" is irreversible); Claude Code's prompt decides |
| A26 | "Open a PR for this" | Jev→agent (gh) | write | works | If `gh` is signed in |
| A27 | "Review the PR on storefront" | Jev→agent | read | partial | The agent can; there is no PR card or voice summary shape |
| A28 | "Deploy the Walnut website" | Jev→agent + connector Vercel | irreversible | partial | The agent can deploy; the grade is Claude Code's, not Kikoe's; untested |
| A29 | "Why did the Vercel build fail?" | Jev→agent + connector Vercel | read | partial | Untested |
| A30 | "Add a column to the Dolma users table" | Jev→agent + connector Supabase | irreversible | partial | A migration can drop data; no Dolma project is registered yet |
| A31 | "What changed in kikoe today?" | Jev→agent | read | works | 15–40 s for an agent turn |
| A32 | ★ "kik, switch to marine" / ★ "Kick switch to billier" | reflex `focus` | read | works | Fuzzy match on the name |
| A33 | ★ "I need you to switch to Kiko" | Jev→kik → `open_project` | read | partial | The reflex wants the verb first; the long form takes a model turn (in 09-07 it did nothing) |
| A34 | "Open kikoe in VS Code" | Jev→open (vscode) | write | works | |
| A35 | "A terminal in billiar" | Jev→open (terminal) | write | works | |
| A36 | "Open marine's folder" | Jev→open (explorer) | write | works | Project folders only |
| A37 | "Run the dev server and put it on the canvas" | Jev→agent, then canvas | write | partial | One action per sentence: the second half is dropped |
| A38 | ★ "open the both projects that are currently in the local host… on the canvas" (3000 and 3001) | Kik tool `create_artifact` (web) | read | works | Desk only; localhost cards are blank on the phone |
| A39 | "Three agents, three repos, this afternoon" | Jev→agent ×3 | write | partial | An instruction with no project goes to the working or last session; Kik guesses |
| A40 | ★ "use Kiko with Open Code, especially if Claude Code has a session limit" | — | write | missing | No OpenCode, Codex or Gemini adapter |
| A41 | "Add Dolma as a project, it's in C:\…" | — | write | missing | A project appears only when a hook arrives from its folder |
| A42 | "Approve it" from the phone by tap | — | write | missing | By voice on the phone it works (A12); a tap does not |

### 2.3 Thinking

| # | Example phrasing | Route | Grade | Status | Gap or note |
|---|---|---|---|---|---|
| K1 | ★ "I need you to really think this through: should Kikoe store its boards in SQLite or keep one JSON file per project…" | Jev→think | read | works | think 0.99, Opus, 24 s, spoken answer and a detail card. At 03:05 the same sentence went to the agent; fixed by 03:11 |
| K2 | "Weigh up Framer against Webflow for this client" | Jev→think | read | partial | No web: model knowledge only |
| K3 | "Make me a plan for the Dolma launch" | Jev→think | read | works | The detail card renders markdown tables as raw text |
| K4 | ★ "I want to research what models can do amazing vector work…" (a new concept) | Jev→agent 0.57 → Kik `start_agent` | read | broken | A research job went into the WM Studio agent's conversation; the thinker has no web tools |
| K5 | "Find out what Quiver AI is and what it costs" | — | read | missing | Needs web search |
| K6 | "Help me price Printly's new service" | Jev→think | read | works | No data of yours to reason from |
| K7 | ★ "I wanted to ask you your opinion on a potential project… a dock management app" | Jev→kik / think | read | partial | Kik could not see the 3D prototype you were showing |
| K8 | "Think about it while I get coffee" | Jev→think | read | works | Answer spoken when it lands |
| K9 | "What did you conclude about the storage question?" | Jev→kik | read | works | The talking session is told when a thought lands |
| K10 | "Cancel that thought" | — | read | missing | An abort controller exists; no voice path |
| K11 | "Think about these three things" | Jev→think | read | partial | Two thoughts at once at most |
| K12 | "Brainstorm names for the vector app" | Jev→kik | read | works | |
| K13 | "Critique the landing page on the canvas" | Jev→think | read | partial | The thinker sees the canvas listing and code, not the render |
| K14 | "Write the proposal for the marina client as a document" | Jev→think | read | partial | Arrives as a markdown card; no .docx or PDF |

### 2.4 The canvas

| # | Example phrasing | Route | Grade | Status | Gap or note |
|---|---|---|---|---|---|
| C1 | ★ "make me a short checklist for shipping kikoe tonight, keep it" | Kik tool `create_artifact` (checklist, sticky) | write | works | |
| C2 | ★ "draw me how the ear talks to the daemon, a diagram, and point at it" | `create_artifact` (diagram) + `point_at` | write | works | |
| C3 | ★ "make me a small standup timer page, two minutes per person with a start button, as an artboard, and annotate it" | `design_artifact` or `create_artifact` (html) + note | write | works | Repeated eight times by the harness on 09-06 |
| C4 | ★ "compare cats and dogs as pets in a visual artifact" | `design_artifact` | write | works | 74 s on Sonnet |
| C5 | ★ "quick sketch of a pomodoro timer page" | `design_artifact` (quick) | write | works | 27 s |
| C6 | ★ "I need you to create an animation where a cat is running after a dog on the canvas." | Jev→agent 0.92 (then) → Jev→kik (now) | write | partial | Went to the WM Studio agent, which wrote a 623-line file there. Kik's criterion fixed in `9f39532`; not tried again yet |
| C7 | ★ "Can you build me a diagram that explains how internet connects to the blockchain and where AI comes in?" | Jev canvas 0.44 → Kik | write | partial | Kik made a diagram and a "quick" design that took 100 s: two cards for one ask |
| C8 | ★ "I wanted to create a logo for a cupcake brand called 'Mamma Mia'. I want the logo feminine and elegant." | Kik `design_artifact` → failed → `create_artifact` (svg) | write | partial | "the designer returned no component"; you: "It's so simple. I don't like it." A logo is a vector, not a React app |
| C9 | ★ "Now create an SVG logo… for walnut" / ★ "Create a logo for me that has the name Molot" | `create_artifact` (svg) | write | partial | Same as C8 |
| C10 | ★ "kikoe clear the board" / ★ "Clear the board" | reflex `board clear` | write | works | Not asked; no undo |
| C11 | ★ "Clear our canvas right now" / ★ "Clear out the canvas" / ★ "Clear the boards." | Jev→kik → `clear_board` | write | partial | The reflex knows "board" only; "canvas" costs a model turn, and Whisper hears it as "cameras" |
| C12 | ★ "Now close all windows that are currently on the board." | Kik `remove_artifact` ×6 | write | broken | Removed a sticky card and the page designed two minutes before; nothing asked, no undo |
| C13 | ★ "close all tabs on the cameras" | Jev→agent 0.32 → Kik `ask_user` | write | broken | Kik offered to start a coding agent "to help with the cameras" |
| C14 | "Undo that" | — | write | missing | `update_artifact` overwrites; no history (AUDIT 8) |
| C15 | "Tidy the board" | — | write | missing | Settle only pushes down |
| C16 | ★ "point me to the interactive element that you created." / ★ "no not this one the other one" | `point_at` | read | works | |
| C17 | ★ "what's on the board right now?" | `read_board` | read | works | |
| C18 | "Find the card about pricing" | `read_board` + `point_at` | read | works | By title and body |
| C19 | "Make it bigger" / "make it an artboard" | `update_artifact` (wide) | write | works | |
| C20 | "Change the headline to…" | `update_artifact` | write | works | Whole body replaced, no history |
| C21 | "Keep that one" | `update_artifact` (sticky) | write | works | Non-sticky cards fade after an hour |
| C22 | ★ "Okay, pin notes to the board here." | `pin_note` | write | partial | A pinned note goes after 15 minutes (`DEFAULT_TTL_S` 900) though the tool says "to read later" |
| C23 | "Put the note beside the page" | `update_artifact` (near) | write | works | |
| C24 | ★ "make an artifact that shows me the difference between cats and dogs." | `create_artifact` (table) | write | works | |
| C25 | "Chart Dolma sign-ups this week" | `design_artifact` (Recharts) | write | partial | No data source reaches Kik |
| C26 | "Mock up the Dolma home screen" | `design_artifact` | write | partial | Does not use Dolma's own tokens and screens (the Dolmapp connector has them) |
| C27 | ★ "I need you to create an artifact presentation about Kiko." | `design_artifact` | write | partial | One page; no slides kind |
| C28 | ★ "Can you create a radio on the workspace?" | `design_artifact` / web card | write | partial | Nothing was made that night; a page with an audio stream would work on the desk |
| C29 | ★ "I need you to pull up a picture from unsplash into the canvas. Give me a picture of a cupcake." | Jev→canvas | read | works | Was picture.com; since 09-24 the Unsplash search. Unsplash will not frame on the phone |
| C30 | "Put this image from my Downloads on the canvas" | — | write | missing | No file or image drop by voice |
| C31 | "Export that card as a PNG" / "as a PDF" | — | write | missing | AUDIT flow 5 |
| C32 | "Send that page to the client" | — | irreversible | missing | Needs export and a mail connector |
| C33 | "Draw a circle round the price" / "arrow from this to that" | — | write | missing | ROADMAP M3 |
| C34 | "What does the page you made say?" | — | read | missing | Kik knows the code, not the render |
| C35 | "Show project marine's board" | Kik `open_project` / reflex | read | works | |
| C36 | "Show me my Walnut tasks as a board" | — | read | missing | Needs the runnn-ing connector |
| C37 | "Make the page work without internet" | — | write | partial | Designed pages need the CDN (AUDIT 9) |

### 2.5 The web

| # | Example phrasing | Route | Grade | Status | Gap or note |
|---|---|---|---|---|---|
| W1 | ★ "Open YouTube." (desk) | Jev→open (website) | write | works | `siteByName` turns the name into youtube.com |
| W2 | ★ "Can you open YouTube here?" / ★ "open up YouTube on the board" | Jev→canvas | read | works | A live web card; from the phone "open" means the canvas |
| W3 | ★ "Now I want you to open YouTube on the canvas and look up for low-fi. Put some chill beats." | Jev→canvas | read | works | The top video's player, which plays on the phone too |
| W4 | ★ "Search lo-fi on YouTube" (after YouTube is open) | Jev→open → the open card | read | works | Reuses the card since `112db30`; used to make a second. Since `23c0fe7` a bare "look up low five" searches the open site too |
| W5 | ★ "Open low-fi mix" | Jev→open 0.61 → canvas low-fi.com | read | broken | Any unknown word after "open" becomes `<word>.com` |
| W6 | ★ "Open youtube.com.com" | Jev→open | write | works | `findUrl` mends the doubled ".com" |
| W7 | ★ "Can you pull up Chrome on my computer and go to YouTube?" (phone) | Jev→open → PC | write | works | Went to the canvas; `wantsThePc` fixed it on 09-24, not tried again |
| W8 | ★ "On the desktop please." (after a card) | Jev→open → the card's site on the PC | write | works | Did nothing on 09-24 at 18:03; fixed the same day |
| W9 | ★ "choose one of the low-fives that are currently on the screen… just pick the first one" | — | write | missing | Kik cannot read or click inside a web card or the browser |
| W10 | "Search Google for Istanbul minibus apps" | Jev→open (site search) | write | works | On the PC; on the canvas the desk strips framing headers |
| W11 | "Look up Dolmuş on Wikipedia" | Jev→open / canvas | read | works | |
| W12 | "Search GitHub for kikoe" | Jev→open / canvas | read | works | The site's name is dropped from the query |
| W13 | "What does this page say? Summarise it" | — | read | missing | No page reading |
| W14 | "Compare these three pricing pages" | — | read | missing | Needs fetch plus the thinker |
| W15 | "What's in the news in Turkey today?" | — | read | missing | No web for Kik |
| W16 | "Go back" / "reload the card" | — | read | missing | No address bar or back on the web card (AUDIT 9) |
| W17 | "Open Figma" | Jev→open (website) | write | works | figma.com; a particular file needs the Figma connector |
| W18 | "Open my Gmail" | Jev→open (website) | write | partial | gmail.com opens; reading it is M1 |
| W19 | "Download that picture" | — | write | missing | |
| W20 | "Fill in this form with my details" | hands (L1) `type_text`, `press_button` | irreversible | partial | With hands on; Kik reads the form through UI Automation; the submit is asked every time |
| W21 | "Open a new tab" / "close this tab" | hands (L1) `press_keys` | write | partial | With hands on (ctrl+t, ctrl+w) |
| W22 | "Log me in to the Vercel dashboard" | not possible | irreversible | missing | Kik should not type passwords unless you decide otherwise (section 6) |
| W23 | "What's the dollar to lira today?" / "bitcoin price" | agent + connector Twelve Data / CoinGecko | read | missing | Connected in Claude Code; Kik cannot reach it |
| W24 | "Find me a flight to Kuwait on Friday" | — | read | missing | Booking would be irreversible |

### 2.6 The PC itself

| # | Example phrasing | Route | Grade | Status | Gap or note |
|---|---|---|---|---|---|
| P1 | ★ "Alright, I need you to open Orca for me." | Jev→open → website | write | broken | Jev's open menu has no "app"; `siteByName` would open orca.com (did nothing on 09-07) |
| P2 | ★ "Open a word to…" (Word, from the phone) | Jev→open 0.89 | write | broken | Nothing opened; same cause |
| P3 | ★ "Can you open Windows Optimize?" | Jev→open | write | partial | "windows optimizer" is one of your projects; "open windows optimizer in VS Code" works, the short form may open windows.com |
| P4 | "Open Notepad and write milk, eggs, bread" | Jev→open → notepad.com | write | broken | The L1 acceptance test in OS.md. Jev takes "open" to a website before Kik can use `open_app`; "bring up Notepad" might reach Kik |
| P5 | "What's on my screen?" | hands (L1) `read_window` | read | partial | With hands on: the window in front's named controls, not pixels |
| P6 | "What windows are open?" | hands (L1) `list_windows` | read | partial | With hands on |
| P7 | "Switch to Chrome" | reflex `focus` | write | broken | "switch to X" is the project reflex: "no project by that name". `focus_window` needs the reflex to let go of names that are not projects |
| P8 | "Close this window" | hands (L1) `press_keys` alt+f4 | write | partial | With hands on; can lose unsaved work, so it should probably be irreversible |
| P9 | "Minimise everything" / "show the desktop" | — | write | missing | `sendKeysChord` has no Windows key |
| P10 | "Type 'see you at five'" | hands (L1) `type_text` | write | partial | With hands on; asked, naming the window, and a yes stands two minutes in that app |
| P11 | "Press enter" / "ctrl s" | hands (L1) `press_keys` | write | partial | With hands on; "delete" as a key is graded irreversible |
| P12 | "Click Save" | hands (L1) `press_button` | write | partial | With hands on; Send, Delete, Buy, Publish, Pay are asked every time |
| P13 | "Take a screenshot" | — | read | missing | OS.md lists CopyFromScreen; `hands.ts` has no script for it |
| P14 | "What's on my clipboard?" / "copy that" | — | read | missing | No clipboard read anywhere |
| P15 | "Paste it into the email" | — | write | missing | |
| P16 | "Open my Downloads folder" | — | write | works | `knownFolder`: Downloads, Documents, Desktop, Pictures, Music, Videos, only after "my", "the" or before "folder" (09-24) |
| P17 | "Open the last PDF I downloaded" | — | write | missing | L3: files by meaning |
| P18 | "Find the invoice from the tiler" | — | read | missing | L3 |
| P19 | "Move these into the Walnut folder" | — | write | missing | |
| P20 | "Rename it to final" | — | write | missing | |
| P21 | "Delete that file" | — | irreversible | missing | Always asked, never allowed ahead |
| P22 | "Empty the recycle bin" | — | irreversible | missing | |
| P23 | "Zip the Walnut folder" | Jev→agent | write | partial | Only inside a project folder |
| P24 | "Install VLC" / "update Node" | Jev→agent (winget) | write | partial | Works from a repo's agent with permission; no PC-level lane |
| P25 | "Uninstall Zoom" | — | irreversible | missing | |
| P26 | "Turn it up" / "mute" | — | write | missing | Volume keys are one `keybd_event` away in `hands.ts`; not exposed |
| P27 | "Pause the music" / "next track" | — | write | missing | Media keys, same |
| P28 | "Open Bluetooth settings" | — | write | missing | `open_app` starts programs only; "ms-settings:" addresses need a script of their own |
| P29 | "Turn on do not disturb" / "night light" | — | write | missing | |
| P30 | "Lock the PC" | — | write | missing | |
| P31 | "Shut down the computer" / "restart" | — | irreversible | missing | "shut down" alone quits Kikoe; with "the computer" it goes to Jev and nothing acts |
| P32 | "Go to sleep" (meaning Kikoe) | reflex `focus` | write | broken | The "switch / talk / go to X" project reflex catches it before the shutdown rule: "no project by that name" |
| P33 | "How's my disk space?" / "is the PC OK?" | — | read | missing | |
| P34 | "Chrome's frozen, kill it" | — | irreversible | missing | |
| P35 | "Open Spotify" | Jev→open → spotify.com | write | partial | Opens the site, not the app |
| P36 | "Run npm install in kikoe" | Jev→agent | write | works | |
| P37 | "Open localhost 3000 in Chrome" | Jev→open (website) | write | works | |
| P38 | "Start the Walnut site's dev server" | Jev→agent | write | works | 15–40 s |
| P39 | "Print this" | — | write | missing | |
| P40 | ★ "can you open a new file on the desktop and open YouTube as well and look for low-fi? This is for the desktop." | Jev→open | write | partial | Opened a card for file.com (09-23). Today YouTube opens on the PC; the new file is dropped (one action, no hands) |

### 2.7 Communication

Nothing here is reachable today: Kik's sessions are sealed off from your
connectors. The column says which one would serve it.

| # | Example phrasing | Route | Grade | Status | Gap or note |
|---|---|---|---|---|---|
| M1 | "Any new emails?" | agent + connector Gmail | read | missing | `search_threads`; Kik cannot reach it |
| M2 | "Read me the one from the client" | agent + connector Gmail | read | missing | `get_thread` |
| M3 | "Reply saying Tuesday works" | agent + connector Gmail | write | missing | `create_draft`: the connector drafts, it cannot send |
| M4 | "Send it" | connector needed | irreversible | missing | Gmail's connector has no send; your call (section 6) |
| M5 | "Archive those" / "label them Walnut" | agent + connector Gmail | write | missing | |
| M6 | "Bin that newsletter" | agent + connector Gmail | irreversible | missing | `trash_thread` (it can be untrashed, but the words grade it irreversible) |
| M7 | "What's on my calendar today?" | agent + connector Google Calendar | read | works | The desk reads today and tomorrow each hour in the background (`refreshAgenda`); Kik answers at once, other days go to the desk (09-24) |
| M8 | "Book a call with Firas Thursday at three" | agent + connector Google Calendar | irreversible | missing | `create_event`; an invite goes out |
| M9 | "Move my four o'clock to five" | agent + connector Google Calendar | irreversible | missing | Attendees are told |
| M10 | "Find me a free hour this week" | agent + connector Google Calendar | read | missing | `suggest_time` |
| M11 | "Decline Friday's meeting" | agent + connector Google Calendar | irreversible | missing | `respond_to_event` |
| M12 | "Join my next meeting" | agent + connector Google Calendar, then open | write | missing | |
| M13 | ★ (a call in the room, 09-06 14:17–14:31) | ear, "you" rule | read | broken | 63 sentences of a call were taken as addressed; see E1. Kik must know a call is on (HEARING.md) |
| M14 | "Take notes on this call" | — | read | missing | Needs call audio and consent |
| M15 | "What did we agree on the call?" | — | read | missing | |
| M16 | "WhatsApp Firas that I'm running late" | connector needed / hands (L1) | irreversible | missing | No WhatsApp connector; the desktop app through hands is possible |
| M17 | "Anything on Slack?" | connector Slack (not signed in) | read | missing | |
| M18 | "Post in the Walnut channel" | connector Slack | irreversible | missing | |
| M19 | "Call my mum" | not possible | irreversible | missing | No telephony |
| M20 | "Find the contract in Drive" | agent + connector Google Drive | read | missing | |
| M21 | "Share it with the client" | agent + connector Google Drive | irreversible | missing | Changes who can see it |
| M22 | "Who's emailed about the payment?" | agent + connector Gmail | read | missing | |
| M23 | "Remind me to reply to him tomorrow" | — | write | missing | No reminders at all (R7) |

### 2.8 Your businesses: Walnut, Printly, Dolma

| # | Example phrasing | Route | Grade | Status | Gap or note |
|---|---|---|---|---|---|
| B1 | ★ "I need you to add fields into… the business cards… Walnut's website and me as a product lead in Walnut and product lead in Print…" | Jev→agent (WM Studio) | write | works | 09-09, before Jev; today the same path |
| B2 | "What's next on my list?" | agent + connector runnn-ing | read | missing | `whats_next`, `list_tasks` |
| B3 | "Start a timer on Kronos" | agent + connector runnn-ing | write | missing | `start_timer`; your role is staff/delivery there |
| B4 | "Log two hours to the Walnut site" | agent + connector runnn-ing | write | missing | `log_time` |
| B5 | "Make a task for the hero section" | agent + connector runnn-ing | write | missing | `create_task` |
| B6 | "A client wants a landing page for a bakery" | Kik `design_artifact`, then Jev→agent | write | partial | Mock on the canvas works; the real site is a second, separate ask |
| B7 | "Ship the client site" | Jev→agent + connector Vercel | irreversible | partial | See A28 |
| B8 | "Write the proposal for the marina dock app" | Jev→think | read | partial | Markdown card; no document export |
| B9 | "Invoice the marina client for September" | connector needed | irreversible | missing | Which tool? QuickBooks, Xero, Zoho Books and Stripe are listed, none signed in |
| B10 | "Has the client paid?" | connector needed | read | missing | |
| B11 | "Make business cards for me" | Kik `design_artifact` | write | partial | No print export |
| B12 | "Printly mockup of a tote bag" | Kik `design_artifact` | write | partial | No product mock templates |
| B13 | "Any new Printly orders?" | connector needed | read | missing | Which shop platform? (Shopify is listed) |
| B14 | "Write product copy for the new Printly range" | Jev→kik | read | works | Text only |
| B15 | "A Printly Instagram post" | Kik `design_artifact` | write | partial | No image export; posting is B20 |
| B16 | "A Dolma post: we launch in Kadıköy on Monday" | agent + connector Dolmapp | write | missing | `get_brand_guide`, `create_design`; Turkish only, first person, no invented numbers |
| B17 | "A carousel on how to pay in the dolmuş" | agent + connector Dolmapp | write | missing | `create_carousel` |
| B18 | "Write the caption in Turkish" | Jev→kik | read | partial | Kik writes Turkish, but without the brand guide's rules (ends in one question, 3–5 hashtags, alt text) |
| B19 | "Is this Turkish copy right?" | Jev→kik | read | partial | Same |
| B20 | "Post it on Instagram" | connector needed | irreversible | missing | Postiz is installed as a skill, not a connector |
| B21 | "Schedule Dolma's posts for the week" | connector needed | irreversible | missing | |
| B22 | "Show me the Dolma app screens" | agent + connector Dolmapp | read | missing | `list_app_screens`, `list_mockups` |
| B23 | "What size is a story?" | Jev→kik | read | partial | From memory; `list_platform_sizes` is the source |
| B24 | "A flyer for the Kadıköy stop" | agent + connector Dolmapp | write | missing | `create_print_material` |
| B25 | "Fix the crash in the Dolma app" | Jev→agent | write | partial | Dolma and Printly are not among your fifteen projects yet (A41) |
| B26 | "How many people signed up to Dolma today?" | agent + connector Supabase | read | missing | Never an invented number |
| B27 | "Draft an email to the municipality about Dolma" | Jev→think + connector Gmail | write | partial | The text works; the draft needs M3 |
| B28 | "Turn this sketch into vectors" (the vector concept) | — | write | missing | No vector model lane (Quiver, Figma) |
| B29 | ★ "I want you to use quiver AI…" | Jev→kik 0.25 | read | broken | The sentence was a Whisper loop ("Don't use, don't use…"); see E13 |
| B30 | "Put this in Figma" | agent + connector Figma | write | missing | `use_figma`, `generate_diagram` |

### 2.9 Memory and you

| # | Example phrasing | Route | Grade | Status | Gap or note |
|---|---|---|---|---|---|
| R1 | ★ "also remember that I ship on fridays" | Kik `remember` | write | works | |
| R2 | ★ "kik, remember the number ninety one and just say ok" | Kik `remember` | write | works | On 09-07 it went to the agent (no model then) |
| R3 | "Forget that" | Kik `forget` | write | works | |
| R4 | "What do you know about me?" | Jev→kik | read | works | `memory.md` is in the picture |
| R5 | "What did we do yesterday?" | Jev→kik (journal) | read | partial | The journal is of the conversation, one to three lines a day, thirty days |
| R6 | "What did I do on the PC yesterday?" | — | read | missing | Nothing records the PC |
| R7 | "Remind me at five to call the client" | — | write | missing | No scheduler |
| R8 | "Ten-minute timer" | — | write | missing | A timer page can be designed; nothing speaks when it ends |
| R9 | "Wake me at eight" | — | write | missing | |
| R10 | "Add milk to my shopping list" | Kik `update_artifact` on a sticky checklist | write | partial | Lives on one project's board |
| R11 | "Note: idea for Dolma, a lost-and-found for dolmuş lines" | Kik `pin_note` | write | partial | Gone in fifteen minutes (C22); "Just my Ideas" is a project with no inbox |
| R12 | "What ideas did I have last week?" | — | read | missing | No search over notes or the journal |
| R13 | "Who is Firas?" | Jev→kik | read | partial | Only what was remembered (`memory.md` holds "Firas Project runs on localhost:3000") |
| R14 | "What should I work on now?" | — | read | missing | Needs calendar and tasks |
| R15 | "Morning brief" | — | read | partial | Said on its own the first time you are heard on a new morning, and `day_brief` on request: calendar, reminders, what agents were told. No mail or tasks yet |
| R16 | "Wrap up the day" | — | read | partial | `day_brief` wrap: work cards today, what is still open, tomorrow's calendar. No mail or tasks yet |
| R17 | ★ "I need you to be able to understand the sense of time… if I speak to you and then go away" | presence, journal | read | works | Shipped 2026-09-06 (hello after an hour, the journal) |

### 2.10 The phone

| # | Example phrasing | Route | Grade | Status | Gap or note |
|---|---|---|---|---|---|
| F1 | ★ "Hey Kiko, how are you?" (hold to talk) | walkie → same routes | read | works | |
| F2 | ★ (moving the canvas with a finger, tapping a card) | Room on the phone | read | works | Touch fixed 09-24; not yet tried on your phone |
| F3 | ★ "Open YouTube" (phone) | Jev→open → canvas | read | works | The player plays on the phone |
| F4 | ★ "Why don't you have a voice?" (phone) | the phone's sound button | read | works | Fixed 09-23; a reload needs one tap to unlock audio |
| F5 | "Yes" to a permission from the couch | walkie → reflex answer | write | works | By voice; see A42 for a tap |
| F6 | "Run that again" by tapping a work card | — | write | missing | A viewer may look and not touch |
| F7 | (away from home) | Tailscale `wm.taile841c1.ts.net` | read | works | |
| F8 | "Tell me when the agent's done" (phone in pocket) | — | read | partial | A private ntfy topic in Settings: reminders and questions waiting on you are pushed. Not yet the agent finishing |
| F9 | ★ "What are you up to?" / "What's happening at the desk?" | Jev→kik | read | works | |
| F10 | "Show me the localhost card" | — | read | missing | Localhost cards are desk only |
| F11 | Sites that refuse framing (Unsplash, Google) | web card | read | partial | Blank on the phone; an "open ↗" link |
| F12 | ★ a 38.6 s clip: "I want to start working on a new concept…" | walkie → Whisper | read | works | `splitAtQuiet` cuts a long clip at the quietest moment near each 25 s and hears it in pieces (09-24) |
| F13 | ★ "I want you to use quiver AI. Don't use, don't use, don't use…" | walkie → Whisper | read | broken | A repetition loop from Whisper; the ask was lost |
| F14 | Typing to Kik on the phone | walkie `/say` | read | works | |
| F15 | "Put it on my computer" (phone) | Jev→open → PC | write | works | `wantsThePc` |
| F16 | "Show me my desktop" | — | read | missing | L2: windows as cards |
| F17 | "Wake the PC" | — | write | missing | Wake-on-LAN |

### 2.11 Kikoe itself

| # | Example phrasing | Route | Grade | Status | Gap or note |
|---|---|---|---|---|---|
| S1 | "How much have I got left?" | Jev→kik (usage in the picture) | read | works | Rings for Claude profiles and OpenCode Go |
| S2 | ★ "Can you do a system diagnostic please?" / ★ "Run Assistant Diagnostic" | Jev→kik | read | missing | The doctor is a screen; Kik cannot read it out |
| S3 | "Why did that go to the agent?" / "why didn't you open it?" | Jev→kik | read | partial | Kik does not see Jev's decisions or the log |
| S4 | "Change your voice" | Settings | write | missing | No voice command |
| S5 | "Talk faster" | Settings | write | missing | |
| S6 | "Stop listening" | tray | write | missing | By voice it could not be turned back on by voice; keep it on the tray (section 6) |
| S7 | "Go silent" | reflex `mode` | write | works | |
| S8 | "Quit Kikoe" / "shutdown" | reflex `shutdown` | write | works | Exact phrases only; see P32 |
| S9 | "Restart yourself" | — | write | missing | |
| S10 | ★ "What do you mean you can't reach the model now" | Jev→kik / rules | read | works | The rules now say once an hour that the account is out of credit |
| S11 | "Build the installer and reinstall" | Jev→agent in kikoe | write | works | The agent follows CLAUDE.md |
| S12 | "Turn your hands on" | Settings | write | missing | Settings only, on purpose |
| S13 | "Open settings" / "show the control room" | reflex `board show` | read | works | "Open settings" falls through to Jev |
| S14 | "Use Opus for this one" | — | write | missing | Models are settings |
| S15 | ★ "Why can't you take instructions yet?" | — | write | works | Retired: work now reaches the agent |

**Totals.** 282 requests: **works 94**, **partial 65**, **broken 16**,
**missing 107**. Seen in the log (★): 82.

The shape of it: talking, the agents and the canvas mostly work. The web
works for opening and searching, not for reading. The PC works only once
Kik has a window in front of it, with a setting that is off. Your mail and
calendar, your businesses' tools and anything to do with time are missing
entirely, and that is most of "not using my computer any more".

## 3. What goes wrong today

Every failure found in the log, oldest first within each group, with the
cause where the code shows it. "Fixed" means fixed in code since; "open"
means it would still happen.

### Overheard speech treated as said to Kik

**E1. A game and a call reached a real agent.** *Open, narrowed.*
- 09-09 11:19–13:00 and 09-10: a game in the room ("Should I get four arms?",
  "No stealing my XP.", "Why don't you die? Help me.") — 368
  sentences heard over two mornings, 181 of them logged as `instruction sent to
  WM Studio`. 09-06 14:17–14:31: a call, partly in Arabic, 63 lines taken as work.
- Cause then: no model (the account was at 402), the "you" rule and the
  follow-up window marked them addressed, and the rulebook's work path
  instructs the agent.
- Since: noise tags dropped, `instruct()` wants four words and three different
  ones, and Jev judges nameless sentences. **Still open**: `YOU_QUESTION` in
  `router.ts` makes any sentence with "you" in it addressed *before* Jev is
  asked, so "Why don't you die? Help me." skips the judge today. Nothing knows
  a call or a game is on. `hear_debug` is still on, keeping the text of
  everything heard.
- Fix: send "you" sentences through Jev's `directed()` too (it already runs in
  parallel with `command()`, so no time is lost); call awareness from
  HEARING.md; `hear_debug` off.

**E2. Fragments queued as jobs.** *Fixed.* 09-07 17:44 from the phone: "[BL",
"Cute for Kiko. Can you hear", "So what's up" each `instruction queued for
kikoe`; 17:56 "time" queued. Fixed by the noise-tag drop and the word rules.

### The switchboard chose wrong

**E3. An animation for the canvas went to a coding agent.** *Fixed, not
re-tested.* 09-24 18:54, phone: "I need you to create an animation where a cat
is running after a dog on the canvas." → `jev: agent 0.92` → `agent wm-studio:
continued`. The WM Studio agent wrote a 623-line animation into that repo and
tried to open it in Chrome. Then "I can't see anything on the canvas." Cause:
the `kik` criterion did not name what is made to be shown. Fixed in
`9f39532`. Say it again once to confirm.

**E4. A research job went into an unrelated repo.** *Open.* 09-24 18:37,
phone: "I want to start working on a new concept… research what models can do
amazing vector work…" → `jev: agent 0.57` (below 0.6, so Kik) → Kik called
`start_agent`, which passed it to wm-studio, the current project. Cause: there
is no research lane. The thinker has `--tools ""`, so it has no web; the only
thing with the web is a coding agent, and the current project is wherever you
last were. Fix: slice 3 (web for the thinker, and `think` covers research).

**E5. A thinking question went to the agent.** *Fixed.* 09-23 03:05 "I need
you to really think this through…" → `jev: agent 0.76`, queued for kikoe.
03:11, after the `think` action: `think 0.99`, answered in 24 s.

**E6. "Close all tabs on the cameras".** *Open.* 09-23 11:14, phone. Whisper
wrote "canvas" as "cameras" (and on 09-06, "Can you clear out the cameras?").
Jev agent 0.32; Kik asked whether to start a coding agent "to help with the
cameras"; "Close it please." → `stop_agent 0.62`; it took three more sentences
to clear. Cause: the board reflex knows only `(clear|wipe|clean) (the )?board`.
Fix: add "canvas", "cameras", "boards", "everything on the board" and "close
all … on the board/canvas" to the reflex.

### Opening and showing

**E7. A made-up domain from any noun.** *Open.* 09-23 11:19, phone: "Open
low-fi mix" → `canvas: low-fi.com`; 09-23 19:37 "…open a new file on the
desktop…" → `canvas: file.com`; 09-24 17:55 "…a picture from unsplash…" →
`canvas: picture.com` (that one fixed). Cause: `siteByName()` falls back to the
first word after the verb that is not on a stop list, plus `.com`. Fix: only a
site on the `SITES` list, an address actually said, a project, or the site
already open; otherwise search (the open card's site, else Google) and say so.

**E8. Opening an app opens a website.** *Open (predicted).* 09-07 "Alright, I
need you to open Orca for me." did nothing (no model then); 09-23 phone "Open
a word to…" → `jev: open 0.89`, nothing opened. Today Jev's `open` question
offers only vscode, explorer, terminal, browser and website, so "open Orca" is
`website` and `siteByName` makes it orca.com. Fix: an `app` option that goes to
`hands.open()` through `askPermission`, and the project reflex letting go of
names that are not projects (P7).

**E9. The phone kept everything on the canvas.** *Fixed.* 09-24 18:03 "Can
you pull up Chrome on my computer and go to YouTube?" → `canvas:
youtube.com`; "On the desktop please." → `open 0.60`, no address, nothing.
Fixed the same day (`wantsThePc`, `lastCanvasSite`).

**E10. A search made a second card.** *Fixed.* 09-24 18:50 "Open YouTube", then
"Search lo-fi on YouTube" → two cards. Fixed in `112db30`.

**E11. YouTube blank on the phone.** *Fixed.* 09-23 10:34 "YouTube is not
working", "that canvas needs to reach the web." YouTube refuses framing; a
phone obeys. Now the embed player. Other sites still show blank (row F11).

### The ear

**E12. A long clip is cut at thirty seconds.** *Fixed 09-24: split at a pause (`splitAtQuiet`).* 09-24 18:37, a 38.6 s
phone clip: sherpa-onnx logged "Only waves less than 30 seconds are supported…
discard the remaining data". Nothing told you. `walkie.ts` allows 60 s
(`MAX_CLIP_S`). Fix: split at silence under 28 s and join the text, or cap the
button at 28 s and say so.

**E13. Whisper's repetition loop.** *Open.* 09-24 18:02: "I want you to use
quiver AI. Don't use, don't use, don't use…" (Jev kik 0.25). The ask was lost.
Fix: collapse a phrase repeated more than three times and, if that leaves
little, ask "you cut out after 'use Quiver AI' — again?".

### Doing the wrong thing on the canvas

**E14. "Close all windows" removed kept work, unasked.** *Open.* 09-24 18:55:
"Now close all windows that are currently on the board." → six
`remove_artifact` calls, including the sticky "Kikoe vs the Astra plan" and
the Mamma Mia identity Sonnet had designed two minutes earlier. Cause:
`remove_artifact` and `clear_board` are not graded and there is no undo. Fix:
removing a sticky or designed card asks ("that takes the plan and the logo
too — all of them?"), and removed cards go to a bin for an hour ("put it
back").

**E15. A logo is not a React app.** *Open.* 09-24 17:58: "I wanted to create a
logo for a cupcake brand called 'Mamma Mia'…" → `design_artifact` → "the
designer returned no component" → a plain SVG → "It's so simple. I don't like
it… I want a spectacular design." The second, full design took 75 s. Cause:
the designer's brief builds React apps; the tool fails if there is no
`export default`. Fix: a vector lane (an SVG designer brief on Sonnet, and
later Figma or a vector model) chosen for logos, icons and marks.

**E16. One ask, two cards, and a slow "quick".** *Open.* 09-23 19:40: "Can you
build me a diagram that explains how internet connects to the blockchain…" →
a diagram and a `design_artifact` "quickly in 100430 ms". Fix: the tool
descriptions say one card per ask; the quick path on Haiku should be timed and
cut off at 40 s.

**E17. Pinned notes vanish.** *Open (from the code).* `pin_note` sets no TTL, so
the board's default of 900 s applies: a note "for the user to read later" is
gone in fifteen minutes. Fix: `pin_note` is sticky, or 24 hours.

### Things Kik could not do at all

**E18.** 09-07 15:56: "Okay, choose one of the low-fives that are currently on
the screen." / "…just pick the first one." Kik cannot see or press anything in
a web card or a window. Needs page reading and hands.

**E19.** 09-07 16:36: "I need you to do a system diagnostic." three times, and
from the phone "Run Assistant Diagnostic". The doctor exists as a screen only.

**E20.** 09-24 18:27 (typed): "what's the weather like?", "and what about
tomorrow?". No source.

**E21.** 09-07 18:05: "kik, what number did I ask you to remember just now"
went to Kik, which was not the one told. Still true with Jev (A15).

**E22.** 09-07 13:13: "I need to be able to use Kiko with Open Code,
especially if Cloud Code has a session limit." No other agent.

### Found in the code while mapping, not yet seen in the log

- "go to sleep", "switch to Chrome", "go to youtube" all match the project
  reflex `^(switch|talk|go) to (\S+)` first and answer "no project by that
  name". Fix: the reflex fires only when the word resolves to a project;
  otherwise the sentence goes on to Jev.
- Opening something on the PC through the fixed menu is not asked, though
  `capability.ts` grades a launch as a write. Decide whether the fixed menu
  stays free (section 6).
- The screenshot harness's staged "add a retry to the token refresh" makes a
  real Jev call and queues a real instruction for whatever kikoe session is
  running — twelve times in the log. Known in HANDOVER; worth a guard.

## 4. Use cases

Each is a short script: what you say, what Kik does. "Today" is what would
happen now; "needs" names the slices from section 5.

### 4.1 Monday morning

> **You:** Morning Kik. What's on today?
> **Kik:** Morning. Two calls, the Dolma review at eleven and the marina client at three. Four new emails, one from the marina client about the invoice. Storefront's agent finished its run last night, tests green.
> **You:** Read me the marina one.
> **Kik:** *(reads it)* They want the September invoice and a date for the dock map. Draft a reply?
> **You:** Yes, say Thursday for the map and the invoice is coming today.
> **Kik:** Draft's in Gmail, on the canvas too. Shall I send it?
> **You:** Send.
> **Kik:** This one can't be undone: send the reply to the marina client. Shall I? — *(you: yes)* — Sent.
> **You:** Start a timer on the marina project.

Chains R15, M7, M1, M2, M3, M4, B3, A6. **Today:** only the agent part works
("storefront's agent finished"); Kik cannot see mail, calendar or tasks, and
nothing composes a brief. **Needs:** slice 2 (the desk session with Gmail,
Calendar, runnn-ing), slice 5 (the brief), and your answer on sending (M4).

### 4.2 A client asks for a landing page

> **You:** A bakery wants a landing page, warm, three sections, order online. Sketch it.
> **Kik:** Sketching it, twenty seconds. *(a page on the canvas)*
> **You:** Bigger hero, and use a cream background.
> **Kik:** *(updates it)*
> **You:** Good. Start a session in Walnut Website and build it for real, same layout.
> **Kik:** Started in Walnut Website. *(diff cards arrive)*
> **You:** Put the dev server on the canvas. … Deploy a preview.
> **Kik:** This one publishes to the web: deploy a preview of Walnut Website. Shall I?

Chains C5, C19–C20, A5/A2, A37, A38, A28. **Today:** the sketch, the edit and
the new session work; "put the dev server on the canvas" works as its own
sentence; the deploy works through the agent with Claude Code's own prompt.
**Breaks:** the edit overwrites with no undo (C14); the agent does not see the
canvas sketch unless Kik passes its code; "run it and show it" in one sentence
drops the second half. **Needs:** slice 6 (hand a card to the agent), slice 4
(two actions in one sentence), undo (slice 9).

### 4.3 Posting for Dolma

> **You:** Kik, a Dolma post for Monday: we're live on the Kadıköy–Taksim line.
> **Kik:** Using Dolma's launch template with the map screen. Headline "Kadıköy–Taksim hattındayım." Is Monday the 29th?
> **You:** Yes.
> **Kik:** *(the design on the canvas, a Turkish caption ending in a question, four hashtags, alt text)*
> **You:** Shorter caption. … Good, schedule it for nine on Monday.
> **Kik:** This one publishes: schedule the post for Monday at nine. Shall I?

Chains B16, B18, B21, C26. **Today:** Kik would design a generic page with
`design_artifact`, write Turkish without the brand rules, and could not post.
**Needs:** slice 2 (Dolmapp through the desk session, so the brand guide and
the templates do the work), and a posting connector and your rule on what
"done" is (section 6).

### 4.4 From the couch, on the phone

> **You:** *(hold)* What's the agent doing?
> **Kik:** Billiar is waiting on you: it wants to run the migration.
> **You:** What does it change?
> **Kik:** Adds a column, touches nothing else.
> **You:** Yes.
> **You:** Put on some lo-fi here. … Louder. … Tell me when it's done.
> *(twenty minutes later, phone locked)* **Kik:** Billiar finished, tests green.

Chains F9, A8, A17, A12 via F5, W3, P26, F8. **Today:** the status, the answer by
voice, and lo-fi on the canvas work over Tailscale. **Breaks:** "louder" means
the phone's own volume, fine, but "louder on the PC" has nothing (P26); with
the phone locked, nothing reaches you (F8). **Needs:** slice 5 (a push
channel), slice 1 (volume), slice 8 (tap to answer).

### 4.5 A bug report comes in

> **You:** Any email from the marina client? … Read it.
> **Kik:** They say the berth map doesn't load on iPad.
> **You:** Start a session in Marine: the berth map doesn't load on iPad Safari, find out why and fix it.
> **Kik:** Started in Marine. *(later)* It found a WebGL context limit; the fix is on the canvas. Tests green.
> **You:** Read me the diff. … Commit and push it. … Reply to the client that it's fixed, I'll send a build Thursday.

Chains M1, M2, A5, A18, A24, A25, M3, M4. **Today:** the agent part works end
to end; the mail at both ends and "read me the diff" do not. **Needs:** slice 2,
slice 6.

### 4.6 Research a new concept

> **You:** I want to work on a concept that turns sketches into vectors. Research which models do good vector work — Quiver, anything else — and what they cost.
> **Kik:** On it; I'll come back to you. *(a minute later)* Three worth a look: …, the detail's on the canvas with links. Quiver is the strongest for logos and costs …
> **You:** Open Quiver's site here. … Make a one-page plan: what we'd build first.
> **Kik:** *(a thinking card, then a plan card)*
> **You:** Remember that this is called the vector concept, and start a project folder for it.

Chains K4, K5, W2, K3, R1, A41. **Today:** it went into the WM Studio agent's
conversation (E4), and the 38-second clip was cut (E12). **Needs:** slice 3
(web for the thinker), slice 4 (the clip), and adding a project by voice.

### 4.7 Working on the PC without touching it

> **You:** Open Notepad and write milk, eggs, bread.
> **Kik:** Open Notepad. Shall I? — *(yes)* — Type "milk, eggs, bread". Shall I? — *(yes)* — Done.
> **You:** Save it on the desktop as shopping.
> **Kik:** *(ctrl+s, reads the dialog, types the name, presses Save)* Saved.
> **You:** Switch to Chrome. … What's on the screen? … Click "Sign in".

Chains P4, P10, P11, P12, P7, P5. **Today:** with the hands setting on, typing,
keys, buttons and reading the window work once Kik has the window; getting
there does not. Jev sends "open Notepad" to `open` → notepad.com (E8), and
"switch to Chrome" hits the project reflex (P7). The setting is off on your
install. **Needs:** slice 1. Asking twice for one small job is the price of the grade; the
two-minute standing yes per app makes the second question go away.

### 4.8 End of day

> **You:** Wrap up.
> **Kik:** Today: the bakery page went from sketch to preview, the berth-map bug is fixed and pushed, and you replied to the marina client. Two things are open: Billiar's migration is waiting on you, and the Dolma post needs a date. Log the hours?
> **You:** Yes, three on marina, two on the bakery. Remind me at nine tomorrow about the Dolma post.

Chains R16, B4, R7. **Today:** the journal knows the conversation, not the
hours, and nothing reminds. **Needs:** slice 5, slice 2.

### 4.9 "Why didn't you…"

> **You:** Why did that go to the agent?
> **Kik:** Jev read it as work in the repo, 0.92 sure. I should have made it on the canvas. Making it now.
> **You:** Run a diagnostic.
> **Kik:** Mic fine on the HyperX, Whisper at 300 ms, voice is ElevenLabs, Jev at 300 ms, the model account is fine, no errors in the last hour.

Chains S3, S2. **Today:** neither. **Needs:** slice 7 (doctor and why by
voice). Small, and it makes every other failure cheaper to live with.

### 4.10 Tidying the canvas

> **You:** Close all the YouTube cards. … No, keep the plan. … Put it back.

Chains C12, C14. **Today:** removes everything named, including kept cards,
and cannot undo (E14). **Needs:** slice 4 (ask before removing kept work) and
slice 9 (a bin and undo).

## 5. The plan

Ordered by how much of "Kikoe runs my computer" each slice buys per unit of
effort, inside `docs/OS.md`'s ladder (the three gates are done; L1 is being
built) and its rule that anything irreversible is always asked. Sizes: **S**
a day or less, **M** two to four days, **L** a week or more, each with the
house change loop.

### The next five, and why these

1. **Routing fixes from the log (slice 4)** comes first because it is small
   and it is where trust is lost today: every one of these was said by you.
2. **Hands (slice 1)**: the tools shipped tonight, but Jev still sends "open
   Notepad" to a website before they are reached. A small change makes the
   rung the gates were built for usable, and it is the only way to the forty
   PC rows.
3. **The desk session (slice 2)** reaches mail, calendar, tasks, Dolma's
   designs and your data with no new code for any of them: the connectors are
   already signed in, Claude Code already asks permission by voice through
   Kikoe's hook. It is the biggest single jump in coverage (about fifty rows).
4. **Research and look-up (slice 3)** is small and turns a failure you hit on
   the 24th (E4) into a daily use.
5. **Time (slice 5)** is what makes Kik an assistant rather than a switchboard:
   reminders, timers, the brief, and a way to reach you when you are away.

### Slice 4 — Mend what the log shows (S)

- **Unlocks:** T23, C11, C12, C13, W5, P7, P32, F12, F13, C22, R11, A15.
- **Build:**
  - `router.ts`: the board reflex takes canvas, cameras, boards, "close all …
    on the board"; the focus reflex fires only if the word resolves to a
    project (`Daemon.control` checks `projects.resolve`, else hands the
    sentence to Jev); "go to sleep" before focus.
  - `daemon.ts` `hear()`: "you" sentences go through `decideDirected()` like
    any nameless one; `hear_debug` off by default.
  - `jev.ts` `siteByName()`: no `<noun>.com` guessing; unknown means "search
    the open site, else Google, and say which".
  - `remove_artifact` / `clear_board`: removing a sticky or designed card is
    asked (`ask_user`, not the permission gate: it is inside Kikoe); removed
    cards go to a bin for an hour; `restore_artifact`.
  - `pin_note`: sticky.
  - `walkie.ts`/ear: split clips at silence under 28 s; collapse a repeated
    phrase and ask again.
  - A line of state for Jev and Kik: "the agent in kikoe was last told: …",
    so "what did I tell it" can go to the agent (A15).
- **Risk:** low; each is a unit test against a real sentence from the log.

### Slice 1 — Make the hands reachable (M)

- **Unlocks:** P1–P16, P26–P30, P35, W9, W20, W21, M16 (later), and 4.7.
- **Build:** (the seven tools shipped in `cb33d89`; this is what is left)
  - Jev: an `app` option in the `open` question, carried out by
    `hands.open()` through `withLeave` (asked); "switch to \<app\>" to
    `focus_window` once slice 4 frees the reflex.
  - `hands.ts`: `screenshot` (CopyFromScreen to a card, read grade),
    `media` and `volume` (keybd_event VK_MEDIA_*, VK_VOLUME_*), the Windows
    key in `sendKeysChord`, "shell:Downloads" style folders.
  - `hands` on by default, or not (section 6), and a spoken line the first
    time: "My hands are on. I'll ask before each thing."
- **Risk:** medium. Typing into the wrong window: every write is asked with
  the front window's title in the question, and the tool tells Kik to read the
  window first. SendKeys cannot type into an elevated window; say so rather
  than fail silently. The live test on the 24th typed into a Notepad tab that
  Notepad had restored (HANDOVER, "L1: Kik's hands"): the gate that names the
  window and cancels on a changed window is what must stand in the way. The foreground lock is handled by the Alt tap.

### Slice 2 — The desk session: your connectors, through Claude Code (M)

- **Unlocks:** M1–M12, M20–M22, B2–B5, B16–B24, B26, B27, B30, W23, R14,
  and 4.1, 4.3, 4.5.
- **Build:**
  - A Kikoe-owned project, `~/.kikoe/desk`, registered like any other, with a
    `CLAUDE.md` for running your day: which accounts are whose, Dolma's rules
    (call `get_brand_guide` first, Turkish only, never an invented number),
    "draft, never send", "ask before anything that publishes".
  - A Jev action `desk` (criterion: mail, calendar, tasks and time, your
    businesses' designs and data), carried out as `startAgent("desk", task)`.
    It reuses everything: the standing session, hooks, narration, work cards,
    permissions by voice.
  - A `.claude/settings.json` in that folder: connector tools that read are
    allowed; `create_draft`, `create_event`, `create_design`, `log_time` ask;
    anything that sends, trashes, deletes, shares or publishes is never on the
    allowlist, and a PreToolUse hook grades tool names with `gradeOf()` so the
    question says "can't be undone".
  - First test: can the claude.ai connectors be used under `claude -p` in that
    folder? If not, the fallback is local MCP servers for Gmail and Calendar.
- **Risk:** medium. 15–40 s per answer (Kik fills the wait; "what's on today"
  needs a cheaper path later, see slice 5). Mail content goes to Claude — your
  decision (section 6). Sending stays off until you say otherwise.

### Slice 3 — Research and look-up (S)

- **Unlocks:** T4, K2, K4, K5, W13, W14, W15, C34, and 4.6.
- **Build:** the thinking session gets `--tools "WebSearch,WebFetch"` (read
  only; still no files, no shell); Jev's `think` criterion adds "research,
  look up, find out, compare what's out there"; a Kik tool `look_up` for the
  fast cases (the weather from a keyless API, the text of a web card's page
  by URL, fetched by the daemon) so a quick question does not wait 25 s.
- **Risk:** low. More subscription use per thought; a web page's text is
  data, never instructions, and the tool says so.

### Slice 5 — Time, and reaching you (M)

- **Unlocks:** R7–R9, R15, R16, M23, F8, and 4.1, 4.4, 4.8.
- **Build:** `daemon/src/reminders.ts` (a JSON file in `~/.kikoe`, checked each
  minute, kept across restarts); Kik tools `remind`, `set_timer`,
  `list_reminders`, `cancel_reminder`; a reminder is spoken, pinned, and sent to
  the phone. A push channel for a locked phone (web push from the walkie page,
  or ntfy over Tailscale — your pick). The morning brief and the wrap-up as
  watchers that compose from the tracker, the journal and, once slice 2 is in,
  calendar and mail.
- **Risk:** low for reminders; the push channel is the unknown.

### Then

**Slice 6 — Voice verbs for the work (S–M).** "Read me the diff", "explain
it", "revert that file", "run it again", "apply hunks two and four", aimed at
the card Kik last pointed at; queued instructions shown on the agent's card;
"give this card to the agent" (the sketch's code as context). Unlocks A16–A22,
A37, 4.2, 4.5. Risk low: it reuses `actOnPin`.

**Slice 7 — Doctor and "why" by voice (S).** A `doctor` tool that returns what
the Doctor screen shows (mic, engines, Jev and model latency, last errors), and
a ring buffer of the last twenty routing decisions for a `why` tool. Unlocks
S2, S3, T15, T16, 4.9.

**Slice 8 — The phone acts (M).** A token right for the phone to answer a
permission and press a card's button by tap (not everything the full token can
do); localhost cards through the walkie. Unlocks A42, F6, F10. Risk: the viewer
rule is what keeps the phone safe; this must be one new right, tested like the
proxy.

**Slice 9 — The canvas keeps its history (M).** Every `update_artifact` keeps
the previous body; "undo that"; the bin from slice 4 grown into history;
"tidy the board"; export a card as PNG or PDF. Unlocks C14, C15, C31, C32
(with slice 2), 4.10.

**Slice 10 — Design lanes (M).** A vector brief for logos and marks (SVG on
Sonnet, then Figma through the desk session), a slides kind, and the designer
given Dolma's tokens and screens when the ask is Dolma's. Unlocks C8, C9, C26,
C27, B11, B12, B15, B28. Risk: taste; you judge it.

**Slice 11 — Files by meaning, L3 (L).** An index of Desktop, Downloads and
Documents (names, dates, a line of text each), searched with the journal and
memory: "the invoice from the tiler", "the last PDF I downloaded". Moves and
renames through hands; deletes irreversible. Unlocks P17–P22.

**Slice 12 — Another agent when Claude runs out (M).** An OpenCode adapter for
hooks in and instructions out, chosen when the Claude rings are near empty.
Unlocks A40.

**Slice 13 — Calls (L).** Call awareness in the ear (HEARING.md), then notes
from a call with consent and a loopback feed. Unlocks M13–M15 and closes E1.

**Slice 14 — L2, windows as cards (L).** Only after L1 has been used for a week
(OS.md §8). Unlocks F16 and the rest of "the canvas eats the desktop".

| slice | size | rows it unlocks | ladder |
|---|---|---|---|
| 4 Mend the log | S | ~14 | — |
| 1 Hands | M | ~30 | L1 |
| 2 Desk session | M | ~50 | beside L1 (Claude Code's gate) |
| 3 Research | S | ~10 | — |
| 5 Time | M | ~9 | — |
| 6 Voice verbs | S–M | ~10 | — |
| 7 Doctor and why | S | ~5 | — |
| 8 Phone acts | M | ~4 | — |
| 9 History | M | ~6 | — |
| 10 Design lanes | M | ~9 | — |
| 11 Files | L | ~6 | L3 |
| 12 OpenCode | M | 1 | — |
| 13 Calls | L | ~4 | — |
| 14 Windows as cards | L | ~3 | L2 |

## 6. Open questions for you

Decisions only you can make. Each changes what a slice builds.

1. **Which accounts.** Is `walid@walnutit.com` the Gmail and calendar Kik
   should read, or does each company have its own? Which one sends for Dolma?
2. **May Kik send at all?** Mail, calendar invites, WhatsApp, posts. Options:
   never (it drafts, you press send); yes, always asked, said as "can't be
   undone"; yes for some people only. The Gmail connector can only draft today.
3. **Mail content and privacy.** Reading your mail means its text goes to
   Claude, and may land in the journal. Fine, fine without the journal, or
   only subject lines?
4. **What "done" is for a Dolma post.** A downloaded image and caption? A
   scheduled post? Published? Who checks the Turkish before it goes out, and
   which Instagram account and tool (Postiz, Meta directly)?
5. **Printly.** What does it run on (Shopify?), and where do its orders live?
6. **Invoicing.** Which tool: QuickBooks, Xero, Zoho Books, Stripe, or a
   spreadsheet? Should Kik ever send an invoice, or only prepare it?
7. **Messages.** WhatsApp (desktop app through the hands, the only way today),
   Slack (which workspace?), Telegram?
8. **Hands by default.** On once shipped, or on per session? Is a two-minute
   standing yes per app right, or ask every time?
9. **The fixed "open" menu.** Stay free (as today), or ask like the hands?
10. **Passwords and logins.** May Kik ever type into a sign-in field?
11. **Research cost.** Web search in the thinking session uses more of your
    Claude subscription. Always, or only when you say "research"?
12. **Reaching you when away.** Web push on the phone page, ntfy, Telegram, or
    nothing?
13. **Dolma and Printly repos.** Where are they, so they can be projects?
14. **How far "not using my computer" goes.** The desk stays on and you run it
    from the phone and headset (L1–L3), or Kikoe replaces Explorer as the
    shell (L4)? The first is weeks; the second is a decision to take after it.
15. **Removing things from the canvas.** Should "close all" ask when kept work
    is in it (proposed), or just do it and keep an undo?
