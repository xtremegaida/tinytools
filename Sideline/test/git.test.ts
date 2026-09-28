import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extract, openRepo, restoreRepo } from "../src/engine.js";
import { parseDiffNameStatus, parseStatus } from "../src/git.js";
import { load as loadStore } from "../src/store.js";
import { cleanup, exists, git, makeRepo, read, writeFiles } from "./helpers/repo.js";

const FILES = {
  "src/alpha.ts": [
    "export function alpha() {",
    "  // alpha explains itself",
    "  return 1;",
    "}",
    "",
  ].join("\n"),
  "src/beta.ts": [
    "export function beta() {",
    "  // beta explains itself",
    "  return 2;",
    "}",
    "",
  ].join("\n"),
};

const dirs: string[] = [];

function repo(): string {
  const dir = makeRepo(FILES);
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

function store(dir: string) {
  return loadStore(path.join(dir, "sideline.yaml"));
}

function commentIds(dir: string, filePath: string): string[] {
  return (store(dir).files.find((f) => f.path === filePath)?.comments ?? []).map((c) => c.id);
}

describe("incremental processing", () => {
  it("only reprocesses what changed since the last run", () => {
    const dir = repo();

    extract(openRepo(dir));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "extracted"]);
    extract(openRepo(dir));

    writeFiles(dir, {
      "src/alpha.ts": read(dir, "src/alpha.ts").replace(
        "  return 1;",
        "  // a fresh thought\n  return 1;",
      ),
    });

    const report = extract(openRepo(dir));
    expect(report.scanned).toBe(1);
    expect(report.added).toBe(1);
    expect(report.fullScan).toBe(false);
  });

  it("falls back to a full scan when the recorded commit is unreachable", () => {
    const dir = repo();
    extract(openRepo(dir));

    const ctx = openRepo(dir);
    ctx.store.lastCommit = "0".repeat(40);
    const report = extract(ctx, {});
    expect(report.fullScan).toBe(true);
  });
});

describe("renames", () => {
  it("carries comment ids across a git mv", () => {
    const dir = repo();
    extract(openRepo(dir));
    const before = commentIds(dir, "src/alpha.ts");
    expect(before).toHaveLength(1);

    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "extracted"]);
    git(dir, ["mv", "src/alpha.ts", "src/renamed.ts"]);

    const report = extract(openRepo(dir));
    expect(report.renamed).toContainEqual({ from: "src/alpha.ts", to: "src/renamed.ts" });

    expect(commentIds(dir, "src/renamed.ts")).toEqual(before);
    expect(store(dir).files.find((f) => f.path === "src/alpha.ts")).toBeUndefined();

    restoreRepo(openRepo(dir));
    expect(read(dir, "src/renamed.ts")).toContain("// alpha explains itself");
  });

  it("recognises a move git did not record as a rename", () => {
    const dir = repo();
    extract(openRepo(dir));
    const before = commentIds(dir, "src/alpha.ts");

    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "extracted"]);

    // Delete and re-create elsewhere, with no rename record anywhere.
    const body = read(dir, "src/alpha.ts");
    fs.rmSync(path.join(dir, "src/alpha.ts"));
    writeFiles(dir, { "src/moved.ts": body });

    const report = extract(openRepo(dir), { all: true });
    expect(report.renamed).toContainEqual({ from: "src/alpha.ts", to: "src/moved.ts" });
    expect(commentIds(dir, "src/moved.ts")).toEqual(before);
  });
});

describe("deletions", () => {
  it("marks a deleted file orphaned and keeps its comments", () => {
    const dir = repo();
    extract(openRepo(dir));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "extracted"]);

    git(dir, ["rm", "-q", "src/alpha.ts"]);

    const report = extract(openRepo(dir));
    expect(report.orphanedFiles).toContain("src/alpha.ts");

    const record = store(dir).files.find((f) => f.path === "src/alpha.ts");
    expect(record?.state).toBe("orphaned");
    expect(record?.lastKnownPath).toBe("src/alpha.ts");
    expect(record?.comments[0]?.orphaned).toBe(true);
    expect(record?.comments[0]?.orphanedReason).toBe("file_deleted");
    expect(read(dir, "sideline.yaml")).toContain("alpha explains itself");
  });

  it("does not try to restore into a file that no longer exists", () => {
    const dir = repo();
    extract(openRepo(dir));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "extracted"]);
    git(dir, ["rm", "-q", "src/alpha.ts"]);
    extract(openRepo(dir));

    const report = restoreRepo(openRepo(dir));
    expect(report.missing).not.toContain("src/alpha.ts");
    expect(exists(dir, "src/alpha.ts")).toBe(false);
    expect(read(dir, "src/beta.ts")).toContain("// beta explains itself");
  });
});

describe("porcelain parsing", () => {
  it("parses ordinary status entries", () => {
    const raw = " M src/a.ts\0A  src/b.ts\0?? src/c.ts\0 D src/d.ts\0";
    expect(parseStatus(raw)).toEqual([
      { path: "src/a.ts", kind: "modified" },
      { path: "src/b.ts", kind: "added" },
      { path: "src/c.ts", kind: "untracked" },
      { path: "src/d.ts", kind: "deleted" },
    ]);
  });

  it("parses a rename, taking the extra path field", () => {
    const raw = "R  src/new.ts\0src/old.ts\0 M src/other.ts\0";
    expect(parseStatus(raw)).toEqual([
      { path: "src/new.ts", kind: "renamed", from: "src/old.ts" },
      { path: "src/other.ts", kind: "modified" },
    ]);
  });

  it("parses diff name-status output including renames", () => {
    const raw = "M\0src/a.ts\0R100\0src/old.ts\0src/new.ts\0D\0src/gone.ts\0";
    expect(parseDiffNameStatus(raw)).toEqual([
      { path: "src/a.ts", kind: "modified" },
      { path: "src/new.ts", kind: "renamed", from: "src/old.ts" },
      { path: "src/gone.ts", kind: "deleted" },
    ]);
  });
});
