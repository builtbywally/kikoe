/**
 * The rules head: answers a question about what the agents are doing, from
 * the status board, with no model and no network. It must be good on its
 * own, because it is what a fresh install has.
 */

import type { SessionSnapshot } from "./tracker.js";

function ago(s: number): string {
  if (s < 60) return `${Math.max(1, Math.round(s))} seconds`;
  if (s < 3600) {
    const m = Math.round(s / 60);
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  const h = Math.round(s / 3600);
  return `${h} hour${h === 1 ? "" : "s"}`;
}

function toolWord(tool: string): string {
  const t = tool.toLowerCase();
  if (["bash", "shell", "powershell"].includes(t)) return "running a command";
  if (["edit", "write", "multiedit"].includes(t)) return "editing";
  if (["read", "grep", "glob", "search"].includes(t)) return "reading";
  if (["task", "agent"].includes(t)) return "waiting on a subagent";
  return tool ? `using ${tool.toLowerCase()}` : "working";
}

function describe(s: SessionSnapshot): string {
  switch (s.status) {
    case "waiting":
      return `${s.label} is waiting on you${s.pending_permission ? `: ${s.pending_permission.slice(0, 60)}` : ""}.`;
    case "working":
      return `${s.label} is ${toolWord(s.current_tool)}${s.running_for_s ? `, ${ago(s.running_for_s)} in` : ""}.`;
    case "failed":
      return `${s.label} failed${s.last_error ? `: ${s.last_error.slice(0, 60)}` : ""}.`;
    default:
      return `${s.label} is idle${s.quiet_for_s ? `, quiet for ${ago(s.quiet_for_s)}` : ""}.`;
  }
}

/** Pick the session a question is most likely about. */
function pick(sessions: SessionSnapshot[], text: string): SessionSnapshot | undefined {
  const named = sessions.find((s) => s.label && text.includes(s.label.toLowerCase()));
  if (named) return named;
  const rank = (s: SessionSnapshot) =>
    s.status === "waiting" ? 0 : s.status === "working" ? 1 : 2;
  return [...sessions].sort((a, b) => rank(a) - rank(b) || a.quiet_for_s - b.quiet_for_s)[0];
}

/**
 * The questions this head actually knows, as opposed to the ones it will
 * answer with a status line because that is all it has.
 *
 * It matters when there is no model: "did the tests pass" is answered here,
 * instantly and free, while "why is the retry bounded" is not a question
 * about the status board at all and deserves to reach something that can
 * think. Without this distinction every question got the same shrug.
 */
const KNOWN =
  /test|how long|since when|how far|error|fail|broke|wrong|crash|wait|block|need|stuck|permission|what did (it|you) (say|do)|last thing|which|who|what.*(repo|agent|talking)|what.*(doing|happening|going on)|status|busy|idle|running/i;

export function knows(text: string): boolean {
  return KNOWN.test(text);
}

export function answer(text: string, sessions: SessionSnapshot[]): string {
  const t = text.toLowerCase();
  if (!sessions.length) return "Nothing's running. I haven't heard from an agent yet.";
  const s = pick(sessions, t);

  if (/test/.test(t)) {
    const withTests = s?.last_test_result ? s : sessions.find((x) => x.last_test_result);
    if (!withTests) return "No test run yet.";
    return `${withTests.label}: last run was ${withTests.last_test_result}.`;
  }
  if (/how long|since when|how far/.test(t)) {
    if (!s) return "Nothing's running.";
    return s.running_for_s
      ? `${s.label} has been going ${ago(s.running_for_s)}.`
      : `${s.label} isn't running right now.`;
  }
  if (/error|fail|broke|wrong|crash/.test(t)) {
    const failed = sessions.find((x) => x.last_error);
    return failed
      ? `${failed.label}: ${failed.last_error.slice(0, 80)}.`
      : "No errors on the board.";
  }
  if (/wait|block|need|stuck|permission/.test(t)) {
    const w = sessions.filter((x) => x.status === "waiting");
    if (!w.length) return "Nothing's waiting on you.";
    return w.map(describe).join(" ");
  }
  if (/what did (it|you) (say|do)|last thing/.test(t)) {
    return s?.last_reply ? `${s.label} said: ${s.last_reply.slice(0, 120)}` : "Nothing yet.";
  }
  if (/which|who|what.*(repo|agent|talking)/.test(t)) {
    const busy = sessions.filter((x) => x.status !== "idle");
    return busy.length
      ? busy.map((x) => x.label).join(", ") + (busy.length === 1 ? " is active." : " are active.")
      : "Everything's idle.";
  }
  // The general "what's it doing": one sentence per session that matters.
  const rank = (x: SessionSnapshot) => (x.status === "waiting" ? 0 : x.status === "failed" ? 1 : 2);
  const lines = sessions
    .filter((x) => x.status !== "idle")
    .sort((a, b) => rank(a) - rank(b))
    .map(describe);
  if (!lines.length)
    return `Everything's idle. ${sessions.length === 1 ? sessions[0]!.label + " finished" : "Last one finished"} ${ago(Math.min(...sessions.map((x) => x.quiet_for_s)))} ago.`;
  return lines.slice(0, 3).join(" ");
}

/** A word back for a social turn: not a summary of a repository. */
export function social(intent: string, text = ""): string {
  // "Hey, how are you" is a question, and "Here." is no answer to it. Heard
  // over and over on the phone the day the model account ran dry.
  if (
    /\bhow (are|r) (you|ya|u)\b|\bhow('?s| is) it go|\bhow (you|ya) doing\b|\bhows? things\b/i.test(
      text,
    )
  )
    return "Good, thanks. Quiet on my side.";
  switch (intent) {
    case "hello":
      // the bare name: answering a call
      return "Here.";
    case "hi":
    case "hey":
      return "Hey.";
    case "thanks":
    case "thank":
      return "Anytime.";
    case "good":
      return "Thanks.";
    default:
      return "Mm-hm.";
  }
}
