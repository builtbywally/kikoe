# The "Astra experience" on this PC

Prepared 2026-09-07. Research findings, what this machine already has, the gap, and a proposal.  
Nothing in the proposal is built yet. Two draft scripts sit in `C:\Users\USER\astra\` as sketches only.

---

## 1. What GPT-6 Astra actually is

OpenAI announced GPT-6 Astra on **3 September 2026**. It is a model, not an app. Two headline capabilities:

- **Computer use.** The model operates a computer the way a person does: browser, files, spreadsheets, forms, desktop apps, connected tools. It takes screenshots, decides, clicks, types, checks the result, repeats.
- **Long, multi-step tasks.** It stays on a job for many steps instead of answering once.

What the launch video showed:

- An OpenAI employee sits in a chair and talks. By voice they ask it to turn a yellow circle into a rocket ship, then into a full 3D game. It also produces a Blender model and an STL file, creates an eBay listing, orders beef and rice, and books a tennis court.
- Fortune reported the video as "a seamless, **albeit staged**, interaction." Treat the video as the ambition, not a guarantee of the day-one product.

How you get it:


| Item         | Detail                                                                                                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rollout      | Enterprise "Daybreak" partners first, then Plus, Pro, Business, Enterprise "over the coming days"                                                                                                              |
| API          | Model id `gpt-6-astra`, 1M context. Also on AWS Bedrock and Azure                                                                                                                                              |
| Price (API)  | $10 per 1M input tokens,$50 per 1M output. Cached input $1. Batch half price. Fast mode 2x                                                                                                                     |
| Restrictions | Public version refuses advanced cybersecurity tasks. Rated "Critical" under OpenAI's Preparedness Framework                                                                                                    |
| Voice        | Voice is how the demo was driven. None of the launch coverage documents a specific "voice plus computer use" product surface yet, so expect it through the ChatGPT desktop app or Codex, rolling out in stages |


Bottom line: the thing you saw is **speech to text, an agent that can see the screen and use mouse and keyboard, and text to speech**, wired together with a model that can plan long tasks. That loop is reproducible here today with Claude.

Sources:

- OpenAI announcement: [https://openai.com/index/gpt-6-astra/](https://openai.com/index/gpt-6-astra/)
- Fortune (staged demo, rollout): [https://fortune.com/2026/09/03/openai-debuts-gpt-6-astra-computer-use-greg-brockman-says-start-of-agi/](https://fortune.com/2026/09/03/openai-debuts-gpt-6-astra-computer-use-greg-brockman-says-start-of-agi/)
- VentureBeat: [https://venturebeat.com/technology/welcome-to-the-agi-era-openai-launches-gpt-6-astra](https://venturebeat.com/technology/welcome-to-the-agi-era-openai-launches-gpt-6-astra)
- CNBC: [https://www.cnbc.com/2026/09/03/open-ai-astra-gpt-6-cyber.html](https://www.cnbc.com/2026/09/03/open-ai-astra-gpt-6-cyber.html)
- The Neuron (demo breakdown): [https://www.theneurondaily.com/p/gpt-6-astra-can-stay-on-the-job-and-use-your-computer](https://www.theneurondaily.com/p/gpt-6-astra-can-stay-on-the-job-and-use-your-computer)
- Pricing and specs roundup: [https://explainx.ai/blog/gpt-6-astra-launch-benchmarks-pricing-2026](https://explainx.ai/blog/gpt-6-astra-launch-benchmarks-pricing-2026)
- Demo showcase list: [https://explainx.ai/blog/gpt-6-astra-best-demos-showcase-2026](https://explainx.ai/blog/gpt-6-astra-best-demos-showcase-2026)

---

## 2. What this machine already has

I checked the kikoe install and Claude Code setup.

**Working**

- **Voice out.** Kikoe speaks via ElevenLabs (voice "Sarah"), with Piper and Kokoro as offline fallbacks.
- **Microphone in.** Kikoe listens on the HyperX Cloud Flight headset with a local Whisper "base" model and wake name "kik".
- **The board.** Kikoe can show diffs, markdown, diagrams, and ask yes/no questions by voice.
- **Claude Code** 2.1.263 with a headless mode (`claude -p`) that can resume a session, skip permission prompts, and load MCP tool servers.
- **Browser control.** The Chrome DevTools MCP plugin is installed, so Claude can already drive Chrome tabs.
- **Python 3.11 and Node 22.** Screen and input libraries (pyautogui, mss, pywinauto) and the local speech model (faster-whisper small.en) installed cleanly during my check.

**Not working or missing**

1. **Voice commands do not reach Claude.** Kikoe's own text says it: "I can't take instructions yet. Say it to the terminal." Kikoe's brain answers questions and approves permissions by voice, but it never turns "open Notepad and write a list" into a Claude task. This is the core gap.
2. **Kikoe's brain is down.** Its Anthropic API key has no credits. Every check-in since this morning logs "Your credit balance is too low." Claude Code itself is unaffected because it uses your subscription login.
3. **Transcription is garbled.** Kikoe's own notes say voice input "has been garbled for many turns." The Whisper "base" model is the smallest one. A "small" or "medium" model is noticeably more accurate.
4. **No desktop control.** Claude Code can run shell commands and drive Chrome, but it cannot see the screen or click in arbitrary Windows apps. That is the "use anything on the computer" half of Astra.

---

## 3. Proposal: three pieces

```
  you speak ──► local speech-to-text ──► Claude Code (headless, session kept) ──► kikoe speaks the reply
                                              │
                                              ▼
                                   "computer" tool server
                              screenshot · click · type · hotkeys
                              windows · open apps · UI tree · PowerShell
