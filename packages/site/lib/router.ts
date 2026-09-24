// The switchboard, as a toy that runs in the browser. It mirrors the shape of
// the real one (daemon/src/jev.ts and core's router): the name or a judgement
// decides whether a sentence was for Kik, reflexes come before any model, and
// one decision answers what, the job, what to open and which project. The
// probabilities are made up by simple rules; the page says so.

export type Route = "kik" | "think" | "agent" | "new_session" | "open" | "canvas" | "switch";
export type Reflex = "quiet" | "stop the agent" | "allow" | "deny";

export interface Context {
  /** A Jev key is set: a probability decides, not only the rules. */
  jev: boolean;
  /** The agent is mid-turn, so an instruction waits for the end of it. */
  busy: boolean;
  /** A permission is waiting, so a bare yes or no answers it. */
  permission: boolean;
}

export interface Decision {
  text: string;
  words: number;
  named: boolean;
  jev: boolean;
  /** How sure it is the sentence was for Kik, 0 to 1. */
  addr: number;
  dest: Route | "reflex" | "drop";
  reflex: Reflex | null;
  job: string | null;
  open: string | null;
  project: string | null;
  /** Jev's confidence in the route; null when the rules decided. */
  conf: number | null;
  busy: boolean;
}

export const PROJECTS = ["storefront", "marine", "billiar"];

/** Every way Whisper has spelled the name. */
const NAME = /\b(kik|kick|kikk|kiq|kic|kyk)\b/i;
const LEAD = /^(hey |ok |okay )?(kik|kick|kikk|kiq|kic|kyk)[,\s]*/;
const AGENT = /^(tell|ask|have|get) (it|the agent|claude) (to )?(.+)$/;
const COMMAND = /^(open|tell|ask|have|make|draw|switch|think|show|start|run|put|stop|sketch)\b/;

/** A made-up stand-in for Jev's yes/no: cues that a sentence was for Kik. */
export function addressee(low: string): number {
  let p = 0.45;
  if (/\?$/.test(low) || /^(and |so |but )?(what|how|did|does|is|are|can|could|why)\b/.test(low))
    p += 0.25;
  if (COMMAND.test(low)) p += 0.4;
  if (/\b(it|the agent|claude|the build|the tests?)\b/.test(low)) p += 0.12;
  if (
    /\b(mum|mom|dad|babe|honey|dinner|lunch|lol|the cat|the dog|dentist|call you|down in)\b/.test(
      low,
    )
  )
    p -= 0.55;
  return Math.max(0.02, Math.min(0.97, p));
}

export function decide(text: string, ctx: Context, known?: number): Decision {
  const low = text
    .toLowerCase()
    .trim()
    .replace(/[.!]+$/, "");
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const named = NAME.test(low);
  const body = low.replace(LEAD, "").replace(/[?.!]+$/, "");
  const base: Decision = {
    text,
    words,
    named,
    jev: ctx.jev,
    addr: 1,
    dest: "kik",
    reflex: null,
    job: null,
    open: null,
    project: null,
    conf: null,
    busy: ctx.busy,
  };

  // Reflexes come first: never sent to a model, whoever it was said to.
  if (/^(stop|quiet|shush|be quiet|hush|stop talking)$/.test(body))
    return { ...base, dest: "reflex", reflex: "quiet" };
  if (body === "stop the agent") return { ...base, dest: "reflex", reflex: "stop the agent" };
  if (ctx.permission && /^(yes|yeah|yep|go ahead|no|nope|don't)$/.test(body)) {
    const deny = /^(no|nope|don't)$/.test(body);
    return { ...base, dest: "reflex", reflex: deny ? "deny" : "allow" };
  }

  let addr: number;
  if (named) addr = 1;
  else if (ctx.jev) addr = known ?? addressee(low);
  else addr = /\b(you|your)\b/.test(low) || COMMAND.test(low) ? 1 : 0;
  if (addr < 0.5) return { ...base, addr, dest: "drop" };

  let route: Route = "kik";
  let job: string | null = null;
  let open: string | null = null;
  let conf = 0.78;
  let m: RegExpMatchArray | null;
  if (/^think (this|it) through|^think about|\bshould (we|i)\b|\bor\b.*\?$/.test(low)) {
    route = "think";
    job = body.replace(/^think (this|it) through[:,]?\s*/, "");
    conf = 0.93;
  } else if (/new (claude )?session/.test(body)) {
    route = "new_session";
    m = body.match(/tell it to (.+)$/);
    job = m?.[1] ?? null;
    conf = 0.95;
  } else if (/^switch to \w+/.test(body)) {
    route = "switch";
    conf = 0.9;
  } else if (/^open\b/.test(body)) {
    conf = 0.9;
    if (/\bhere\b/.test(body)) {
      route = "canvas";
      open = "web card";
    } else {
      route = "open";
      if (/vs ?code|editor|cursor/.test(body)) open = "editor";
      else if (/terminal/.test(body)) open = "terminal";
      else if (/folder|explorer/.test(body)) open = "folder";
      else if (/\.(com|org|io|dev)|youtube|github|google/.test(body)) open = "website";
      else open = "editor";
    }
  } else if (
    /^(make|draw|sketch|put|show|write) (me )?/.test(body) &&
    /(checklist|diagram|flow|page|chart|list|table|plan)/.test(body)
  ) {
    route = "canvas";
    job = body;
    conf = 0.88;
  } else if (AGENT.test(body)) {
    route = "agent";
    job = body.match(AGENT)?.[4] ?? null;
    conf = 0.92;
  }

  return {
    ...base,
    addr,
    dest: route,
    job,
    open,
    project: PROJECTS.find((p) => body.includes(p)) ?? null,
    conf: ctx.jev ? conf : null,
  };
}
