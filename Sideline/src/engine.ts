import fs from "node:fs";
import path from "node:path";
import { matchHost, matchOwnLine } from "./anchor.js";
import { loadConfig, type Config } from "./config.js";
import { discover, filterProcessable, toAbsolute } from "./discover.js";
import {
  decode,
  encode,
  eolString,
  splitLines,
  UnsupportedEncodingError,
  type Encoding,
  type EolStyle,
} from "./eol.js";
import {
  restoreText,
  SKIP_EXPLANATIONS,
  stripText,
  type EolMeta,
  type SkipReason,
} from "./extract.js";
import {
  changesSince,
  commitExists,
  headCommit,
  isGitRepo,
  repoRoot as gitRepoRoot,
  workingTreeChanges,
  type ChangeEntry,
} from "./git.js";
import { sha256 } from "./hash.js";
import { languageOf } from "./lex/index.js";
import { reanchor, reconcile } from "./reconcile.js";
import type { ResolvedComment } from "./restore.js";
import {
  allIds,
  emptyStore,
  indexByPath,
  load as loadStore,
  save as saveStore,
  type Store,
  type StoredComment,
  type StoredFile,
} from "./store.js";

export interface EngineContext {
  repoRoot: string;
  config: Config;
  storePath: string;
  store: Store;
  isGit: boolean;
}

export interface RunOptions {
  all?: boolean;
  dryRun?: boolean;
  verify?: boolean;
  paths?: string[];
}

export function openRepo(cwd: string, configPath?: string): EngineContext {
  const isGit = isGitRepo(cwd);
  const root = isGit ? gitRepoRoot(cwd) : path.resolve(cwd);
  const config = loadConfig(root, configPath);
  const storePath = path.resolve(root, config.store);
  return { repoRoot: root, config, storePath, store: loadStore(storePath), isGit };
}

// ---------------------------------------------------------------------------
// File IO
// ---------------------------------------------------------------------------

interface LoadedFile {
  text: string;
  lines: string[];
  eol: EolStyle;
  finalNewline: boolean;
  encoding: Encoding;
  sha: string;
}

function readSource(absolute: string): LoadedFile | { error: SkipReason } {
  let decoded;
  try {
    decoded = decode(fs.readFileSync(absolute));
  } catch (err) {
    if (err instanceof UnsupportedEncodingError) return { error: "unsupported-encoding" };
    throw err;
  }

  const text = decoded.lines
    .map((l, i) => l + (decoded.lineEols[i] ?? ""))
    .join("");
  const last = decoded.lineEols[decoded.lineEols.length - 1];

  return {
    text,
    lines: decoded.lines,
    eol: decoded.eol,
    finalNewline: decoded.lines.length === 0 ? true : last !== "",
    encoding: decoded.encoding,
    sha: sha256(text),
  };
}

function writeSource(absolute: string, text: string, encoding: Encoding): void {
  const { lines, lineEols } = splitLines(text);
  fs.writeFileSync(absolute, encode({ lines, lineEols, eol: "lf", encoding }));
}

