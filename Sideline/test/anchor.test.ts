import { describe, expect, it } from "vitest";
import { matchHost, matchOwnLine } from "../src/anchor.js";
import type { Anchor, ExtractedComment } from "../src/comment.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { splitLines } from "../src/eol.js";
import { stripText } from "../src/extract.js";

const OPTS = { fuzzyThreshold: DEFAULT_CONFIG.fuzzyThreshold };

/** Split exactly as the real pipeline does: no phantom line for a final newline. */
function linesOf(text: string): string[] {
  return splitLines(text).lines;
}

const BASE = [
  "function alpha() {",
  "  const a = 1;",
  "  const b = 2;",
  "  // the comment",
  "  const c = 3;",
  "  const d = 4;",
  "}",
  "",
].join("\n");

/** Strip BASE and hand back the stripped lines plus the single comment. */
function base(): { lines: string[]; comment: ExtractedComment } {
  const outcome = stripText(BASE, "jsts", DEFAULT_CONFIG);
  if (!outcome.ok) throw new Error(outcome.reason);
  expect(outcome.comments).toHaveLength(1);
  return { lines: linesOf(outcome.text), comment: outcome.comments[0]! };
}

function match(lines: string[], comment: ExtractedComment) {
  return matchOwnLine(lines, comment.anchor, comment.line - 1, OPTS);
}

describe("anchor matching", () => {
  it("places the comment where it started", () => {
    const { lines, comment } = base();
    expect(match(lines, comment)).toEqual({ at: 3, tier: "exact", reanchor: false });
  });

  it("does not re-anchor when code is inserted above", () => {
    const { lines, comment } = base();
    const moved = [...Array(50).fill("noise();"), ...lines];
    expect(match(moved, comment)).toEqual({ at: 53, tier: "exact", reanchor: false });
  });

  it("does not re-anchor when the whole block is reindented", () => {
    const { lines, comment } = base();
    const reindented = lines.map((l) => (l === "" ? l : "        " + l));
    expect(match(reindented, comment)).toEqual({ at: 3, tier: "exact", reanchor: false });
  });

  it("does not re-anchor when blank lines are added around the site", () => {
    const { lines, comment } = base();
    const spaced = [...lines.slice(0, 3), "", "", ...lines.slice(3)];
    const result = match(spaced, comment);
    expect(result?.tier).toBe("exact");
    expect(result?.reanchor).toBe(false);
  });

  it("re-anchors when the line immediately above is deleted", () => {
    const { lines, comment } = base();
    const cut = lines.filter((l) => !l.includes("const b = 2"));
    expect(match(cut, comment)).toEqual({ at: 2, tier: "partial", reanchor: true });
  });

  it("re-anchors when the line immediately below is deleted", () => {
    const { lines, comment } = base();
    const cut = lines.filter((l) => !l.includes("const c = 3"));
    expect(match(cut, comment)).toEqual({ at: 3, tier: "partial", reanchor: true });
  });

  it("orphans the comment when both surrounding windows are gone", () => {
    const { comment } = base();
    const rewritten = ["function beta() {", "  return compute();", "}", ""];
    expect(match(rewritten, comment)).toBeUndefined();
  });

  it("orphans rather than guessing between two equally plausible sites", () => {
    const lines = ["p();", "q();", "p();", "q();"];
    const anchor: Anchor = { before: ["p();"], after: ["q();"] };
    // Both site 1 and site 3 match fully and sit the same distance from the hint.
    expect(matchOwnLine(lines, anchor, 2, OPTS)).toBeUndefined();
  });

  it("uses the line hint to break a tie when one site is clearly closer", () => {
    const lines = ["p();", "q();", "p();", "q();"];
    const anchor: Anchor = { before: ["p();"], after: ["q();"] };
    expect(matchOwnLine(lines, anchor, 0, OPTS)?.at).toBe(1);
    expect(matchOwnLine(lines, anchor, 4, OPTS)?.at).toBe(3);
  });

  it("places a header comment against its trailing context alone", () => {
    const outcome = stripText("// Header\n\nconst a = 1;\nconst b = 2;\n", "jsts", DEFAULT_CONFIG);
    if (!outcome.ok) throw new Error(outcome.reason);
    const c = outcome.comments[0]!;
    expect(c.anchor.before).toEqual([]);
    expect(match(linesOf(outcome.text), c)).toEqual({
      at: 0,
      tier: "exact",
      reanchor: false,
    });
  });

  it("places a footer comment against its leading context alone", () => {
    const outcome = stripText("const a = 1;\nconst b = 2;\n\n// footer\n", "jsts", DEFAULT_CONFIG);
    if (!outcome.ok) throw new Error(outcome.reason);
    const c = outcome.comments[0]!;
    expect(c.anchor.after).toEqual([]);
    expect(match(linesOf(outcome.text), c)?.at).toBe(2);
  });

  it("finds a moved block via fuzzy matching and re-anchors it", () => {
    const { lines, comment } = base();
    // Rename the surrounding locals: close enough to recognise, not to match.
    const renamed = lines.map((l) =>
      l.replace("const c = 3;", "const cc = 33;").replace("const d = 4;", "const dd = 44;"),
    );
    const withoutBefore = renamed.filter(
      (l) => !l.includes("const a = 1") && !l.includes("const b = 2"),
    );
    const result = matchOwnLine(withoutBefore, comment.anchor, comment.line - 1, OPTS);
    expect(result?.tier).toBe("fuzzy");
    expect(result?.reanchor).toBe(true);
  });
});

describe("host matching for same-line comments", () => {
  function trailing() {
    const outcome = stripText("a();\nconst x = 1; // why\nb();\n", "jsts", DEFAULT_CONFIG);
    if (!outcome.ok) throw new Error(outcome.reason);
    return { lines: linesOf(outcome.text), comment: outcome.comments[0]! };
  }

  it("finds the host line exactly", () => {
    const { lines, comment } = trailing();
    expect(comment.anchor.host).toBe("const x = 1;");
    expect(matchHost(lines, comment.anchor, comment.line - 1, OPTS, true)).toEqual({
      at: 1,
      tier: "exact",
      reanchor: false,
    });
  });

  it("survives reindentation of the host line", () => {
    const { lines, comment } = trailing();
    const reindented = lines.map((l) => (l === "" ? l : "    " + l));
    expect(matchHost(reindented, comment.anchor, comment.line - 1, OPTS, true)?.tier).toBe(
      "exact",
    );
  });

  it("re-anchors when the host survives but its context moved", () => {
    const { comment } = trailing();
    const moved = ["z();", "const x = 1;", "y();"];
    const result = matchHost(moved, comment.anchor, comment.line - 1, OPTS, true);
    expect(result).toEqual({ at: 1, tier: "partial", reanchor: true });
  });

  it("places a trailing comment fuzzily when its line changed slightly", () => {
    const { comment } = trailing();
    const edited = ["a();", "const x = 2;", "b();"];
    const result = matchHost(edited, comment.anchor, comment.line - 1, OPTS, true);
    expect(result?.tier).toBe("fuzzy");
    expect(result?.at).toBe(1);
  });

  it("orphans an inline comment whose line changed rather than misplacing it", () => {
    const { comment } = trailing();
    const edited = ["a();", "const x = 2;", "b();"];
    expect(matchHost(edited, comment.anchor, comment.line - 1, OPTS, false)).toBeUndefined();
  });

  it("orphans when the host line is gone entirely", () => {
    const { comment } = trailing();
    expect(
      matchHost(["totally();", "different();"], comment.anchor, comment.line - 1, OPTS, true),
    ).toBeUndefined();
  });
});
