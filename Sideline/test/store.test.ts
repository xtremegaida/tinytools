import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, globToRegExp, makeMatcher, mergeConfig, ConfigError } from "../src/config.js";
import { commentId, emptyStore, normalizeForId, parse, serialize, type Store } from "../src/store.js";

function sampleStore(): Store {
  return {
    ...emptyStore(),
    lastCommit: "a".repeat(40),
    files: [
      {
        path: "src/b.ts",
        state: "extracted",
        codeSha: "c".repeat(64),
        sourceSha: "d".repeat(64),
        eol: "crlf",
        finalNewline: false,
        encoding: "utf8bom",
        comments: [
          {
            id: "0123456789ab",
            kind: "block",
            cls: "doc",
            placement: "leading",
            line: 4,
            indent: "    ",
            text: "/**\n * Multi line.\n */",
            blankAbove: 1,
            blankBelow: 2,
            anchor: { before: ["a();"], after: ["b();", "c();"] },
            firstPath: "src/original.ts",
            ordinal: 0,
          },
          {
            id: "ba9876543210",
            kind: "line",
            cls: "ordinary",
            placement: "trailing",
            line: 9,
            indent: "",
            text: "// why",
            blankAbove: 0,
            blankBelow: 0,
            stripCol: 12,
            sepLen: 0,
            padBefore: " ",
            padAfter: "",
            anchor: { before: [], after: [], host: "const x = 1;" },
            firstPath: "src/b.ts",
            ordinal: 3,
            orphaned: true,
            orphanedReason: "anchor_lost",
            orphanedAt: "2026-09-18T00:00:00.000Z",
          },
        ],
      },
      {
        path: "src/a.ts",
        state: "orphaned",
        eol: "lf",
        finalNewline: true,
        encoding: "utf8",
        lastKnownPath: "src/a.ts",
        comments: [],
      },
    ],
  };
}

describe("store serialisation", () => {
  it("round-trips every field", () => {
    const store = sampleStore();
    const reparsed = parse(serialize(store));

    const original = [...store.files].sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(reparsed.files).toEqual(original);
    expect(reparsed.lastCommit).toBe(store.lastCommit);
  });

  it("emits byte-identical YAML for the same logical store", () => {
    expect(serialize(sampleStore())).toBe(serialize(sampleStore()));
  });

  it("sorts files by path regardless of input order", () => {
    const text = serialize(sampleStore());
    expect(text.indexOf("path: src/a.ts")).toBeLessThan(text.indexOf("path: src/b.ts"));
  });

  it("writes multi-line comments as readable block scalars", () => {
    expect(serialize(sampleStore())).toContain("text: |-\n");
  });

  it("reads an empty or absent document as an empty store", () => {
    expect(parse("").files).toEqual([]);
  });

  it("refuses a store written by a newer version", () => {
    expect(() => parse("version: 999\nfiles: []\n")).toThrow(/newer sideline/);
  });
});

describe("comment identity", () => {
  it("ignores per-line indentation and trailing whitespace", () => {
    expect(normalizeForId("  // a\n  // b")).toBe(normalizeForId("// a  \n// b"));
  });

  it("is deterministic", () => {
    const taken = new Set<string>();
    expect(commentId("src/a.ts", "// x", 0, taken)).toBe(
      commentId("src/a.ts", "// x", 0, taken),
    );
  });

  it("separates identical text by ordinal and by path", () => {
    const taken = new Set<string>();
    const a = commentId("src/a.ts", "// x", 0, taken);
    expect(commentId("src/a.ts", "// x", 1, taken)).not.toBe(a);
    expect(commentId("src/b.ts", "// x", 0, taken)).not.toBe(a);
  });

  it("lengthens the id rather than colliding", () => {
    const first = commentId("src/a.ts", "// x", 0, new Set());
    const second = commentId("src/a.ts", "// x", 0, new Set([first]));
    expect(second).not.toBe(first);
    expect(second.startsWith(first)).toBe(true);
  });
});

describe("glob matching", () => {
  it("matches ** across directories and at the root", () => {
    const re = globToRegExp("**/*.cs");
    expect(re.test("Foo.cs")).toBe(true);
    expect(re.test("a/b/Foo.cs")).toBe(true);
    expect(re.test("Foo.ts")).toBe(false);
  });

  it("matches a trailing /** as everything below", () => {
    const re = globToRegExp("**/node_modules/**");
    expect(re.test("node_modules/x.js")).toBe(true);
    expect(re.test("a/node_modules/b/x.js")).toBe(true);
    expect(re.test("src/x.js")).toBe(false);
  });

  it("keeps * from crossing a directory boundary", () => {
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("src/*.ts").test("src/b.ts")).toBe(true);
  });

  it("excludes the defaults a repo would not want scanned", () => {
    const exclude = makeMatcher(DEFAULT_CONFIG.exclude);
    expect(exclude("node_modules/pkg/index.js")).toBe(true);
    expect(exclude("src/types.d.ts")).toBe(true);
    expect(exclude("vendor/lib.min.js")).toBe(true);
    expect(exclude("src/app.ts")).toBe(false);
  });
});

describe("config", () => {
  it("defaults to preserving build-affecting comments only", () => {
    expect(DEFAULT_CONFIG.preserve).toMatchObject({
      pragma: true,
      region: true,
      doc: false,
      license: false,
    });
  });

  it("merges a partial config over the defaults", () => {
    const cfg = mergeConfig({ preserve: { doc: true }, anchorWindow: 5 });
    expect(cfg.preserve.doc).toBe(true);
    expect(cfg.preserve.pragma).toBe(true);
    expect(cfg.anchorWindow).toBe(5);
    expect(cfg.include).toEqual(DEFAULT_CONFIG.include);
  });

  it("rejects malformed values with a usable message", () => {
    expect(() => mergeConfig({ anchorWindow: "three" })).toThrow(ConfigError);
    expect(() => mergeConfig({ preserve: { doc: "yes" } })).toThrow(/preserve.doc/);
    expect(() => mergeConfig({ preserve: { custom: ["("] } })).toThrow(/invalid regex/);
  });
});
