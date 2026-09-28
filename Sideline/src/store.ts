import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Anchor, CommentClass, CommentKind, Placement } from "./comment.js";
import type { Encoding, EolStyle } from "./eol.js";
import { sha256 } from "./hash.js";

export const STORE_VERSION = 1;
export const TOOL_VERSION = "0.1.0";

export type OrphanReason = "anchor_lost" | "file_deleted" | "ambiguous_site";

export type FileState = "extracted" | "restored" | "orphaned";

export interface StoredComment {
  id: string;
  kind: CommentKind;
  cls: CommentClass;
  placement: Placement;
  line: number;
  indent: string;
  text: string;
  blankAbove: number;
  blankBelow: number;
  stripCol?: number;
  sepLen?: number;
  padBefore?: string;
  padAfter?: string;
  anchor: Anchor;
  /** Path at creation time. Frozen, so ids survive the file being moved. */
  firstPath: string;
  /** Distinguishes comments with identical text in the same file. */
  ordinal: number;
  orphaned?: boolean;
  orphanedReason?: OrphanReason;
  orphanedAt?: string;
  reanchoredAt?: string;
}

export interface StoredFile {
  path: string;
  state: FileState;
  /** sha256 of the file as it looks with comments removed. */
  codeSha?: string;
  /** sha256 of the file as it looks with comments present. */
  sourceSha?: string;
  eol: EolStyle;
  finalNewline: boolean;
  encoding: Encoding;
  comments: StoredComment[];
  lastKnownPath?: string;
  orphanedAt?: string;
}

export interface Store {
  version: number;
  generatedBy: string;
  lastCommit?: string;
  files: StoredFile[];
}

export function emptyStore(): Store {
  return { version: STORE_VERSION, generatedBy: `sideline ${TOOL_VERSION}`, files: [] };
}

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

/**
 * Comment text reduced to what identity should depend on.
 *
 * Per-line trimming means re-indenting a block, or trailing whitespace being
 * cleaned up inside it, does not mint a new id for the same comment.
 */
export function normalizeForId(text: string): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .join("\n");
}

/**
 * Derive a stable id.
 *
 * Anchors are deliberately excluded: re-anchoring a comment must not change its
 * identity. `firstPath` is frozen at creation so a moved file keeps its ids.
 * Deterministic, so extracting a clean repo twice produces the same store.
 */
export function commentId(
  firstPath: string,
  text: string,
  ordinal: number,
  taken: ReadonlySet<string>,
): string {
  const digest = sha256(`${firstPath}\0${normalizeForId(text)}\0${ordinal}`);
  for (const length of [12, 16, 20, 32, 64]) {
    const candidate = digest.slice(0, length);
    if (!taken.has(candidate)) return candidate;
  }
  return digest;
}

// ---------------------------------------------------------------------------
// Serialisation
//
// Keys are written in a fixed order and files sorted by path so that the same
// logical store always produces byte-identical YAML. That is what makes the
// extract -> restore -> extract idempotency check meaningful, and it keeps
// diffs and merge conflicts confined to the file that actually changed.
// ---------------------------------------------------------------------------

function anchorToYaml(anchor: Anchor): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (anchor.host !== undefined) out.host = anchor.host;
  out.before = anchor.before;
  out.after = anchor.after;
  return out;
}

function commentToYaml(c: StoredComment): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: c.id,
    kind: c.kind,
    class: c.cls,
    placement: c.placement,
    line: c.line,
  };
  if (c.indent !== "") out.indent = c.indent;
  if (c.blankAbove !== 0) out.blank_above = c.blankAbove;
  if (c.blankBelow !== 0) out.blank_below = c.blankBelow;
  if (c.stripCol !== undefined) out.strip_col = c.stripCol;
  if (c.sepLen !== undefined) out.sep_len = c.sepLen;
  if (c.padBefore !== undefined && c.padBefore !== "") out.pad_before = c.padBefore;
  if (c.padAfter !== undefined && c.padAfter !== "") out.pad_after = c.padAfter;
  if (c.orphaned) {
    out.orphaned = true;
    if (c.orphanedReason) out.orphaned_reason = c.orphanedReason;
    if (c.orphanedAt) out.orphaned_at = c.orphanedAt;
  }
  if (c.reanchoredAt) out.reanchored_at = c.reanchoredAt;
  out.first_path = c.firstPath;
  out.ordinal = c.ordinal;
  out.text = c.text;
  out.anchor = anchorToYaml(c.anchor);
  return out;
}

function fileToYaml(f: StoredFile): Record<string, unknown> {
  const out: Record<string, unknown> = {
    path: f.path,
    state: f.state,
  };
  if (f.codeSha) out.code_sha = f.codeSha;
  if (f.sourceSha) out.source_sha = f.sourceSha;
  out.eol = f.eol;
  out.final_newline = f.finalNewline;
  if (f.encoding !== "utf8") out.encoding = f.encoding;
  if (f.lastKnownPath) out.last_known_path = f.lastKnownPath;
  if (f.orphanedAt) out.orphaned_at = f.orphanedAt;
  out.comments = f.comments.map(commentToYaml);
  return out;
}

