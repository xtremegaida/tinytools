import { createHash } from "node:crypto";

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Reduce a code line to its anchoring identity.
 *
 * Trimming plus whitespace collapse is what makes reindentation and line moves
 * free: neither changes the normalised form, so neither can trigger a
 * re-anchor. Case and punctuation are preserved because code is case-sensitive
 * and both carry real signal.
 */
export function normalizeCodeLine(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

export function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/** Leading whitespace of a line. */
export function indentOf(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : "";
}

/**
 * Sørensen–Dice coefficient over character bigrams, in [0, 1].
 *
 * Chosen over edit distance because it is linear, order-tolerant, and behaves
 * sensibly on code lines where a rename shifts many characters but leaves most
 * structure intact.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    bigrams.set(g, (bigrams.get(g) ?? 0) + 1);
  }

  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const count = bigrams.get(g) ?? 0;
    if (count > 0) {
      bigrams.set(g, count - 1);
      hits++;
    }
  }

  return (2 * hits) / (a.length - 1 + (b.length - 1));
}
