/**
 * Plan mode by voice: "plan mode, add dark mode to Marine".
 *
 * The agent runs with `--permission-mode plan` — it reads and thinks and
 * changes nothing — and its plan goes on the canvas. Then the user decides,
 * the way they approve everything else: "go ahead" carries it out in the
 * same conversation, "change the header part" plans again with that, and
 * "drop it" ends it. These are the words; daemon.ts does the rest.
 */

const PLAN =
  /\b(?:in\s+|use\s+|with\s+)?plan(?:ning)?\s+mode\b|\bplan\s+(?:it|this|that)\s+(?:out\s+)?first\b|\bplan\s+(?:it|this|that)\s+out\b|\bplan\s+first\b|\b(?:make|write|draw\s+up|come\s+up\s+with|give\s+me)\s+(?:me\s+)?a\s+plan\s+(?:for|to|on)\b|\bplan\s+out\b/i;

/**
 * The job, with the words that asked for a plan taken out, or null when the
 * sentence did not ask for one. "" means plan mode was asked for with no job.
 */
export function planAsk(text: string): string | null {
  if (!PLAN.test(text)) return null;
  return text
    .replace(PLAN, " ")
    .replace(
      /^[\s,.:;-]*(?:(?:okay|ok|so|kik\w*|please|can you|could you|i want you to|let's)[\s,.:;-]*)*/i,
      "",
    )
    .replace(/^(?:and|then|to)\s+/i, "")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.:;-]+|[\s,;:-]+$/g, "")
    .trim();
}

export type Verdict = "go" | "drop" | "change";

const GO =
  /^(?:(?:yes|yeah|yep|yup|ok|okay|sure|great|perfect|good|nice|cool|alright|all right)[\s,.!]*)*(?:go\s+ahead|do\s+it|build\s+it|go\s+for\s+it|ship\s+it|approved?|sounds\s+good|looks\s+good|carry\s+(?:it\s+)?out|execute(?:\s+it)?|proceed|let'?s\s+do\s+it|let'?s\s+go|lgtm|make\s+it\s+so)\b/i;
const YES_ALONE = /^(?:yes|yeah|yep|yup|ok|okay|sure|approve)[\s.!]*$/i;
const DROP =
  /^(?:(?:no|nope|nah)[\s,.!]*)*(?:drop\s+it|scrap\s+it|forget\s+it|cancel(?:\s+it)?|never\s*mind|don'?t\s+do\s+it|leave\s+it|no\s+thanks|skip\s+it|bin\s+it)\b/i;
const NO_ALONE = /^(?:no|nope|nah)[\s.!]*$/i;
const CHANGE =
  /^(?:(?:no|but|and|also|actually|okay|ok)[\s,.!]*)*(?:instead|change|make|don'?t|do\s+not|add|remove|drop\s+the|skip\s+the|use|without|rather|what\s+if|can\s+you|could\s+you|keep|move|rename|split)\b|\bthe\s+plan\b|\bstep\s+\w+\b/i;

/** What the user made of a plan on the canvas, or null if this is not about it. */
export function planVerdict(text: string): Verdict | null {
  const t = text.trim().replace(/^kik\w*[\s,.:;-]*/i, "");
  if (!t) return null;
  if (GO.test(t) || YES_ALONE.test(t)) return "go";
  if (DROP.test(t) || NO_ALONE.test(t)) return "drop";
  if (CHANGE.test(t)) return "change";
  return null;
}

/** How many steps a plan has, for the line Kik says about it. */
export function planSteps(plan: string): number {
  return plan.split(/\r?\n/).filter((l) => /^\s*(?:\d+[.)]|#{2,3}\s+(?:step\s+)?\d+)/i.test(l))
    .length;
}
