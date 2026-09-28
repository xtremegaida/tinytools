import type { Anchor } from "./comment.js";
import { isBlank, normalizeCodeLine, similarity } from "./hash.js";

export type MatchTier = "exact" | "partial" | "fuzzy";

export interface AnchorMatch {
  /** Index into the current line array the comment re-enters at. */
  at: number;
  tier: MatchTier;
  /** True when the stored anchor no longer describes the code around it. */
  reanchor: boolean;
}

export interface MatchOptions {
  fuzzyThreshold: number;
}

/** A view of the file reduced to its non-blank lines, in normalised form. */
export interface CodeView {
  /** Original line index of each entry. */
  index: number[];
  /** Normalised text of each entry. */
  norm: string[];
  lineCount: number;
}

export function buildCodeView(lines: readonly string[]): CodeView {
  const index: number[] = [];
  const norm: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBlank(lines[i]!)) continue;
    index.push(i);
    norm.push(normalizeCodeLine(lines[i]!));
  }
  return { index, norm, lineCount: lines.length };
}

interface Scored {
  p: number;
  sBefore: number;
  sAfter: number;
  total: number;
}

/**
 * How much of the stored context still matches at code position `p`.
 *
 * `afterOffset` is 0 when the comment sits before position `p`, and 1 when `p`
 * is the comment's own host line and the trailing window starts after it.
 */
function score(view: CodeView, p: number, anchor: Anchor, afterOffset: number): Scored {
  let sBefore = 0;
  for (let k = anchor.before.length - 1, q = p - 1; k >= 0 && q >= 0; k--, q--) {
    if (anchor.before[k] !== view.norm[q]) break;
    sBefore++;
  }

  let sAfter = 0;
  for (let k = 0, q = p + afterOffset; k < anchor.after.length && q < view.norm.length; k++, q++) {
    if (anchor.after[k] !== view.norm[q]) break;
    sAfter++;
  }

  return { p, sBefore, sAfter, total: sBefore + sAfter };
}

/**
 * Choose between equally-scoring candidates using the stored line hint.
 *
 * Returns undefined when two candidates are equally close, because the caller's
 * contract is to orphan an ambiguous comment rather than guess at its home.
 */
function pickByHint(candidates: readonly number[], hintLine: number): number | undefined {
  if (candidates.length === 1) return candidates[0]!;

  let best: number | undefined;
  let bestDistance = Infinity;
  let tied = false;

  for (const at of candidates) {
    const d = Math.abs(at - hintLine);
    if (d < bestDistance) {
      bestDistance = d;
      best = at;
      tied = false;
    } else if (d === bestDistance) {
      tied = true;
    }
  }

  return tied ? undefined : best;
}

function toLineIndex(view: CodeView, p: number): number {
  return p < view.index.length ? view.index[p]! : view.lineCount;
}

/**
 * Locate an own-line comment in the current file.
 *
 * Tiers, in order: both context windows intact (place, no re-anchor); one
 * window intact (place and re-anchor — this is the "code was deleted next to
 * the comment" case); a unique strong fuzzy match (place and re-anchor);
 * otherwise undefined, meaning orphan.
 */
export function matchOwnLine(
  lines: readonly string[],
  anchor: Anchor,
  hintLine: number,
  options: MatchOptions,
): AnchorMatch | undefined {
  const view = buildCodeView(lines);

  // A comment whose file had no code at all: there is only one place it can go.
  if (anchor.before.length === 0 && anchor.after.length === 0) {
    if (view.norm.length === 0) return { at: 0, tier: "exact", reanchor: false };
    return undefined;
  }

  const scores: Scored[] = [];
  for (let p = 0; p <= view.norm.length; p++) {
    scores.push(score(view, p, anchor, 0));
  }

  const exact = scores.filter(
    (s) => s.sBefore === anchor.before.length && s.sAfter === anchor.after.length,
  );
  if (exact.length > 0) {
    const at = pickByHint(exact.map((s) => toLineIndex(view, s.p)), hintLine);
    if (at !== undefined) return { at, tier: "exact", reanchor: false };
    return undefined;
  }

  // One side intact is still a confident placement; the other side changed, so
  // the stored anchor needs rewriting.
  const partial = scores.filter(
    (s) =>
      (anchor.before.length > 0 && s.sBefore === anchor.before.length) ||
      (anchor.after.length > 0 && s.sAfter === anchor.after.length),
  );
  if (partial.length > 0) {
    const best = Math.max(...partial.map((s) => s.total));
    const top = partial.filter((s) => s.total === best);
    const at = pickByHint(top.map((s) => toLineIndex(view, s.p)), hintLine);
    if (at !== undefined) return { at, tier: "partial", reanchor: true };
    return undefined;
  }

  const fuzzy = bestFuzzy(view, anchor, options.fuzzyThreshold);
  if (fuzzy !== undefined) {
    return { at: toLineIndex(view, fuzzy), tier: "fuzzy", reanchor: true };
  }

  return undefined;
}

