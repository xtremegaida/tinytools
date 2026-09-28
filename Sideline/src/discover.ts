import fs from "node:fs";
import path from "node:path";
import { makeMatcher, type Config } from "./config.js";
import { isGitRepo, listFiles } from "./git.js";
import { languageOf } from "./lex/index.js";

export interface Discovery {
  /** Repo-relative, forward-slash paths. */
  files: string[];
  usedGit: boolean;
}

export function toRepoRelative(repoRoot: string, absolute: string): string {
  return path.relative(repoRoot, absolute).split(path.sep).join("/");
}

export function toAbsolute(repoRoot: string, relative: string): string {
  return path.join(repoRoot, relative);
}

/**
 * Find candidate source files.
 *
 * `git ls-files` is preferred because it inherits `.gitignore` for free and
 * never wanders into build output. The filesystem walk is only for repos
 * without git.
 */
export function discover(repoRoot: string, config: Config): Discovery {
  const include = makeMatcher(config.include);
  const exclude = makeMatcher(config.exclude);

  const keep = (p: string): boolean =>
    languageOf(p) !== undefined && include(p) && !exclude(p);

  if (isGitRepo(repoRoot)) {
    return { files: listFiles(repoRoot).filter(keep).sort(), usedGit: true };
  }
  return { files: walk(repoRoot, repoRoot).filter(keep).sort(), usedGit: false };
}

const ALWAYS_SKIP = new Set([".git", "node_modules", "bin", "obj", "dist", "build"]);

function walk(root: string, dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ALWAYS_SKIP.has(entry.name)) continue;
      out.push(...walk(root, path.join(dir, entry.name)));
      continue;
    }
    if (entry.isFile()) out.push(toRepoRelative(root, path.join(dir, entry.name)));
  }
  return out;
}

/** Filter an arbitrary path list down to processable source files. */
export function filterProcessable(paths: readonly string[], config: Config): string[] {
  const include = makeMatcher(config.include);
  const exclude = makeMatcher(config.exclude);
  return paths.filter((p) => languageOf(p) !== undefined && include(p) && !exclude(p));
}