export function serialize(store: Store): string {
  const files = [...store.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const doc: Record<string, unknown> = {
    version: store.version,
    generated_by: store.generatedBy,
  };
  if (store.lastCommit) doc.last_commit = store.lastCommit;
  doc.files = files.map(fileToYaml);

  const body = stringifyYaml(doc, {
    lineWidth: 0,
    blockQuote: "literal",
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
    nullStr: "",
  });

  return `# Managed by sideline. Comments extracted from the code live here.\n${body}`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoreError(`${what} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, what: string, fallback?: string): string {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new StoreError(`${what} is required`);
  }
  if (typeof value !== "string") throw new StoreError(`${what} must be a string`);
  return value;
}

function asNumber(value: unknown, what: string, fallback?: number): number {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new StoreError(`${what} is required`);
  }
  if (typeof value !== "number") throw new StoreError(`${what} must be a number`);
  return value;
}

function asStringArray(value: unknown, what: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new StoreError(`${what} must be an array of strings`);
  }
  return value as string[];
}

function anchorFromYaml(raw: unknown, what: string): Anchor {
  const r = asRecord(raw, what);
  const anchor: Anchor = {
    before: asStringArray(r.before, `${what}.before`),
    after: asStringArray(r.after, `${what}.after`),
  };
  if (typeof r.host === "string") anchor.host = r.host;
  return anchor;
}

function commentFromYaml(raw: unknown, what: string): StoredComment {
  const r = asRecord(raw, what);
  const c: StoredComment = {
    id: asString(r.id, `${what}.id`),
    kind: asString(r.kind, `${what}.kind`) as CommentKind,
    cls: asString(r.class, `${what}.class`, "ordinary") as CommentClass,
    placement: asString(r.placement, `${what}.placement`) as Placement,
    line: asNumber(r.line, `${what}.line`, 1),
    indent: asString(r.indent, `${what}.indent`, ""),
    text: asString(r.text, `${what}.text`),
    blankAbove: asNumber(r.blank_above, `${what}.blank_above`, 0),
    blankBelow: asNumber(r.blank_below, `${what}.blank_below`, 0),
    anchor: anchorFromYaml(r.anchor, `${what}.anchor`),
    firstPath: asString(r.first_path, `${what}.first_path`, ""),
    ordinal: asNumber(r.ordinal, `${what}.ordinal`, 0),
  };
  // The padding fields only mean anything for a comment that shared its line
  // with code, which is exactly when strip_col is present.
  if (r.strip_col !== undefined) {
    c.stripCol = asNumber(r.strip_col, `${what}.strip_col`);
    c.sepLen = asNumber(r.sep_len, `${what}.sep_len`, 0);
    c.padBefore = asString(r.pad_before, `${what}.pad_before`, "");
    c.padAfter = asString(r.pad_after, `${what}.pad_after`, "");
  }
  if (r.orphaned === true) {
    c.orphaned = true;
    if (typeof r.orphaned_reason === "string") {
      c.orphanedReason = r.orphaned_reason as OrphanReason;
    }
    if (typeof r.orphaned_at === "string") c.orphanedAt = r.orphaned_at;
  }
  if (typeof r.reanchored_at === "string") c.reanchoredAt = r.reanchored_at;
  return c;
}

function fileFromYaml(raw: unknown, what: string): StoredFile {
  const r = asRecord(raw, what);
  const p = asString(r.path, `${what}.path`);
  const comments = Array.isArray(r.comments) ? r.comments : [];
  const f: StoredFile = {
    path: p,
    state: asString(r.state, `${what}.state`, "extracted") as FileState,
    eol: asString(r.eol, `${what}.eol`, "lf") as EolStyle,
    finalNewline: r.final_newline === undefined ? true : r.final_newline === true,
    encoding: asString(r.encoding, `${what}.encoding`, "utf8") as Encoding,
    comments: comments.map((c, i) => commentFromYaml(c, `${what}.comments[${i}]`)),
  };
  if (typeof r.code_sha === "string") f.codeSha = r.code_sha;
  if (typeof r.source_sha === "string") f.sourceSha = r.source_sha;
  if (typeof r.last_known_path === "string") f.lastKnownPath = r.last_known_path;
  if (typeof r.orphaned_at === "string") f.orphanedAt = r.orphaned_at;
  return f;
}

export function parse(text: string): Store {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new StoreError(`could not parse the store: ${(err as Error).message}`);
  }
  if (raw === null || raw === undefined) return emptyStore();

  const r = asRecord(raw, "store");
  const version = asNumber(r.version, "version", STORE_VERSION);
  if (version > STORE_VERSION) {
    throw new StoreError(
      `store version ${version} was written by a newer sideline; upgrade before continuing`,
    );
  }

  const files = Array.isArray(r.files) ? r.files : [];
  const store: Store = {
    version,
    generatedBy: asString(r.generated_by, "generated_by", `sideline ${TOOL_VERSION}`),
    files: files.map((f, i) => fileFromYaml(f, `files[${i}]`)),
  };
  if (typeof r.last_commit === "string") store.lastCommit = r.last_commit;
  return store;
}

export function load(storePath: string): Store {
  if (!fs.existsSync(storePath)) return emptyStore();
  return parse(fs.readFileSync(storePath, "utf8"));
}

export function save(storePath: string, store: Store): void {
  store.generatedBy = `sideline ${TOOL_VERSION}`;
  store.version = STORE_VERSION;
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, serialize(store), "utf8");
}

/** Index a store by path for lookup during a run. */
export function indexByPath(store: Store): Map<string, StoredFile> {
  return new Map(store.files.map((f) => [f.path, f]));
}

export function allIds(store: Store): Set<string> {
  const ids = new Set<string>();
  for (const f of store.files) for (const c of f.comments) ids.add(c.id);
  return ids;
}
