import type { Pos } from "../comment.js";

/**
 * Maps character offsets in a `\n`-joined source back to line/column.
 *
 * Lexers run over text joined with plain `\n` regardless of the file's real
 * terminators, which keeps EOL handling entirely out of the language scanners.
 */
export class LineMap {
  private readonly starts: number[];

  constructor(text: string) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") starts.push(i + 1);
    }
    this.starts = starts;
  }

  posAt(offset: number): Pos {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, col: offset - this.starts[lo]! };
  }
}

export function isWordChar(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c);
}
