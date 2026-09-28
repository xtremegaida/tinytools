import { matchHost, matchOwnLine } from "./anchor.js";
import type { Anchor, ExtractedComment } from "./comment.js";
import type { Config } from "./config.js";
import type { Encoding, EolStyle } from "./eol.js";
import { normalizeCodeLine, similarity } from "./hash.js";
import { buildAnchor } from "./strip.js";
import {
  commentId,
  normalizeForId,
  type StoredComment,
  type StoredFile,
} from "./store.js";

export interface ReconcileInput {
  path: string;
  existing: StoredFile | undefined;
  /** Comments just lifted out of the file. */
  found: readonly ExtractedComment[];
  /** The file with those comments removed. */
  strippedLines: readonly string[];
  codeSha: string;
  sourceSha: string;
  eol: EolStyle;
  finalNewline: boolean;
  encoding: Encoding;
  config: Config;
  /** Ids already in use across the whole store, for collision avoidance. */
  takenIds: Set<string>;
  now?: string;
}

export interface ReconcileStats {
  added: number;
  updated: number;
  removed: number;
  retained: number;
  orphaned: number;
  reanchored: number;
}

export interface ReconcileResult {
  file: StoredFile;
  stats: ReconcileStats;
}

const FUZZY_TEXT_THRESHOLD = 0.9;

function anchorsEqual(a: Anchor, b: Anchor): boolean {
  if (a.host !== b.host) return false;
  if (a.before.length !== b.before.length || a.after.length !== b.after.length) return false;
  for (let i = 0; i < a.before.length; i++) if (a.before[i] !== b.before[i]) return false;
  for (let i = 0; i < a.after.length; i++) if (a.after[i] !== b.after[i]) return false;
  return true;
}

