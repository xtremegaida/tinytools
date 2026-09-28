/** Core comment types shared by the lexers, stripper, and restorer. */

export type CommentKind = "line" | "block";

export type CommentClass = "ordinary" | "doc" | "license" | "pragma" | "region";

/**
 * Where a comment sits relative to the code that survives stripping.
 *
 * - `leading`  — on its own line(s), attached to the retained line below it
 * - `header`   — on its own line(s) with no retained content above it
 * - `footer`   — on its own line(s) with no retained content below it
 * - `trailing` — shares a line with code, nothing retained after it
 * - `inline`   — shares a line with code on both sides, e.g. `foo(/* a *\/ 1)`
 */
export type Placement = "leading" | "header" | "footer" | "trailing" | "inline";

export interface Pos {
  /** 0-based. */
  line: number;
  /** 0-based character offset within the line. */
  col: number;
}

/** A raw comment as located by a language lexer. */
export interface CommentSpan {
  kind: CommentKind;
  start: Pos;
  /** Exclusive. */
  end: Pos;
  /** Verbatim source text, including the `//` or `/* *\/` markers. */
  text: string;
}

/**
 * Anchoring context: the normalised text of retained lines around the comment.
 *
 * Built against the *stripped* line array, never the original, because that is
 * what a later restore will actually be matching against.
 */
export interface Anchor {
  before: string[];
  after: string[];
  /** For `trailing`/`inline`: the normalised stripped line the comment lives on. */
  host?: string;
}

/** A comment lifted out of a file, ready to be stored. */
export interface ExtractedComment {
  kind: CommentKind;
  cls: CommentClass;
  placement: Placement;
  /**
   * 1-based index of the stripped line this comment attaches to (`at + 1`).
   *
   * Deliberately in stripped-file coordinates rather than original ones, so it
   * is directly comparable to a candidate match position when breaking ties.
   */
  line: number;
  /** Common leading whitespace removed from `text`; re-applied on restore. */
  indent: string;
  /** Comment body, lines joined with `\n`, indent removed. */
  text: string;
  /** Blank lines that sat directly above the block and were absorbed. */
  blankAbove: number;
  /** Blank lines that sat directly below the block and were absorbed. */
  blankBelow: number;
  /** Index into the stripped line array this comment re-enters at. */
  at: number;
  /** Same-line placements: character offset within the stripped host line. */
  stripCol?: number;
  /** Same-line placements: length of the separator strip left behind. */
  sepLen?: number;
  /** Same-line placements: whitespace that preceded the comment. */
  padBefore?: string;
  /** Same-line placements: whitespace that followed the comment. */
  padAfter?: string;
  anchor: Anchor;
}
