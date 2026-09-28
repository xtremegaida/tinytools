import type { Placement } from "./comment.js";
import { isBlank } from "./hash.js";

/** A comment whose insertion point in the current file has already been resolved. */
export interface ResolvedComment {
  placement: Placement;
  /** Index into the current line array this comment re-enters at. */
  at: number;
  /** Original line, used only to order comments landing at the same point. */
  line: number;
  indent: string;
  text: string;
  blankAbove: number;
  blankBelow: number;
  stripCol?: number;
  sepLen?: number;
  padBefore?: string;
  padAfter?: string;
}

function isSameLine(c: ResolvedComment): boolean {
  return c.stripCol !== undefined;
}

/**
 * Put comments back into a stripped line array.
 *
 * Own-line blocks replace the blank run that strip left in their place, which
 * is what makes `restore(strip(f)) === f` hold: strip collapsed
 * `blankAbove + block + blankBelow` down to `max(blankAbove, blankBelow)` blank
 * lines, and this expands that same run back out.
 */
export function restore(
  lines: readonly string[],
  comments: readonly ResolvedComment[],
): string[] {
  const ownByAt = new Map<number, ResolvedComment[]>();
  const sameByAt = new Map<number, ResolvedComment[]>();

  for (const c of comments) {
    const target = isSameLine(c) ? sameByAt : ownByAt;
    const list = target.get(c.at);
    if (list) list.push(c);
    else target.set(c.at, [c]);
  }
  // Ties are broken on text so the output stays deterministic when two comments
  // re-anchor onto the same point.
  const byText = (a: ResolvedComment, b: ResolvedComment): number =>
    a.text < b.text ? -1 : a.text > b.text ? 1 : 0;

  for (const list of ownByAt.values()) list.sort((a, b) => a.line - b.line || byText(a, b));
  for (const list of sameByAt.values()) {
    list.sort(
      (a, b) => (a.stripCol ?? 0) - (b.stripCol ?? 0) || a.line - b.line || byText(a, b),
    );
  }

  const out: string[] = [];

  for (let i = 0; i <= lines.length; i++) {
    const own = ownByAt.get(i);
    if (own && own.length > 0) {
      // Reclaim the blank run strip left behind before rebuilding the original.
      while (out.length > 0 && isBlank(out[out.length - 1]!)) out.pop();

      for (const c of own) {
        for (let k = 0; k < c.blankAbove; k++) out.push("");
        for (const line of c.text.split("\n")) {
          out.push(line === "" ? "" : c.indent + line);
        }
        for (let k = 0; k < c.blankBelow; k++) out.push("");
      }
    }

    if (i === lines.length) break;

    const same = sameByAt.get(i);
    if (same && same.length > 0) out.push(...applySameLine(lines[i]!, same));
    else out.push(lines[i]!);
  }

  return out;
}

/**
 * Re-insert comments that shared a line with code.
 *
 * Applied right-to-left so an earlier insertion never shifts the offsets of a
 * later one. A comment whose text spans lines splits the host line back apart.
 */
function applySameLine(line: string, comments: readonly ResolvedComment[]): string[] {
  let s = line;
  for (let k = comments.length - 1; k >= 0; k--) {
    const c = comments[k]!;
    const col = Math.min(c.stripCol ?? 0, s.length);
    const sepLen = c.sepLen ?? 0;
    s =
      s.slice(0, col) +
      (c.padBefore ?? "") +
      c.text +
      (c.padAfter ?? "") +
      s.slice(col + sepLen);
  }
  return s.split("\n");
}
