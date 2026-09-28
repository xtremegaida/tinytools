import type {
  Anchor,
  CommentClass,
  CommentKind,
  CommentSpan,
  ExtractedComment,
  Placement,
} from "./comment.js";
import { indentOf, isBlank, normalizeCodeLine } from "./hash.js";

export interface SpanWithClass {
  span: CommentSpan;
  cls: CommentClass;
}

export interface StripResult {
  lines: string[];
  comments: ExtractedComment[];
}

interface Removal {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  text: string;
  cls: CommentClass;
  kind: CommentKind;
}

interface SameLineGroup {
  startLine: number;
  endLine: number;
  removals: Removal[];
}

/** A `[start, end)` range of columns covered by a comment on one line. */
interface Range {
  start: number;
  end: number;
}

/**
 * Remove comments from a line array.
 *
 * Own-line comments are grouped into runs together with the blank lines that
 * touch them; the run collapses to `max(blankAbove, blankBelow)` blank lines so
 * the stripped code keeps sensible spacing, and both counts are recorded so the
 * original spacing can be rebuilt exactly.
 *
 * Comments sharing a line with code are removed in place, with the surrounding
 * whitespace collapsed to whatever the junction needs, and the removed padding
 * recorded verbatim.
 */
export function strip(
  lines: readonly string[],
  items: readonly SpanWithClass[],
  anchorWindow: number,
): StripResult {
  const removals: Removal[] = items.map(({ span, cls }) => ({
    startLine: span.start.line,
    startCol: span.start.col,
    endLine: span.end.line,
    endCol: span.end.col,
    text: span.text,
    cls,
    kind: span.kind,
  }));
  removals.sort((a, b) => a.startLine - b.startLine || a.startCol - b.startCol);

  const coverage = buildCoverage(lines, removals);
  const blanked = lines.map((line, i) => blankOut(line, coverage.get(i)));

  const removable = (i: number): boolean =>
    (coverage.get(i)?.length ?? 0) > 0 && blanked[i]!.trim() === "";

  // Split removals by whether they share their line with surviving code.
  const ownLine: Removal[] = [];
  const sameLine: Removal[] = [];
  for (const r of removals) {
    const beforeBlank = blanked[r.startLine]!.slice(0, r.startCol).trim() === "";
    const afterBlank = blanked[r.endLine]!.slice(r.endCol).trim() === "";
    if (beforeBlank && afterBlank) ownLine.push(r);
    else sameLine.push(r);
  }

  const groups = groupSameLine(sameLine);
  const consumed = new Set<number>();
  for (const g of groups) {
    for (let l = g.startLine; l <= g.endLine; l++) consumed.add(l);
  }
  const groupByStart = new Map(groups.map((g) => [g.startLine, g]));

  // `consumed` already excludes every line claimed by a same-line group, so any
  // remaining fully-covered line belongs to an own-line block.
  const runs = findRuns(lines, consumed, removable);
  const runByStart = new Map(runs.map((r) => [r.start, r]));

  const out: string[] = [];
  const staged: StagedComment[] = [];

  let i = 0;
  while (i < lines.length) {
    const group = groupByStart.get(i);
    if (group) {
      const built = buildSameLineGroup(lines, group);
      const at = out.length;
      out.push(built.hostLine);
      for (const p of built.placements) {
        staged.push({
          at,
          placement: p.padAfterIsEndOfLine ? "trailing" : "inline",
          kind: p.kind,
          cls: p.cls,
          line: at + 1,
          indent: "",
          text: p.text,
          blankAbove: 0,
          blankBelow: 0,
          stripCol: p.stripCol,
          sepLen: p.sepLen,
          padBefore: p.padBefore,
          padAfter: p.padAfter,
        });
      }
      i = group.endLine + 1;
      continue;
    }

    const run = runByStart.get(i);
    if (run) {
      let firstRemovable = run.start;
      while (firstRemovable < run.end && !removable(firstRemovable)) firstRemovable++;
      let lastRemovable = run.end - 1;
      while (lastRemovable > run.start && !removable(lastRemovable)) lastRemovable--;

      const blankAbove = firstRemovable - run.start;
      const blankBelow = run.end - 1 - lastRemovable;

      // Keeping a leading or trailing blank line at the file boundary would be
      // a visible change to code Sideline promised not to touch.
      const atFileStart = run.start === 0;
      const atFileEnd = run.end === lines.length;
      const inserted = atFileStart || atFileEnd ? 0 : Math.max(blankAbove, blankBelow);
      for (let k = 0; k < inserted; k++) out.push("");

      const core = lines.slice(firstRemovable, lastRemovable + 1);
      const indent = extractIndent(core);
      const first = ownLine.find(
        (r) => r.startLine >= firstRemovable && r.startLine <= lastRemovable,
      );

      staged.push({
        at: out.length,
        placement: "leading", // refined once the full stripped array exists
        kind: first?.kind ?? "line",
        cls: first?.cls ?? "ordinary",
        line: out.length + 1,
        indent,
        text: core.map((l) => (l === "" ? "" : l.slice(indent.length))).join("\n"),
        blankAbove,
        blankBelow,
      });

      i = run.end;
      continue;
    }

    out.push(lines[i]!);
    i++;
  }

  const comments = staged.map((s) => finalize(s, out, anchorWindow));
  return { lines: out, comments };
}

