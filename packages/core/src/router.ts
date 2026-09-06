/**
 * What to do with something the user said. Pure: text in, decision out.
 *
 * The name gate comes first and fails closed: an utterance that does not
 * start with the name is overheard and dropped, unless a question is
 * waiting and the utterance is a bare answer, because a spoken "Shall I?"
 * invites a bare "yes". Control words are matched before anything else
 * and never reach an agent: "stop" delivered as a prompt is a disaster.
 */

export type Kind = "control" | "answer" | "question" | "work" | "social" | "overheard" | "empty";

export interface Decision {
  kind: Kind;
  /** for control: the intent; for answer: yes | no | the word */
  intent: string;
  /** the utterance with the name stripped */
  text: string;
  addressed: boolean;
  /** a mode name, a repo name, a board action */
  arg: string;
}

/** Ways speech recognition spells the name. Fails closed on anything else. */
export const DEFAULT_ALIASES = [
  "kikoe",
  "kiko",
  "kikoi",
  "kikoy",
  "kee koe",
  "key koe",
  "key ko",
  "kicko",
  "keiko",
  "kikou",
  // what Whisper actually makes of it, from the heard log
  "kick",
  "kicky",
  "kick oh",
  "kick away",
  "kick oi",
  "kiku",
  "keeko",
  "kikoa",
  "geeko",
  "kekoe",
  "cookie",
  "a cookie",
  // the nickname, and what Whisper makes of it
  "kik",
  "kiks",
  "kicks",
  "keek",
  "kick it",
];

const YES = [
  "yes",
  "yeah",
  "yep",
  "yup",
  "ok",
  "okay",
  "sure",
  "do it",
  "go ahead",
  "go for it",
  "apply",
  "apply it",
  "allow",
  "approve",
];
const NO = [
  "no",
  "nope",
  "nah",
  "don't",
  "do not",
  "cancel",
  "deny",
  "stop",
  "skip",
  "skip it",
  "leave it",
];

const CONTROLS: Array<[RegExp, string, (m: RegExpExecArray) => string]> = [
  [/^(stop|shut up|quiet|be quiet|hush|silence|enough)\b/, "stop", () => ""],
  [/^(pause|hold on|hang on|wait)\b/, "pause", () => ""],
  [/^(resume|continue|carry on|unpause)\b/, "resume", () => ""],
  [/^(clear|wipe|clean) (the )?board\b/, "board", () => "clear"],
  [/^(show|open|bring up)( me)? (the )?(board|control room|sessions)\b/, "board", () => "show"],
  [/^(hide|close) (the )?(board|control room)\b|^back to the room\b/, "board", () => "hide"],
  [/^(go|be|switch to|set) (silent|attention|normal|verbose)\b/, "mode", (m) => m[2] ?? ""],
  [/^(quieter|less|fewer|shush)\b/, "mode", () => "attention"],
  [/^(louder|more|chattier|talk more)\b/, "mode", () => "verbose"],
  [/^(repeat|say (that|it) again|what did you say|again)\b/, "repeat", () => ""],
  [/^(switch|talk|go) to (\S+)\b/, "focus", (m) => m[2] ?? ""],
  [/^(shut down|shutdown|quit kikoe|goodbye kikoe|go to sleep)$/, "shutdown", () => ""],
];

// The normalizer drops apostrophes, so "what's" arrives as "whats".
/**
 * Anything said to "you", with nobody else in the room, is said to us:
 * "what do you think about this", "I want to ask you a question", "listen
 * to me when I'm talking to you". Recall over precision, on purpose: a
 * headset and an empty room make a false hit cheap and a miss maddening.
 * Opt-in by the daemon; off for a shared room or a call.
 */
const YOU_QUESTION =
  /\b(you|your|yours|yourself)\b|^(listen|tell me|talk to me|answer me|say something)\b/;

const QUESTIONS = [
  /^whats? (it|you|they|he|she|everyone|everything) (doing|up to|working on)/,
  /^whats? (going on|happening|the status|up)/,
  /^(status|report|update)$/,
  /^(did|do|does|have|has|are|is|was|were|will|can|could|should|would|how|whats?|which|where|when|who|why|anything|any)\b/,
  /\?$/,
];

