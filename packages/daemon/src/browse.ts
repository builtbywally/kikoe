/**
 * Driving a web card by voice: "go back", "reload the page", "go to
 * github", "zoom in". The Room does the driving (its webview has the
 * history); this only says what was asked. Heard only while a web card is
 * on the board in front, so "go back" means the page, not something else.
 */

export type BrowseAction = "back" | "forward" | "reload" | "stop" | "go" | "zoom-in" | "zoom-out";

export interface BrowseAsk {
  action: BrowseAction;
  url?: string;
}

const LEAD = /^(?:(?:okay|ok|so|now|please|can you|could you|kik\w*)[\s,.]+)*/i;

/** What was asked of the page, or null. */
export function browseAsk(text: string): BrowseAsk | null {
  const t = text
    .trim()
    .replace(LEAD, "")
    .replace(/[.!?]+$/, "")
    .trim();
  if (!t) return null;
  if (
    /^(?:go\s+)?back(?:\s+(?:a|one)\s+page)?(?:\s+please)?$|^(?:go|navigate)\s+back\b(?!\s+to\b)/i.test(
      t,
    )
  )
    return { action: "back" };
  if (/^(?:go\s+)?forward(?:\s+(?:a|one)\s+page)?$|^(?:go|navigate)\s+forward\b/i.test(t))
    return { action: "forward" };
  if (
    /^(?:reload|refresh)(?:\s+(?:the|this|that)\s+(?:page|site|card|tab))?(?:\s+(?:it|please))?$/i.test(
      t,
    )
  )
    return { action: "reload" };
  if (/^stop\s+loading\b/i.test(t)) return { action: "stop" };
  if (/^zoom\s+in\b|^make\s+(?:it|the\s+page)\s+(?:bigger|larger)\b/i.test(t))
    return { action: "zoom-in" };
  if (/^zoom\s+out\b|^make\s+(?:it|the\s+page)\s+smaller\b/i.test(t)) return { action: "zoom-out" };
  const go = /^(?:go|navigate|head)\s+to\s+(.+)$/i.exec(t)?.[1]?.trim();
  if (go) return { action: "go", url: addressFor(go) };
  return null;
}

/**
 * A spoken place to an address: "github" is github.com, "localhost 3000"
 * is http://localhost:3000, "google.com slash maps" is google.com/maps.
 */
export function addressFor(said: string): string {
  const s = said
    .trim()
    .replace(/^(?:the\s+)?(?:website|site|page)\s+/i, "")
    .replace(/\s+(?:dot)\s+/gi, ".")
    .replace(/\s+slash\s+/gi, "/")
    .replace(/[.,!?]+$/, "");
  const local = /^localhost(?:\s*(?:port\s*)?:?\s*(\d{2,5}))?\s*(\/\S*)?$/i.exec(s);
  if (local) return `http://localhost${local[1] ? `:${local[1]}` : ""}${local[2] ?? ""}`;
  if (/^port\s+(\d{2,5})$/i.test(s)) return `http://localhost:${/(\d+)/.exec(s)?.[1]}`;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s)) return `https://${s}`;
  if (/^[a-z0-9-]+$/i.test(s)) return `https://www.${s.toLowerCase()}.com`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}
