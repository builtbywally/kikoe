/**
 * What Kik may do on its own, and what it must ask for.
 *
 * `docs/OS.md`, gate 3: before Kik gets hands, every action it can take is
 * graded, and the grade decides — never the model, never a setting.
 *
 *   read          looking: the screen, the window list, a file's contents.
 *                 Free: nothing changes.
 *   write         doing: typing, clicking, opening, writing a file. Asked for
 *                 aloud, through the same prompt Claude Code's permissions use.
 *   irreversible  what cannot be taken back: deleting, sending, publishing,
 *                 paying, shutting down. Always asked, said as such, and never
 *                 auto-approvable — there is no "always allow" for these, and
 *                 nothing may ever add one.
 *
 * The grade comes from what the action is plus what it says it will do:
 * "type" is a write, "type into the email and press send" is irreversible.
 * When in doubt, the stricter grade.
 */

export type Grade = "read" | "write" | "irreversible";

/** Words that make any action one that cannot be undone. */
const IRREVERSIBLE =
  /\b(delete|deletes|deleting|remove|removes|rm|rmdir|erase|wipe|format|empty (the )?(recycle|trash|bin)|send|sends|sending|submit|email|e-mail|mail|post|posts|publish|tweet|reply all|buy|purchase|pay|payment|checkout|check out|order|transfer|wire|shut ?down|restart|reboot|log ?off|sign ?out|uninstall|drop table|force push|push --force|overwrite)\b/i;

/**
 * The grade of an action: `kind` is what the tool declares itself to be,
 * `detail` everything it will do (the text to type, the keys, the target).
 */
export function gradeOf(kind: "read" | "write", detail = ""): Grade {
  if (kind === "read") return "read";
  return IRREVERSIBLE.test(detail) ? "irreversible" : "write";
}

/** Must the user say yes first? Anything but a read. */
export function mustAsk(grade: Grade): boolean {
  return grade !== "read";
}

/** The question, as Kik says it. An irreversible one says so first. */
export function askLine(what: string, grade: Grade): string {
  const q = what.trim().replace(/[.?!]+$/, "");
  return grade === "irreversible"
    ? `This one can't be undone: ${q}. Shall I?`
    : `${q.charAt(0).toUpperCase()}${q.slice(1)}. Shall I?`;
}