const SOCIAL = [
  /^(hi|hello|hey|thanks|thank you|good (morning|night|evening)|cheers|nice|great|cool|love you|good job|well done)\b/,
];

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”"'’`]/g, "")
    .replace(/[^\p{L}\p{N}\s?]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The name by its shape, for the spellings the alias list has not met yet:
 * a k or c, a short i or ee, a k or ck, and whatever Whisper tacks on
 * ("kik", "keek", "kicko", "kikoi"). Recall over precision, on purpose;
 * everyday words with that shape are rare ("kick" is already the name).
 */
export function nameLike(word: string): boolean {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length < 3 || w.length > 7) return false;
  return /^[ck](i|ee|ea|e|ey|ie)[ck]{1,2}(s|o|oe|oh|ou|oi|a|y|i|u|e|ie|oo)?$/.test(w);
}

/** Strip the name if the utterance starts with it. Returns [addressed, rest]. */
export function gate(text: string, aliases: string[] = DEFAULT_ALIASES): [boolean, string] {
  const t = normalize(text);
  const names = [...new Set(aliases.map((a) => normalize(a)).filter(Boolean))];
  for (const prefix of ["hey ", "hi ", "ok ", "okay ", "yo ", ""]) {
    for (const n of names) {
      const head = prefix + n;
      if (t === head) return [true, ""];
      if (t.startsWith(`${head} `) || t.startsWith(`${head},`)) {
        return [true, t.slice(head.length).replace(/^[\s,]+/, "")];
      }
    }
  }
  // Not a known spelling; maybe a new one with the right shape.
  const words = t.split(" ");
  const lead = ["hey", "hi", "ok", "okay", "yo"].includes(words[0] ?? "") ? 1 : 0;
  const first = words[lead] ?? "";
  if (first && nameLike(first)) return [true, words.slice(lead + 1).join(" ")];
  return [false, t];
}

export interface RouteOptions {
  aliases?: string[];
  /** a permission or an asked pin is waiting on the user */
  awaitingAnswer?: boolean;
  /** offered answers for the thing waiting, if any */
  offered?: string[];
  /**
   * The name was said on its own a moment ago and we answered "yes?". The
   * next thing said is for us even without the name; the daemon opens the
   * window and closes it after one utterance or a few seconds.
   */
  attending?: boolean;
  /** a question aimed at "you" counts as addressed, name or no name */
  youQuestions?: boolean;
}

export function route(text: string, opts: RouteOptions = {}): Decision {
  const gated = gate(text, opts.aliases);
  const plain = normalize(text);
  const implied =
    !gated[0] &&
    plain.length > 0 &&
    (opts.attending === true || (opts.youQuestions === true && YOU_QUESTION.test(plain)));
  const [addressed, rest] = implied ? [true, plain] : gated;
  const base = { addressed, text: rest, arg: "" };
  if (!rest && !addressed) return { kind: "empty", intent: "", ...base };
  if (!rest && addressed) return { kind: "social", intent: "hello", ...base };

  const offered = (opts.offered ?? []).map((o) => o.toLowerCase());
  const bare = rest.replace(/\bplease\b/g, "").trim();

  // A bare answer to an open question: allowed without the name, the way a
  // person answers "Shall I?" with a plain "yes".
  if (opts.awaitingAnswer) {
    // The offered words first: "apply" answers an apply/no question as
    // itself, not as a generic yes.
    if (offered.includes(bare)) return { kind: "answer", intent: bare, ...base };
    if (YES.includes(bare)) return { kind: "answer", intent: "yes", ...base };
    if (NO.includes(bare)) return { kind: "answer", intent: "no", ...base };
  }

  if (!addressed) return { kind: "overheard", intent: "", ...base };

  // "can you clear the board" is "clear the board"
  const asked = bare.replace(/^(can|could|would|will) you\s+/, "");
  for (const [re, intent, arg] of CONTROLS) {
    const m = re.exec(asked);
    if (m) return { kind: "control", intent, ...base, arg: arg(m) };
  }
  if (YES.includes(bare)) return { kind: "answer", intent: "yes", ...base };
  if (NO.includes(bare)) return { kind: "answer", intent: "no", ...base };
  if (SOCIAL.some((re) => re.test(bare)))
    return { kind: "social", intent: bare.split(" ")[0] ?? "", ...base };
  if (QUESTIONS.some((re) => re.test(bare))) return { kind: "question", intent: "ask", ...base };
  return { kind: "work", intent: "instruct", ...base };
}
