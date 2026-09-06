// Sonnet 5 vs Haiku 4.5 for Kikoe: the voice head and the designer.
// Runs against the real API with the user's key; never prints the key.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "kikoe-eval-"));
process.env.KIKOE_HOME = SCRATCH;
process.env.KIKOE_CLAUDE_DIR = path.join(SCRATCH, "claude");
const key = readFileSync(path.join(os.homedir(), ".kikoe", "anthropic_key.txt"), "utf8").trim();

const { Daemon, DEFAULTS, Brain, DESIGN_BRIEF, stripFences } = await import(
  new URL("../packages/daemon/dist/index.js", import.meta.url).href
);

const MODELS = { haiku: "claude-haiku-4-5-20251001", sonnet: "claude-sonnet-5" };

const VOICE = [
  ["what's it doing", "answer from the picture", []],
  ["did the tests pass", "18 passed 2 failed", []],
  ["tell it to add a retry to the fetch call", "instruct", ["instruct_agent"]],
  ["make me a checklist for the release", "checklist on canvas", ["create_artifact"]],
  ["go ahead", "approve the pending push", ["approve"]],
  ["we ship on fridays, remember that", "remember", ["remember"]],
  ["what do you think about rewriting the auth module in rust", "an opinion, short", []],
  ["put localhost 3000 on the canvas", "web card", ["create_artifact"]],
  ["compare cats and dogs as pets in a visual artifact", "design_artifact", ["design_artifact"]],
];

function stage() {
  const d = new Daemon({
    settings: { ...DEFAULTS, tts: "none", mic: false, brain: true },
    audio: false,
    anthropicKey: key,
    persistBoard: false,
  });
  const cwd = path.join(SCRATCH, "storefront");
  d.hook({ hook_event_name: "SessionStart", session_id: "s1", cwd });
  d.hook({
    hook_event_name: "UserPromptSubmit",
    session_id: "s1",
    cwd,
    prompt: "fix the flaky test",
  });
  d.hook({
    hook_event_name: "PreToolUse",
    session_id: "s1",
    cwd,
    tool_name: "Bash",
    tool_input: { command: "pnpm test" },
  });
  d.hook({
    hook_event_name: "PostToolUse",
    session_id: "s1",
    cwd,
    tool_name: "Bash",
    tool_input: { command: "pnpm test" },
    tool_response: "Tests: 18 passed, 2 failed (windows paths)",
  });
  d.hook({
    hook_event_name: "PermissionRequest",
    session_id: "s1",
    cwd,
    tool_name: "Bash",
    tool_input: { command: "git push origin main" },
  });
  return d;
}

async function voice(modelName) {
  const rows = [];
  for (const [text, want, tools] of VOICE) {
    const d = stage();
    const brain = new Brain({ key, model: MODELS[modelName] });
    const called = [];
    const toolset = d.brainTools().map((t) => ({
      ...t,
      run: async (i) => {
        called.push(t.name);
        if (t.name === "design_artifact") return "built pin_x"; // don't spend a minute here
        return t.run(i);
      },
    }));
    const t0 = Date.now();
    let first = 0;
    let said = "";
    try {
      said = await brain.reply(text, {
        system: d.brainSystem(),
        tools: toolset,
        onClause: () => {
          if (!first) first = Date.now() - t0;
        },
      });
    } catch (e) {
      said = `ERROR ${e.message}`;
    }
    const total = Date.now() - t0;
    const spoken = said.replace(/\s*next:\s*[^\n]*$/i, "").trim();
    const words = spoken.split(/\s+/).filter(Boolean).length;
    const hasNext = /next:/i.test(said);
    const markdown = /(^|\n)\s*([-*]|\d+\.)\s|#|\*\*|`/.test(spoken);
    const toolsOk = tools.every((t) => called.includes(t));
    rows.push({
      text,
      want,
      model: modelName,
      first,
      total,
      words,
      hasNext,
      markdown,
      called: called.join("+") || "-",
      toolsOk,
      spoken,
    });
    await d.close();
  }
  return rows;
}

const BRIEFS = [
  [
    "Wallet settings",
    "A settings page for a wallet app: profile (name, email, avatar), notifications (toggles for payments, security alerts, marketing), security (2FA toggle, change password, active sessions list with revoke), and a Save button that shows a saved state.",
  ],
  [
    "Cats vs dogs",
    "A visual side-by-side comparison of cats and dogs as pets: cost per year, time needed per day, space, allergies, lifespan, and a short verdict for a busy person in a small flat. Let the user pick their situation (flat or house, hours away per day) and highlight the better fit.",
  ],
];

async function design(modelName) {
  const rows = [];
  for (const [title, brief] of BRIEFS) {
    const brain = new Brain({ key, model: MODELS[modelName] });
    const t0 = Date.now();
    let code = "";
    try {
      code = stripFences(
        await brain.generate(`Brief: ${brief}\n\nTitle: ${title}`, DESIGN_BRIEF, {
          model: MODELS[modelName],
        }),
      );
    } catch (e) {
      code = `ERROR ${e.message}`;
    }
    const total = Date.now() - t0;
    const classes = (code.match(/className=/g) || []).length;
    const state = (code.match(/useState\(/g) || []).length;
    const icons = /lucide-react/.test(code);
    const charts = /recharts/.test(code);
    const hasDefault = /export\s+default/.test(code);
    const lorem = /lorem|Item 1|placeholder text/i.test(code);
    const emoji = /[\u{1F300}-\u{1FAFF}]/u.test(code);
    writeFileSync(path.join(SCRATCH, `${modelName}-${title.replace(/\W+/g, "-")}.jsx`), code);
    rows.push({
      title,
      model: modelName,
      total,
      chars: code.length,
      classes,
      state,
      icons,
      charts,
      hasDefault,
      lorem,
      emoji,
    });
  }
  return rows;
}

const out = { voice: {}, design: {}, scratch: SCRATCH };
for (const m of ["haiku", "sonnet"]) {
  out.voice[m] = await voice(m);
  out.design[m] = await design(m);
}
writeFileSync(path.join(SCRATCH, "results.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