/**
 * Locate a comment that shares its line with code.
 *
 * `allowFuzzy` is false for inline comments: their stored column points into
 * the middle of the line, so placing one against a line that merely resembles
 * the original would drop it in the wrong place. Trailing comments append to
 * the end of the line and are safe to place fuzzily.
 */
export function matchHost(
  lines: readonly string[],
  anchor: Anchor,
  hintLine: number,
  options: MatchOptions,
  allowFuzzy: boolean,
): AnchorMatch | undefined {
  if (anchor.host === undefined) return undefined;
  const view = buildCodeView(lines);

  const exactHosts: Scored[] = [];
  for (let p = 0; p < view.norm.length; p++) {
    if (view.norm[p] === anchor.host) exactHosts.push(score(view, p, anchor, 1));
  }

  if (exactHosts.length > 0) {
    const full = exactHosts.filter(
      (s) => s.sBefore === anchor.before.length && s.sAfter === anchor.after.length,
    );
    if (full.length > 0) {
      const at = pickByHint(full.map((s) => view.index[s.p]!), hintLine);
      if (at !== undefined) return { at, tier: "exact", reanchor: false };
      return undefined;
    }

    const best = Math.max(...exactHosts.map((s) => s.total));
    const top = exactHosts.filter((s) => s.total === best);
    const at = pickByHint(top.map((s) => view.index[s.p]!), hintLine);
    if (at !== undefined) return { at, tier: "partial", reanchor: true };
    return undefined;
  }

  if (!allowFuzzy) return undefined;

  let best: number | undefined;
  let bestScore = 0;
  let runnerUp = 0;
  for (let p = 0; p < view.norm.length; p++) {
    const sim = similarity(anchor.host, view.norm[p]!);
    if (sim > bestScore) {
      runnerUp = bestScore;
      bestScore = sim;
      best = p;
    } else if (sim > runnerUp) {
      runnerUp = sim;
    }
  }

  if (best !== undefined && bestScore >= options.fuzzyThreshold && bestScore - runnerUp >= 0.05) {
    return { at: view.index[best]!, tier: "fuzzy", reanchor: true };
  }
  return undefined;
}

/**
 * Best fuzzy placement for an own-line comment.
 *
 * Scores each position on how closely the nearest stored context line resembles
 * the code actually there. Requires a clear winner — a near-tie means two sites
 * look equally plausible, which is exactly when guessing is unacceptable.
 */
function bestFuzzy(view: CodeView, anchor: Anchor, threshold: number): number | undefined {
  const nearestAfter = anchor.after[0];
  const nearestBefore = anchor.before[anchor.before.length - 1];

  let best: number | undefined;
  let bestScore = 0;
  let runnerUp = 0;

  for (let p = 0; p <= view.norm.length; p++) {
    const sims: number[] = [];
    if (nearestAfter !== undefined && p < view.norm.length) {
      sims.push(similarity(nearestAfter, view.norm[p]!));
    }
    if (nearestBefore !== undefined && p > 0) {
      sims.push(similarity(nearestBefore, view.norm[p - 1]!));
    }
    if (sims.length === 0) continue;

    const s = Math.max(...sims);
    if (s > bestScore) {
      runnerUp = bestScore;
      bestScore = s;
      best = p;
    } else if (s > runnerUp) {
      runnerUp = s;
    }
  }

  if (best !== undefined && bestScore >= threshold && bestScore - runnerUp >= 0.05) {
    return best;
  }
  return undefined;
}
