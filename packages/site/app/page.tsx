import { Board } from "@/components/Board";
import { Companion } from "@/components/Companion";
import { EarDemo } from "@/components/EarDemo";
import { HeroTalk } from "@/components/HeroTalk";
import { Hooks } from "@/components/Hooks";
import { Island } from "@/components/Island";
import { Logo } from "@/components/Kit";
import { PhoneShowcase } from "@/components/Phone";
import { QuickStart } from "@/components/QuickStart";
import { RoomPreview } from "@/components/RoomPreview";
import { SessionsRace } from "@/components/SessionsRace";
import { SoundProvider, SoundToggle } from "@/components/Sound";
import { Switchboard } from "@/components/Switchboard";

const REPO = "https://github.com/builtbywally/kikoe";

const SAYS = [
  "Kik, what's it doing?",
  "Open a new Claude session in storefront and tell it to do one, two, three, four",
  "Tell it to add a retry to the token refresh",
  "Yes",
  "Think this through: SQLite or a JSON file per project?",
  "Make me a release checklist",
  "Draw the retry flow",
  "Open marine in VS Code",
  "Open YouTube here",
  "Switch to storefront",
  "Stop the agent",
  "Quiet",
];

const RULES: [string, string][] = [
  [
    "What wasn't said to Kik is dropped whole.",
    "Only a word count survives. No transcript of the room is kept, listed or streamed anywhere.",
  ],
  [
    "Permissions are never skipped.",
    "Answering them by voice is the product. The model never sits between a permission and its answer: “yes” and “no” are reflexes, handled by code.",
  ],
  [
    "Hooks in, hooks out.",
    "No PTY wrapper, nothing scraped from a terminal. Claude Code's own hooks go in, and speech and cards come out.",
  ],
  [
    "The rulebook is the floor.",
    "With no key, no network and no model, Kik still hears, answers, narrates and starts agents. It loses the personality, not the job.",
  ],
  [
    "Jev chooses; code acts.",
    "No model writes a command that gets run. The job is always a cut of your own words, never a paraphrase.",
  ],
];

function Head({
  n,
  eyebrow,
  children,
  lede,
}: { n: string; eyebrow: string; children: React.ReactNode; lede?: React.ReactNode }) {
  return (
    <div className="head">
      <div className="eyebrow">
        {n} · {eyebrow}
      </div>
      <h2>{children}</h2>
      {lede && <p className="lede">{lede}</p>}
    </div>
  );
}