```

### Piece A. Computer-use tool server (the hands and eyes)

A small Python MCP server registered once in Claude Code for all projects. Tools:

- `screenshot` (downscaled to save tokens, coordinates mapped back to real pixels)
- `click`, `move_mouse`, `drag`, `scroll`
- `type_text`, `press_key` (any hotkey like ctrl+s, alt+f4, win+r)
- `list_windows`, `focus_window`, `open_app` (apps, files, folders, URLs)
- `ui_tree` (Windows accessibility tree, so buttons and fields are found by name, not by guessing pixels)
- `run_powershell` for anything faster by script than by clicking
- `monitors` / `select_monitor` for your multi-monitor setup

Note: the Python MCP library on this machine is version 2, which renamed its main class. The draft script targets the old name and needs a one-line change before it runs. That is where I stopped.

### Piece B. Voice loop (the ears)

A Python script that runs in a terminal or at login:

1. Listens on the headset with a local faster-whisper "small.en" model (already downloaded, runs on CPU, no cloud).
2. Wake word "Astra", or an open-mic flag where every sentence is a command. Saying just "Astra" gets a "Yes?" and arms it for the next sentence.
3. Sends the sentence to Claude Code headless with permissions skipped and the session resumed, so it remembers context across commands.
4. Says "On it" immediately, then speaks Claude's final line through kikoe. A system prompt tells Claude its reply is spoken: two plain sentences, outcome first, no code or paths.
5. "Stop" or "cancel" kills the running task. "New session" starts fresh.

### Piece C. Fix what kikoe already does

- Top up the Anthropic API credits so the brain, narration, and check-ins work again, or turn the brain off if the voice loop replaces it.
- Switch kikoe's speech model from "base" to "small" for cleaner transcripts.
- Decide on one wake word so kikoe and the voice loop don't both grab the same sentence.

---

## 4. What it will feel like

- "Astra, open Notepad and write my shopping list: milk, eggs, bread." Notepad opens, text appears, she says "Done, the list is in Notepad."
- "Astra, go to eBay and start a listing for my old monitor." Chrome opens, she navigates, fills the form, stops before publishing and asks.
- "Astra, what's on my desktop?" She screenshots, reads it, answers out loud.

Expect ten to sixty seconds per task depending on steps. Vision-driven clicking is slower and less precise than the polished video, which is why the plan leans on hotkeys, the UI tree, and PowerShell where possible.

---

## 5. Risks and decisions for you

1. **Permissions.** The Astra feel requires running Claude with permission prompts skipped. It will click, type, and run commands without asking. The system prompt tells it to pause before deleting, paying, or sending, but that is a guideline, not a hard block. Alternative: keep prompts on and answer them by voice through kikoe (slower, safer).
2. **Two listeners.** Kikoe and the voice loop would both hear you. Simplest: the voice loop owns commands, kikoe owns replies and the board.
3. **Cost.** Every command with screenshots is a Claude session turn on your subscription. Screenshots are the expensive part; the server downscales them.
4. **Where it lives.** Proposed folder is `C:\Users\USER\astra\`. It is machine-wide, not part of the Marine project.
5. **Privacy.** Speech is transcribed locally. Screenshots go to Claude only when a task needs them.

---

## 6. Steps if you say go

1. Fix the MCP server for the version-2 library and register it in Claude Code (user scope).
2. Test it from a Claude Code session: screenshot, open Notepad, type, verify.
3. Run the voice loop, tune the mic energy threshold for the headset, test wake word and stop.
4. Add a launcher so it starts at login, next to kikoe.
5. Optional: kikoe credits top-up and speech model upgrade.

Estimated effort: about one focused session for steps one to four.

---

## 7. Current state of this folder

- `computer_mcp.py`: draft tool server, needs the library rename fix.
- `astra.py`: draft voice loop, untested with a real microphone.
- The temporary Claude Code registration I made during the check has been removed. Nothing runs at login. No other settings were changed.