interface StagedComment {
  at: number;
  placement: Placement;
  kind: CommentKind;
  cls: CommentClass;
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

function finalize(
  s: StagedComment,
  out: readonly string[],
  anchorWindow: number,
): ExtractedComment {
  const sameLine = s.stripCol !== undefined;
  const placement: Placement = sameLine
    ? s.placement
    : hasContentBefore(out, s.at)
      ? hasContentFrom(out, s.at)
        ? "leading"
        : "footer"
      : "header";

  const anchor = sameLine
    ? buildAnchor(out, s.at, s.at + 1, anchorWindow, normalizeCodeLine(out[s.at] ?? ""))
    : buildAnchor(out, s.at, s.at, anchorWindow);

  const comment: ExtractedComment = {
    kind: s.kind,
    cls: s.cls,
    placement,
    line: s.line,
    indent: s.indent,
    text: s.text,
    blankAbove: s.blankAbove,
    blankBelow: s.blankBelow,
    at: s.at,
    anchor,
  };
  if (sameLine) {
    comment.stripCol = s.stripCol;
    comment.sepLen = s.sepLen;
    comment.padBefore = s.padBefore;
    comment.padAfter = s.padAfter;
  }
  return comment;
}

function hasContentBefore(out: readonly string[], at: number): boolean {
  for (let k = at - 1; k >= 0; k--) if (!isBlank(out[k]!)) return true;
  return false;
}

function hasContentFrom(out: readonly string[], at: number): boolean {
  for (let k = at; k < out.length; k++) if (!isBlank(out[k]!)) return true;
  return false;
}

/**
 * Collect the normalised text of the nearest non-blank lines on each side.
 *
 * Blank lines are skipped because their count drifts freely and they carry no
 * identifying signal.
 */
export function buildAnchor(
  out: readonly string[],
  beforeFrom: number,
  afterFrom: number,
  window: number,
  host?: string,
): Anchor {
  const before: string[] = [];
  for (let k = beforeFrom - 1; k >= 0 && before.length < window; k--) {
    if (isBlank(out[k]!)) continue;
    before.unshift(normalizeCodeLine(out[k]!));
  }

  const after: string[] = [];
  for (let k = afterFrom; k < out.length && after.length < window; k++) {
    if (isBlank(out[k]!)) continue;
    after.push(normalizeCodeLine(out[k]!));
  }

  return host !== undefined ? { before, after, host } : { before, after };
}

function buildCoverage(
  lines: readonly string[],
  removals: readonly Removal[],
): Map<number, Range[]> {
  const coverage = new Map<number, Range[]>();
  const add = (line: number, start: number, end: number): void => {
    const list = coverage.get(line);
    if (list) list.push({ start, end });
    else coverage.set(line, [{ start, end }]);
  };

  for (const r of removals) {
    if (r.startLine === r.endLine) {
      add(r.startLine, r.startCol, r.endCol);
      continue;
    }
    add(r.startLine, r.startCol, lines[r.startLine]!.length);
    for (let l = r.startLine + 1; l < r.endLine; l++) add(l, 0, lines[l]!.length);
    add(r.endLine, 0, r.endCol);
  }
  return coverage;
}

/** Replace every covered range with spaces, preserving column positions. */
function blankOut(line: string, ranges: Range[] | undefined): string {
  if (!ranges || ranges.length === 0) return line;
  const chars = [...line];
  for (const r of ranges) {
    for (let c = r.start; c < Math.min(r.end, chars.length); c++) chars[c] = " ";
  }
  return chars.join("");
}

function groupSameLine(removals: readonly Removal[]): SameLineGroup[] {
  const groups: SameLineGroup[] = [];
  for (const r of removals) {
    const last = groups[groups.length - 1];
    if (last && r.startLine <= last.endLine) {
      last.endLine = Math.max(last.endLine, r.endLine);
      last.removals.push(r);
      continue;
    }
    groups.push({ startLine: r.startLine, endLine: r.endLine, removals: [r] });
  }
  return groups;
}

/**
 * Maximal runs of lines that are removable or blank and contain at least one
 * removable line. Lines already claimed by a same-line group are excluded.
 */
function findRuns(
  lines: readonly string[],
  consumed: ReadonlySet<number>,
  removable: (i: number) => boolean,
): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = [];
  const eligible = (i: number): boolean =>
    !consumed.has(i) && (removable(i) || isBlank(lines[i]!));