export default function Home() {
  return (
    <SoundProvider>
      <a className="skip" href="#main">
        Skip to the page
      </a>
      <nav className="nav" aria-label="Main">
        <div className="wrap">
          <a className="brand" href="#top">
            <Logo size={22} />
            Kikoe
          </a>
          <div className="nav-links">
            <a href="#ear">The ear</a>
            <a href="#switchboard">Try it</a>
            <a href="#canvas">Canvas</a>
            <a href="#room">The Room</a>
            <a href="#quickstart">Quick start</a>
          </div>
          <SoundToggle />
          <a className="pill-btn gh" href={REPO} target="_blank" rel="noopener noreferrer">
            GitHub ↗
          </a>
        </div>
      </nav>

      <main id="main">
        <header className="hero" id="top">
          <div className="wrap">
            <div className="hero-copy">
              <div className="kana">
                <Logo size={34} label="こえ" />
                <span>こえ, “voice” · kikoe, 聞こえ, “audibility”</span>
              </div>
              <h1>
                <span className="line">Talk to Kik.</span>
                <span className="line dim">
                  The agents do <em>the work.</em>
                </span>
              </h1>
              <p className="lede">
                Kikoe is the room you run your coding agents from, by voice. It sits beside Claude
                Code with an ear, a voice, a mind and an infinite canvas. You talk. Kik listens,
                answers in one good line, and hands the job to the right agent. The canvas shows
                what words can't carry.
              </p>
              <div className="cta">
                <a className="pill-btn solid" href="#quickstart">
                  Quick start
                </a>
                <a className="pill-btn" href="#switchboard">
                  Try the switchboard ↓
                </a>
              </div>
              <div className="meta-row">
                <span>MIT licensed</span>
                <span>Windows 10 / 11</span>
                <span>runs on your Claude subscription</span>
                <span>Whisper on your PC</span>
              </div>
            </div>
            <HeroTalk />
          </div>
        </header>

        <div className="says" aria-label="Things you can say">
          <div className="says-track">
            {SAYS.map((s) => (
              <span key={`a-${s}`}>{s}</span>
            ))}
            {SAYS.map((s) => (
              <span key={`b-${s}`} aria-hidden="true">
                {s}
              </span>
            ))}
          </div>
        </div>

        <section
          id="ear"
          data-kik="That's my ear. What wasn't said to me, I don't keep. Only a word count."
        >
          <div className="wrap">
            <Head
              n="01"
              eyebrow="Hearing"
              lede="A headset mic, Silero to find speech and Whisper to write it down, all on your PC. Say “kik” and the sentence is for Kik. Leave the name out and Jev judges whether you meant it for Kik, in about 0.3 seconds. Everything else is dropped whole: not logged, not listed, not streamed."
            >
              It hears the room. It keeps <em>only what was for Kik.</em>
            </Head>
            <EarDemo />
          </div>
        </section>

        <section
          id="switchboard"
          className="tight"
          data-kik="Pick a sentence, or type your own. Watch where it goes."
        >
          <div className="wrap">
            <Head
              n="02"
              eyebrow="Deciding"
              lede="Jev is the switchboard. It never writes text. It chooses from fixed options and says how sure it is. One call, about 0.4 seconds, answers four questions at once: what should happen, which part of your sentence is the job, what to open, and which project. Then plain code acts. Switch Jev off and the regex rulebook decides, the way it did before Jev."
            >
              One sentence, <em>one decision,</em> and code does it.
            </Head>
            <Switchboard />
          </div>
        </section>

        <section
          id="sessions"
          className="tight"
          data-kik="Three of us, on your subscription. I talk, I think, the agent works."
        >
          <div className="wrap">
            <Head
              n="03"
              eyebrow="Three sessions"
              lede="All three run through Claude Code on your own Claude subscription. No API key and no terminal wrapper. Press the button and they run at their real speeds."
            >
              Kik talks fast, thinks slowly, and <em>leaves the work to the agent.</em>
            </Head>
            <SessionsRace />
          </div>
        </section>

        <section
          id="canvas"
          className="tight"
          data-kik="This is a board. Drag it around. Try answering that permission."
        >
          <div className="wrap">
            <Head
              n="04"
              eyebrow="Showing"
              lede="One board per project. The buttons on a card become instructions to the agent. A permission waits on the board, and Kik asks you out loud, until you say yes or no. Kikoe itself never writes to your repo. Drag the board and the cards; press the buttons."
            >
              Every diff, test run and reply lands as <em>a card you can act on.</em>
            </Head>
            <Board />
          </div>
        </section>

        <section
          id="hooks"
          className="tight"
          data-kik="No terminal scraping. Claude Code's hooks come in; speech and cards go out."
        >
          <div className="wrap">
            <Head
              n="05"
              eyebrow="Under the hood"
              lede="No PTY wrapper and nothing parsed from a terminal. Kikoe installs Claude Code hooks that post to one daemon on your machine, on port 4570. The daemon narrates, holds permissions open until you answer, and turns the work into cards. The same daemon streams the board to your phone."
            >
              Hooks in, <em>voice and cards out.</em>
            </Head>
            <Hooks />
          </div>
        </section>

        <section
          id="room"
          className="tight"
          data-kik="That's the Room, the way it looks today. And it follows you to your phone."
        >
          <div className="wrap">
            <Head n="06" eyebrow="The Room">
              One canvas, <em>at the desk and in your pocket.</em>
            </Head>
            <div className="room-frame">
              <RoomPreview />
            </div>
            <p className="fine center">
              The Room, built from the app's own pieces and playing a turn: a diff, “apply”, then
              green.
            </p>

            <div className="anywhere">
              <PhoneShowcase />
              <div>
                <h3 className="h3-serif">Hold the orb on your phone and talk.</h3>
                <ul className="dots">
                  <li>
                    <b>The same canvas, streamed.</b> The work still happens on the PC. Turn on
                    sound and you hear Kik on the phone as well as at the desk.
                  </li>
                  <li>
                    <b>Its own token.</b> The phone can watch and talk to Kik, but it can't approve
                    a tool call or press a card's buttons.
                  </li>
                  <li>
                    <b>Away from home.</b> With Tailscale, Kikoe serves the phone on your tailnet
                    with a real certificate, reachable only from your own devices.
                  </li>
                  <li>
                    <b>The island.</b> A pill at the top of the screen with Kik's state and a ring
                    for how much of each assistant's limit is used.
                  </li>
                </ul>
                <Island />
              </div>
            </div>
          </div>
        </section>

        <section
          className="paper"
          id="principles"
          data-kik="The rules I keep. The first one matters most to me."
        >
          <div className="wrap">
            <Head n="07" eyebrow="Principles">
              Five rules the code <em>will not bend.</em>
            </Head>
            <ul className="rules">
              {RULES.map(([h, p]) => (
                <li key={h}>
                  <h3>{h}</h3>
                  <p>{p}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section
          id="quickstart"
          data-kik="A few commands and you can talk to me. Tick them off as you go."
        >
          <div className="wrap">
            <Head
              n="08"
              eyebrow="Quick start"
              lede="From a clone to talking to Kik. Tick each step as you go; this browser remembers where you got to."
            >
              Clone it. <em>Say kik.</em>
            </Head>
            <QuickStart />
          </div>
        </section>
      </main>

      <footer>
        <div className="wrap">
          <a className="brand" href="#top">
            <Logo size={28} />
            Kikoe
          </a>
          <span>MIT · © 2026 builtbywally · made to sit beside Claude Code</span>
          <span>
            Dotted orbs:{" "}
            <a
              href="https://github.com/Jakubantalik/thinking-orbs"
              target="_blank"
              rel="noopener noreferrer"
            >
              thinking-orbs
            </a>{" "}
            (MIT)
          </span>
          <a className="pill-btn" href={REPO} target="_blank" rel="noopener noreferrer">
            github.com/builtbywally/kikoe ↗
          </a>
        </div>
      </footer>

      <Companion />
    </SoundProvider>
  );
}