/**
 * Merge freshly-extracted comments into what the store already holds.
 *
 * The whole design turns on one question: was this file expected to contain its
 * comments? After an extract it was not, so anything found is a new addition
 * and existing records are kept. After a restore it was, so the comments in the
 * file are authoritative and a record with nothing matching it means the user
 * deleted that comment.
 *
 * Getting that distinction from content alone is impossible — a stripped file
 * and a file whose comments were all deleted look identical — which is why the
 * store tracks state explicitly.
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const { existing, found, config } = input;
  const now = input.now ?? new Date().toISOString();
  const authoritative = existing?.state === "restored";

  const previous = existing?.comments ?? [];
  const pairing = new Array<StoredComment | undefined>(found.length).fill(undefined);
  const usedExisting = new Set<number>();

  const foundKeys = found.map((f) => normalizeForId(f.text));
  const prevKeys = previous.map((e) => normalizeForId(e.text));

  const claim = (fi: number, ei: number): void => {
    pairing[fi] = previous[ei]!;
    usedExisting.add(ei);
  };

  // Pass 1 — identical text sitting in identical context. An unchanged comment.
  for (let fi = 0; fi < found.length; fi++) {
    for (let ei = 0; ei < previous.length; ei++) {
      if (usedExisting.has(ei) || pairing[fi]) continue;
      if (foundKeys[fi] !== prevKeys[ei]) continue;
      if (!anchorsEqual(found[fi]!.anchor, previous[ei]!.anchor)) continue;
      claim(fi, ei);
    }
  }

  // Pass 2 — identical text, in source order. The comment moved with its code.
  for (let fi = 0; fi < found.length; fi++) {
    if (pairing[fi]) continue;
    for (let ei = 0; ei < previous.length; ei++) {
      if (usedExisting.has(ei)) continue;
      if (foundKeys[fi] !== prevKeys[ei]) continue;
      claim(fi, ei);
      break;
    }
  }

  // Pass 3 — near-identical text. The comment's wording was edited; keeping the
  // same record preserves its identity rather than churning a delete and an add.
  for (let fi = 0; fi < found.length; fi++) {
    if (pairing[fi]) continue;
    let bestIndex = -1;
    let bestScore = FUZZY_TEXT_THRESHOLD;
    for (let ei = 0; ei < previous.length; ei++) {
      if (usedExisting.has(ei)) continue;
      const score = similarity(foundKeys[fi]!, prevKeys[ei]!);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = ei;
      }
    }
    if (bestIndex >= 0) claim(fi, bestIndex);
  }

  const stats: ReconcileStats = {
    added: 0,
    updated: 0,
    removed: 0,
    retained: 0,
    orphaned: 0,
    reanchored: 0,
  };

  // Ordinals held by matched records are reserved so their ids stay stable;
  // new records fill the gaps.
  const reserved = new Map<string, Set<number>>();
  for (let fi = 0; fi < found.length; fi++) {
    const prev = pairing[fi];
    if (!prev) continue;
    const key = foundKeys[fi]!;
    const set = reserved.get(key) ?? new Set<number>();
    set.add(prev.ordinal);
    reserved.set(key, set);
  }

  const nextOrdinal = (key: string): number => {
    const set = reserved.get(key) ?? new Set<number>();
    let n = 0;
    while (set.has(n)) n++;
    set.add(n);
    reserved.set(key, set);
    return n;
  };

  const comments: StoredComment[] = [];

  for (let fi = 0; fi < found.length; fi++) {
    const f = found[fi]!;
    const prev = pairing[fi];
    const firstPath = prev?.firstPath || input.path;
    const ordinal = prev ? prev.ordinal : nextOrdinal(foundKeys[fi]!);
    const id = prev?.id ?? commentId(firstPath, f.text, ordinal, input.takenIds);
    input.takenIds.add(id);

    if (prev) stats.updated++;
    else stats.added++;

    const record: StoredComment = {
      id,
      kind: f.kind,
      cls: f.cls,
      placement: f.placement,
      line: f.line,
      indent: f.indent,
      text: f.text,
      blankAbove: f.blankAbove,
      blankBelow: f.blankBelow,
      anchor: f.anchor,
      firstPath,
      ordinal,
    };
    if (f.stripCol !== undefined) {
      record.stripCol = f.stripCol;
      record.sepLen = f.sepLen;
      record.padBefore = f.padBefore;
      record.padAfter = f.padAfter;
    }
    // The comment is demonstrably in the code, so any earlier orphaning is over.
    if (prev?.reanchoredAt) record.reanchoredAt = prev.reanchoredAt;
    comments.push(record);
  }

  for (let ei = 0; ei < previous.length; ei++) {
    if (usedExisting.has(ei)) continue;
    const e = previous[ei]!;

    if (authoritative) {
      stats.removed++;
      continue;
    }

    // The file was already stripped, so this comment was never expected to be
    // in it. Keep it, and follow the code if it moved underneath.
    const rematched = reanchor(e, input.strippedLines, config, now);
    if (rematched.ok) {
      stats.retained++;
      if (rematched.reanchored) stats.reanchored++;
      comments.push(rematched.comment);
    } else {
      stats.orphaned++;
      comments.push(rematched.comment);
    }
  }

  comments.sort(
    (a, b) =>
      a.line - b.line ||
      (a.stripCol ?? -1) - (b.stripCol ?? -1) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const file: StoredFile = {
    path: input.path,
    state: "extracted",
    codeSha: input.codeSha,
    sourceSha: input.sourceSha,
    eol: input.eol,
    finalNewline: input.finalNewline,
    encoding: input.encoding,
    comments,
  };

  return { file, stats };
}

interface ReanchorOutcome {
  ok: boolean;
  reanchored: boolean;
  comment: StoredComment;
}

/**
 * Re-locate a stored comment against code that changed while it was extracted.
 *
 * A comment that can no longer be placed is kept and flagged rather than
 * dropped or guessed at — losing a comment is unacceptable, and putting one
 * next to unrelated code is worse than admitting it is homeless.
 */
export function reanchor(
  record: StoredComment,
  lines: readonly string[],
  config: Config,
  now: string,
): ReanchorOutcome {
  const options = { fuzzyThreshold: config.fuzzyThreshold };
  const sameLine = record.stripCol !== undefined;

  const match = sameLine
    ? matchHost(lines, record.anchor, record.line - 1, options, record.placement === "trailing")
    : matchOwnLine(lines, record.anchor, record.line - 1, options);

  if (!match) {
    return {
      ok: false,
      reanchored: false,
      comment: {
        ...record,
        orphaned: true,
        orphanedReason: record.orphanedReason ?? "anchor_lost",
        orphanedAt: record.orphanedAt ?? now,
      },
    };
  }

  const anchor = match.reanchor
    ? sameLine
      ? buildAnchor(
          lines,
          match.at,
          match.at + 1,
          config.anchorWindow,
          normalizeCodeLine(lines[match.at] ?? ""),
        )
      : buildAnchor(lines, match.at, match.at, config.anchorWindow)
    : record.anchor;

  const comment: StoredComment = {
    ...record,
    anchor,
    line: match.at + 1,
  };
  delete comment.orphaned;
  delete comment.orphanedReason;
  delete comment.orphanedAt;
  if (match.reanchor) comment.reanchoredAt = now;

  return { ok: true, reanchored: match.reanchor, comment };
}
