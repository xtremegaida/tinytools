import { execFileSync } from "node:child_process";

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

export type ChangeKind = "modified" | "added" | "deleted" | "renamed" | "untracked";

export interface ChangeEntry {
  path: string;
  kind: ChangeKind;
  /** Previous path, for renames and copies. */
  from?: string;
}

function run(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GitError(`git ${args.join(" ")} failed: ${(e.stderr || e.message).trim()}`);
  }
}

export function isGitRepo(cwd: string): boolean {
  try {
    return run(["rev-parse", "--is-inside-work-tree"], cwd).trim() === "true";
  } catch {
    return false;
  }
}

export function repoRoot(cwd: string): string {
  return run(["rev-parse", "--show-toplevel"], cwd).trim();
}

/** HEAD's commit, or undefined in a repo with no commits yet. */
export function headCommit(cwd: string): string | undefined {
  try {
    const out = run(["rev-parse", "HEAD"], cwd).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Every tracked and untracked-but-not-ignored file, repo-relative. */
export function listFiles(cwd: string): string[] {
  const tracked = run(["ls-files", "-z"], cwd);
  const untracked = run(["ls-files", "-z", "--others", "--exclude-standard"], cwd);
  const all = [...splitZ(tracked), ...splitZ(untracked)];
  return [...new Set(all)];
}

function splitZ(raw: string): string[] {
  return raw.split("\0").filter((s) => s.length > 0);
}

function statusKind(x: string, y: string): ChangeKind {
  if (x === "?" || y === "?") return "untracked";
  if (x === "D" || y === "D") return "deleted";
  if (x === "A") return "added";
  return "modified";
}

/**
 * Parse `git status --porcelain=v1 -z -uall`.
 *
 * With `-z`, a rename or copy is two NUL-terminated fields: the new path in the
 * status record, then the old path immediately after.
 */
export function parseStatus(raw: string): ChangeEntry[] {
  const parts = raw.split("\0");
  const out: ChangeEntry[] = [];

  let i = 0;
  while (i < parts.length) {
    const entry = parts[i];
    i++;
    if (!entry || entry.length < 4) continue;

    const x = entry[0]!;
    const y = entry[1]!;
    const filePath = entry.slice(3);

    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const from = parts[i] ?? "";
      i++;
      out.push({ path: filePath, kind: "renamed", from });
      continue;
    }
    out.push({ path: filePath, kind: statusKind(x, y) });
  }
  return out;
}

export function workingTreeChanges(cwd: string): ChangeEntry[] {
  return parseStatus(run(["status", "--porcelain=v1", "-z", "-uall"], cwd));
}

/**
 * Parse `git diff --name-status -M -z`.
 *
 * Rename records arrive as three fields — `R<score>`, old path, new path —
 * whereas ordinary records are two.
 */
export function parseDiffNameStatus(raw: string): ChangeEntry[] {
  const parts = splitZ(raw);
  const out: ChangeEntry[] = [];

  let i = 0;
  while (i < parts.length) {
    const code = parts[i]!;
    i++;
    if (code.startsWith("R") || code.startsWith("C")) {
      const from = parts[i] ?? "";
      const to = parts[i + 1] ?? "";
      i += 2;
      out.push({ path: to, kind: "renamed", from });
      continue;
    }
    const filePath = parts[i] ?? "";
    i++;
    if (!filePath) continue;
    const letter = code[0]!;
    out.push({
      path: filePath,
      kind: letter === "A" ? "added" : letter === "D" ? "deleted" : "modified",
    });
  }
  return out;
}

/** Changes between a commit and HEAD, to catch pulls and branch switches. */
export function changesSince(cwd: string, fromCommit: string): ChangeEntry[] {
  try {
    return parseDiffNameStatus(
      run(["diff", "--name-status", "-M", "-z", `${fromCommit}..HEAD`], cwd),
    );
  } catch {
    // The recorded commit is not reachable — a rebase, a shallow clone, or a
    // dropped branch. The caller falls back to a full scan.
    return [];
  }
}

export function commitExists(cwd: string, commit: string): boolean {
  try {
    run(["cat-file", "-e", `${commit}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}
