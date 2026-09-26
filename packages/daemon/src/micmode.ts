/**
 * How the computer's microphone listens: open, muted, or push to talk.
 *
 * The phone's clips are transcribed by the same ear process as the PC mic
 * (main.ts, `transcribeWithEar`), so turning the mic off in Settings
 * silenced the phone too. Muting stops only the PC's audio stream; the ear
 * stays up for the phone. On 2026-09-26 one sentence said into the phone
 * was heard twice, once by each — which is the case this is for.
 *
 * Push to talk keeps the stream closed until a hotkey opens it for one
 * sentence, which counts as said to Kik without the name.
 */

export type MicMode = "open" | "muted" | "push";

export function micModeOf(v: unknown): MicMode {
  return v === "muted" || v === "push" ? v : "open";
}

const PUSH = /\bpush[\s-]*to[\s-]*talk\b/i;
const MUTE =
  /\b(?:mute|turn\s+off|switch\s+off|close|stop)\s+(?:the\s+|your\s+|my\s+)?(?:computer|pc|desktop|laptop)(?:'s)?(?:\s+mic(?:rophone)?)?\b|\bmute\s+(?:the\s+|your\s+)?mic(?:rophone)?(?:\s+on\s+the\s+(?:computer|pc|desktop|laptop))?\b|\b(?:only|just)\s+(?:listen\s+to\s+me|listen|hear\s+me)\s+(?:on|through|from)\s+(?:my\s+|the\s+)?phone\b/i;
const OPEN =
  /\bunmute\b|\b(?:turn\s+on|switch\s+on|open)\s+(?:the\s+|your\s+|my\s+)?(?:computer|pc|desktop|laptop)(?:'s)?\s+mic(?:rophone)?\b|\blisten\s+(?:to\s+me\s+)?on\s+the\s+(?:computer|pc|desktop|laptop)(?:\s+again)?\b/i;

/** "Mute the computer", "unmute", "push to talk mode", or null. */
export function micModeAsk(text: string): MicMode | null {
  if (PUSH.test(text)) return "push";
  if (OPEN.test(text)) return "open";
  if (MUTE.test(text)) return "muted";
  return null;
}

/** What Kik says when the mode changes. */
export function micModeLine(mode: MicMode, key: string): string {
  if (mode === "muted") return "The computer's mic is off. I still hear you on the phone.";
  if (mode === "push") return `Push to talk is on. Press ${spokenKey(key)} and talk.`;
  return "I'm listening on the computer again.";
}

/** "CommandOrControl+Shift+Space" said out loud. */
export function spokenKey(key: string): string {
  return key
    .split("+")
    .map((k) =>
      /^(commandorcontrol|cmdorctrl|control|ctrl)$/i.test(k) ? "control" : k.toLowerCase(),
    )
    .join(" ");
}