  let i = 0;
  while (i < lines.length) {
    if (!eligible(i)) {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && eligible(j)) j++;

    let hasRemovable = false;
    for (let k = i; k < j; k++) {
      if (removable(k)) {
        hasRemovable = true;
        break;
      }
    }
    if (hasRemovable) runs.push({ start: i, end: j });
    i = j;
  }
  return runs;
}

interface SameLinePlacement {
  stripCol: number;
  sepLen: number;
  padBefore: string;
  padAfter: string;
  text: string;
  kind: CommentKind;
  cls: CommentClass;
  padAfterIsEndOfLine: boolean;
}

/**
 * Rebuild a run of lines that mixes code and comments into a single line.
 *
 * A comment spanning lines joins its prefix and suffix, so the group collapses
 * to one line. Offsets are recorded against that final line and restored
 * right-to-left so earlier insertions do not shift later ones.
 */
function buildSameLineGroup(
  lines: readonly string[],
  group: SameLineGroup,
): { hostLine: string; placements: SameLinePlacement[] } {
  const region = lines.slice(group.startLine, group.endLine + 1).join("\n");

  const lineStarts: number[] = [];
  {
    let offset = 0;
    for (let l = group.startLine; l <= group.endLine; l++) {
      lineStarts.push(offset);
      offset += lines[l]!.length + 1;
    }
  }
  const abs = (line: number, col: number): number =>
    lineStarts[line - group.startLine]! + col;

  const ranges = group.removals
    .map((r) => ({
      start: abs(r.startLine, r.startCol),
      end: abs(r.endLine, r.endCol),
      text: r.text,
      kind: r.kind,
      cls: r.cls,
    }))
    .sort((a, b) => a.start - b.start);

  const placements: SameLinePlacement[] = [];
  let out = "";
  let cursor = 0;

  for (let n = 0; n < ranges.length; n++) {
    const r = ranges[n]!;
    out += region.slice(cursor, r.start);

    // Trailing whitespace is absorbed, except when it is the line's own
    // indentation — dropping that would reformat code Sideline must not touch.
    const trimmed = out.replace(/[ \t]+$/, "");
    let padBefore = "";
    if (trimmed !== "") {
      padBefore = out.slice(trimmed.length);
      out = trimmed;
    }

    const padAfter = /^[ \t]*/.exec(region.slice(r.end))![0];
    const nextChar = nextKeptNonSpace(region, r.end, ranges, n + 1);

    // The comment was padded on both sides, so the code either side was never
    // adjacent: leave one space behind. Padding on only one side means the
    // comment was hugging a bracket or separator, where a space would be wrong
    // (`foo(/* a */ 1)` -> `foo(1)`, `foo(1 /* a */, 2)` -> `foo(1, 2)`).
    const sep = padBefore !== "" && padAfter !== "" ? " " : "";

    placements.push({
      stripCol: out.length,
      sepLen: sep.length,
      padBefore,
      padAfter,
      text: r.text,
      kind: r.kind,
      cls: r.cls,
      padAfterIsEndOfLine: nextChar === "",
    });

    out += sep;
    cursor = r.end + padAfter.length;
  }

  out += region.slice(cursor);
  return { hostLine: out, placements };
}

/**
 * The first character after `from` that survives stripping, skipping whitespace
 * and any later comment ranges. Drives the separator decision.
 */
function nextKeptNonSpace(
  region: string,
  from: number,
  ranges: readonly { start: number; end: number }[],
  nextRangeIndex: number,
): string {
  let pos = from;
  let ri = nextRangeIndex;
  while (pos < region.length) {
    if (ri < ranges.length && pos === ranges[ri]!.start) {
      pos = ranges[ri]!.end;
      ri++;
      continue;
    }
    const c = region[pos]!;
    if (c === " " || c === "\t" || c === "\n") {
      pos++;
      continue;
    }
    return c;
  }
  return "";
}

/**
 * Longest common leading whitespace of the block's non-blank lines.
 *
 * Bails out to no indent when a blank line inside the block carries whitespace,
 * since re-emitting such a line exactly would otherwise be impossible.
 */
export function extractIndent(core: readonly string[]): string {
  const blanksAreEmpty = core.every((l) => !isBlank(l) || l === "");
  if (!blanksAreEmpty) return "";

  const nonBlank = core.filter((l) => !isBlank(l));
  if (nonBlank.length === 0) return "";

  let indent = indentOf(nonBlank[0]!);
  for (let i = 1; i < nonBlank.length; i++) {
    const other = indentOf(nonBlank[i]!);
    let k = 0;
    while (k < indent.length && k < other.length && indent[k] === other[k]) k++;
    indent = indent.slice(0, k);
    if (indent === "") break;
  }
  return indent;
}