function metaOf(file: { eol: EolStyle; finalNewline: boolean }): EolMeta {
  return { eol: file.eol, trailing: file.finalNewline ? eolString(file.eol) : "" };
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

export interface SkippedFile {
  path: string;
  reason: SkipReason;
}

export interface ExtractReport {
  scanned: number;
  rewritten: string[];
  unchanged: number;
  skipped: SkippedFile[];
  renamed: { from: string; to: string }[];
  orphanedFiles: string[];
  added: number;
  updated: number;
  removed: number;
  retained: number;
  orphaned: number;
  reanchored: number;
  fullScan: boolean;
}

export function extract(ctx: EngineContext, options: RunOptions = {}): ExtractReport {
  const report: ExtractReport = {
    scanned: 0,
    rewritten: [],
    unchanged: 0,
    skipped: [],
    renamed: [],
    orphanedFiles: [],
    added: 0,
    updated: 0,
    removed: 0,
    retained: 0,
    orphaned: 0,
    reanchored: 0,
    fullScan: false,
  };

  const plan = planTargets(ctx, options);
  report.fullScan = plan.fullScan;

  const index = indexByPath(ctx.store);
  const taken = allIds(ctx.store);
  const now = new Date().toISOString();

  // Renames first, so the file is reconciled under its new path with its ids
  // and history intact rather than appearing as a deletion plus an addition.
  for (const rename of plan.renames) {
    const record = index.get(rename.from);
    if (!record) continue;
    index.delete(rename.from);
    record.path = rename.path;
    index.set(rename.path, record);
    report.renamed.push({ from: rename.from, to: rename.path });
  }

  // Files the store knows about that are no longer on disk. This runs before
  // the main loop so a vanished file's record can claim its new home while that
  // home is still unowned — afterwards the moved file would already have been
  // processed as a brand new one, with brand new ids.
  resolveMissingFiles(ctx, index, report, now, plan.paths);

  for (const rel of [...plan.paths].sort()) {
    const absolute = toAbsolute(ctx.repoRoot, rel);
    const language = languageOf(rel);
    if (!language) continue;

    if (!fs.existsSync(absolute)) continue; // handled by the missing-file pass

    report.scanned++;
    const loaded = readSource(absolute);
    if ("error" in loaded) {
      report.skipped.push({ path: rel, reason: loaded.error });
      continue;
    }

    const existing = index.get(rel);

    // Already extracted and untouched since. Nothing to do, and re-running must
    // not disturb the store.
    if (existing?.state === "extracted" && existing.codeSha === loaded.sha) {
      report.unchanged++;
      continue;
    }

    const outcome = stripText(loaded.text, language, ctx.config, {
      verify: options.verify ?? true,
      isJsFile: path.extname(rel).toLowerCase() === ".js",
    });
    if (!outcome.ok) {
      report.skipped.push({ path: rel, reason: outcome.reason });
      continue;
    }

    const result = reconcile({
      path: rel,
      existing,
      found: outcome.comments,
      strippedLines: splitLines(outcome.text).lines,
      codeSha: sha256(outcome.text),
      sourceSha: loaded.sha,
      eol: loaded.eol,
      finalNewline: loaded.finalNewline,
      encoding: loaded.encoding,
      config: ctx.config,
      takenIds: taken,
      now,
    });

    report.added += result.stats.added;
    report.updated += result.stats.updated;
    report.removed += result.stats.removed;
    report.retained += result.stats.retained;
    report.orphaned += result.stats.orphaned;
    report.reanchored += result.stats.reanchored;

    index.set(rel, result.file);

    if (outcome.text !== loaded.text) {
      report.rewritten.push(rel);
      if (!options.dryRun) writeSource(absolute, outcome.text, loaded.encoding);
    } else {
      report.unchanged++;
    }
  }

  ctx.store.files = [...index.values()];
  if (ctx.isGit) ctx.store.lastCommit = headCommit(ctx.repoRoot) ?? ctx.store.lastCommit;
  if (!options.dryRun) saveStore(ctx.storePath, ctx.store);

  return report;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface RestoreReport {
  scanned: number;
  rewritten: string[];
  unchanged: number;
  placed: number;
  orphaned: number;
  reanchored: number;
  missing: string[];
  skipped: SkippedFile[];
}

export function restoreRepo(ctx: EngineContext, options: RunOptions = {}): RestoreReport {
  const report: RestoreReport = {
    scanned: 0,
    rewritten: [],
    unchanged: 0,
    placed: 0,
    orphaned: 0,
    reanchored: 0,
    missing: [],
    skipped: [],
  };

  const now = new Date().toISOString();
  const filter = options.paths?.length ? new Set(filterProcessable(options.paths, ctx.config)) : undefined;

  for (const record of ctx.store.files) {
    if (record.state === "orphaned") continue;
    if (filter && !filter.has(record.path)) continue;

    const absolute = toAbsolute(ctx.repoRoot, record.path);
    if (!fs.existsSync(absolute)) {
      report.missing.push(record.path);
      continue;
    }

    report.scanned++;
    const loaded = readSource(absolute);
    if ("error" in loaded) {
      report.skipped.push({ path: record.path, reason: loaded.error });
      continue;
    }

    // Already restored and untouched since.
    if (record.state === "restored" && record.sourceSha === loaded.sha) {
      report.unchanged++;
      continue;
    }

    const resolved: ResolvedComment[] = [];
    for (const c of record.comments) {
      const outcome = reanchor(c, loaded.lines, ctx.config, now);
      Object.assign(c, outcome.comment);
      if (!outcome.ok) {
        report.orphaned++;
        continue;
      }
      if (outcome.reanchored) report.reanchored++;
      report.placed++;
      resolved.push(toResolvedComment(c, outcome.comment.line - 1));
    }

    const meta = metaOf({ eol: record.eol, finalNewline: record.finalNewline });
    const text = restoreText(loaded.text, resolved, meta);

    record.state = "restored";
    record.sourceSha = sha256(text);
    record.codeSha = loaded.sha;

    if (text !== loaded.text) {
      report.rewritten.push(record.path);
      if (!options.dryRun) writeSource(absolute, text, record.encoding);
    } else {
      report.unchanged++;
    }
  }

  if (!options.dryRun) saveStore(ctx.storePath, ctx.store);
  return report;
}

function toResolvedComment(c: StoredComment, at: number): ResolvedComment {
  return {
    placement: c.placement,
    at,
    line: c.line,
    indent: c.indent,
    text: c.text,
    blankAbove: c.blankAbove,
    blankBelow: c.blankBelow,
    stripCol: c.stripCol,
    sepLen: c.sepLen,
    padBefore: c.padBefore,
    padAfter: c.padAfter,
  };
}

// ---------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------

interface TargetPlan {
  paths: Set<string>;
  renames: { from: string; path: string }[];
  fullScan: boolean;
}

/**
 * Decide which files this run touches.
 *
 * Incremental mode combines the working tree's own status with any commits that
 * landed since the store was last written, which is what catches a pull or a
 * branch switch rather than only local edits.
 */
function planTargets(ctx: EngineContext, options: RunOptions): TargetPlan {
  if (options.paths && options.paths.length > 0) {
    return {
      paths: new Set(filterProcessable(options.paths, ctx.config)),
      renames: [],
      fullScan: false,
    };
  }

  const everything = (): TargetPlan => ({
    paths: new Set(discover(ctx.repoRoot, ctx.config).files),
    renames: [],
    fullScan: true,
  });

  if (options.all || !ctx.isGit) return everything();

  const last = ctx.store.lastCommit;
  // No recorded commit, or one git no longer knows about (rebase, shallow
  // clone, dropped branch): there is no reliable delta, so scan everything.
  if (!last || !commitExists(ctx.repoRoot, last)) return everything();

  const changes: ChangeEntry[] = [
    ...workingTreeChanges(ctx.repoRoot),
    ...changesSince(ctx.repoRoot, last),
  ];

  const paths = new Set<string>();
  const renames: { from: string; path: string }[] = [];

  // A restored file is back to its committed content, so git reports it as
  // unchanged even though it is full of comments waiting to be extracted. The
  // store knows better, so trust it.
  for (const file of ctx.store.files) {
    if (file.state === "restored") paths.add(file.path);
  }

  for (const change of changes) {
    if (change.kind === "renamed" && change.from) {
      renames.push({ from: change.from, path: change.path });
    }
    for (const p of [change.path, change.from]) {
      if (!p) continue;
      for (const kept of filterProcessable([p], ctx.config)) paths.add(kept);
    }
  }

  return { paths, renames, fullScan: false };
}

/**
 * Decide what became of every store record whose file is gone: moved, renamed,
 * or orphaned.
 *
 * A moved file is added to the run's targets so it is reconciled under its new
 * path in the main loop, keeping its comment ids.
 */
function resolveMissingFiles(
  ctx: EngineContext,
  index: Map<string, StoredFile>,
  report: ExtractReport,
  now: string,
  targets: Set<string>,
): void {
  const missing: [string, StoredFile][] = [];
  for (const [rel, record] of index) {
    if (record.state === "orphaned") continue;
    if (fs.existsSync(toAbsolute(ctx.repoRoot, rel))) continue;
    missing.push([rel, record]);
  }
  if (missing.length === 0) return;

  // Only worth a full scan once we know something actually went missing.
  const unowned = discover(ctx.repoRoot, ctx.config).files.filter((p) => !index.has(p));

  for (const [rel, record] of missing) {
    const moved = findMoveTarget(ctx, record, unowned);
    if (moved) {
      index.delete(rel);
      record.path = moved;
      index.set(moved, record);
      targets.add(moved);
      report.renamed.push({ from: rel, to: moved });
      continue;
    }

    record.state = "orphaned";
    record.lastKnownPath = rel;
    record.orphanedAt = record.orphanedAt ?? now;
    for (const c of record.comments) {
      if (c.orphaned) continue;
      c.orphaned = true;
      c.orphanedReason = "file_deleted";
      c.orphanedAt = c.orphanedAt ?? now;
      report.orphaned++;
    }
    report.orphanedFiles.push(rel);
  }
}

/**
 * Look for a file that a vanished one's comments still fit.
 *
 * Git's own rename detection is used first by the caller; this is the fallback
 * for a move git did not record, such as a delete and re-add across commits.
 */
function findMoveTarget(
  ctx: EngineContext,
  record: StoredFile,
  unowned: readonly string[],
): string | undefined {
  if (record.comments.length === 0) return undefined;

  const candidates = unowned.filter((p) => languageOf(p) === languageOf(record.path));

  let best: string | undefined;
  let bestRatio = 0.6; // below this it is a different file, not a move

  for (const candidate of candidates) {
    const loaded = readSource(toAbsolute(ctx.repoRoot, candidate));
    if ("error" in loaded) continue;

    let hits = 0;
    for (const c of record.comments) {
      const options = { fuzzyThreshold: ctx.config.fuzzyThreshold };
      const found =
        c.stripCol !== undefined
          ? matchHost(loaded.lines, c.anchor, c.line - 1, options, true)
          : matchOwnLine(loaded.lines, c.anchor, c.line - 1, options);
      if (found) hits++;
    }

    const ratio = hits / record.comments.length;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = candidate;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Status and check
// ---------------------------------------------------------------------------

export type FileHealth = "extracted" | "restored" | "drifted" | "orphaned" | "missing";

export interface FileStatus {
  path: string;
  health: FileHealth;
  comments: number;
  orphans: number;
}

export function status(ctx: EngineContext): FileStatus[] {
  const out: FileStatus[] = [];

  for (const record of ctx.store.files) {
    const orphans = record.comments.filter((c) => c.orphaned).length;
    const base = { path: record.path, comments: record.comments.length, orphans };

    if (record.state === "orphaned") {
      out.push({ ...base, health: "orphaned" });
      continue;
    }

    const absolute = toAbsolute(ctx.repoRoot, record.path);
    if (!fs.existsSync(absolute)) {
      out.push({ ...base, health: "missing" });
      continue;
    }

    const loaded = readSource(absolute);
    if ("error" in loaded) {
      out.push({ ...base, health: "drifted" });
      continue;
    }

    const matches =
      record.state === "extracted"
        ? record.codeSha === loaded.sha
        : record.sourceSha === loaded.sha;

    out.push({ ...base, health: matches ? record.state : "drifted" });
  }

  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface CheckResult {
  inSync: boolean;
  drifted: string[];
  missing: string[];
  unextracted: string[];
  restored: string[];
}

/**
 * CI gate: is the working tree in the state the store describes?
 *
 * A restored file counts as out of sync. Its comments are back in the code,
 * which is fine locally but is not what should reach a commit when the stripped
 * form is the canonical one.
 */
export function check(ctx: EngineContext): CheckResult {
  const drifted: string[] = [];
  const missing: string[] = [];
  const restored: string[] = [];

  for (const s of status(ctx)) {
    if (s.health === "drifted") drifted.push(s.path);
    if (s.health === "missing") missing.push(s.path);
    if (s.health === "restored") restored.push(s.path);
  }

  const known = new Set(ctx.store.files.map((f) => f.path));
  const unextracted: string[] = [];

  for (const rel of discover(ctx.repoRoot, ctx.config).files) {
    if (known.has(rel)) continue;
    const language = languageOf(rel);
    if (!language) continue;
    const loaded = readSource(toAbsolute(ctx.repoRoot, rel));
    if ("error" in loaded) continue;
    const outcome = stripText(loaded.text, language, ctx.config, {
      verify: false,
      isJsFile: path.extname(rel).toLowerCase() === ".js",
    });
    if (outcome.ok && outcome.comments.length > 0) unextracted.push(rel);
  }

  return {
    inSync:
      drifted.length === 0 &&
      missing.length === 0 &&
      unextracted.length === 0 &&
      restored.length === 0,
    drifted,
    missing,
    unextracted,
    restored,
  };
}

export interface OrphanEntry {
  id: string;
  path: string;
  reason: string;
  text: string;
}

export function orphans(ctx: EngineContext): OrphanEntry[] {
  const out: OrphanEntry[] = [];
  for (const file of ctx.store.files) {
    for (const c of file.comments) {
      if (!c.orphaned) continue;
      out.push({
        id: c.id,
        path: file.lastKnownPath ?? file.path,
        reason: c.orphanedReason ?? "anchor_lost",
        text: c.text,
      });
    }
  }
  return out;
}

export function pruneOrphans(ctx: EngineContext, dryRun = false): number {
  let removed = 0;
  for (const file of ctx.store.files) {
    const before = file.comments.length;
    file.comments = file.comments.filter((c) => !c.orphaned);
    removed += before - file.comments.length;
  }
  ctx.store.files = ctx.store.files.filter(
    (f) => f.comments.length > 0 || f.state !== "orphaned",
  );
  if (!dryRun) saveStore(ctx.storePath, ctx.store);
  return removed;
}

export { SKIP_EXPLANATIONS, emptyStore, type Store };
