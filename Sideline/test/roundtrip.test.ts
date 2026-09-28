import { describe, expect, it } from "vitest";
import type { ExtractedComment } from "../src/comment.js";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import { restoreText, stripText, toResolved } from "../src/extract.js";
import type { Language } from "../src/lex/index.js";

interface TripResult {
  stripped: string;
  rebuilt: string;
  comments: ExtractedComment[];
}

function trip(src: string, lang: Language = "jsts", config: Config = DEFAULT_CONFIG): TripResult {
  const outcome = stripText(src, lang, config, { verify: false });
  if (!outcome.ok) throw new Error(`unexpectedly skipped: ${outcome.reason}`);
  return {
    stripped: outcome.text,
    rebuilt: restoreText(outcome.text, toResolved(outcome.comments), outcome.meta),
    comments: outcome.comments,
  };
}

/** The invariant the whole tool rests on. */
function expectExactRoundTrip(src: string, lang: Language = "jsts"): TripResult {
  const r = trip(src, lang);
  expect(r.rebuilt).toBe(src);
  return r;
}

describe("round trip exactness", () => {
  it("handles a leading comment with no blank lines", () => {
    const r = expectExactRoundTrip("const a = 1;\n// why\nconst b = 2;\n");
    expect(r.stripped).toBe("const a = 1;\nconst b = 2;\n");
  });

  it("handles a blank line above the comment", () => {
    const r = expectExactRoundTrip("const a = 1;\n\n// why\nconst b = 2;\n");
    expect(r.stripped).toBe("const a = 1;\n\nconst b = 2;\n");
  });

  it("handles a blank line below the comment", () => {
    const r = expectExactRoundTrip("const a = 1;\n// why\n\nconst b = 2;\n");
    expect(r.stripped).toBe("const a = 1;\n\nconst b = 2;\n");
  });

  it("collapses blanks on both sides to a single run", () => {
    const r = expectExactRoundTrip("const a = 1;\n\n// why\n\nconst b = 2;\n");
    expect(r.stripped).toBe("const a = 1;\n\nconst b = 2;\n");
  });

  it("keeps a wider blank run when the original had one", () => {
    const r = expectExactRoundTrip("const a = 1;\n\n\n// why\nconst b = 2;\n");
    expect(r.stripped).toBe("const a = 1;\n\n\nconst b = 2;\n");
  });

  it("merges comments separated by a blank line into one block", () => {
    const src = "const a = 1;\n\n// one\n\n// two\n\nconst b = 2;\n";
    const r = expectExactRoundTrip(src);
    expect(r.stripped).toBe("const a = 1;\n\nconst b = 2;\n");
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]!.text).toBe("// one\n\n// two");
  });

  it("does not leave a leading blank line for a file header", () => {
    const r = expectExactRoundTrip("// Header\n\nconst a = 1;\n");
    expect(r.stripped).toBe("const a = 1;\n");
    expect(r.comments[0]!.placement).toBe("header");
  });

  it("does not leave a trailing blank line for a file footer", () => {
    const r = expectExactRoundTrip("const a = 1;\n\n\n// trailing thought\n");
    expect(r.stripped).toBe("const a = 1;\n");
    expect(r.comments[0]!.placement).toBe("footer");
  });

  it("handles a file with no trailing newline", () => {
    const r = expectExactRoundTrip("const a = 1;\n// why\nconst b = 2;");
    expect(r.stripped).toBe("const a = 1;\nconst b = 2;");
  });

  it("handles a comment as the very last line with no trailing newline", () => {
    expectExactRoundTrip("const a = 1;\n// last");
  });

  it("handles a file that is only comments", () => {
    const r = expectExactRoundTrip("// just\n// comments\n");
    expect(r.stripped).toBe("");
  });

  it("preserves indentation of an indented block", () => {
    const src = "function f() {\n    // inner\n    return 1;\n}\n";
    const r = expectExactRoundTrip(src);
    expect(r.stripped).toBe("function f() {\n    return 1;\n}\n");
    expect(r.comments[0]!.indent).toBe("    ");
    expect(r.comments[0]!.text).toBe("// inner");
  });

  it("handles a multi-line block comment on its own lines", () => {
    const src = "a();\n/*\n * one\n * two\n */\nb();\n";
    const r = expectExactRoundTrip(src);
    expect(r.stripped).toBe("a();\nb();\n");
  });

  it("handles trailing comments", () => {
    const r = expectExactRoundTrip("const a = 1; // why\nconst b = 2;\n");
    expect(r.stripped).toBe("const a = 1;\nconst b = 2;\n");
    expect(r.comments[0]!.placement).toBe("trailing");
  });

  it("handles an inline block comment between code", () => {
    const r = expectExactRoundTrip("foo(/* a */ 1);\n");
    expect(r.stripped).toBe("foo(1);\n");
    expect(r.comments[0]!.placement).toBe("inline");
  });

  it("inserts a separator only where the junction needs one", () => {
    expect(trip("const x = a /* c */ + b;\n").stripped).toBe("const x = a + b;\n");
    expect(trip("foo(1 /* c */, 2);\n").stripped).toBe("foo(1, 2);\n");
    expect(trip("const /* c */ x = 1;\n").stripped).toBe("const x = 1;\n");
    expectExactRoundTrip("const /* c */ x = 1;\n");
  });

  it("keeps the line indent when an inline comment starts the line", () => {
    const r = expectExactRoundTrip("function f() {\n    /* c */ return 1;\n}\n");
    expect(r.stripped).toBe("function f() {\n    return 1;\n}\n");
  });

  it("handles several comments on one line", () => {
    const r = expectExactRoundTrip("a /* x */ /* y */ b;\n");
    expect(r.stripped).toBe("a b;\n");
    expect(r.comments).toHaveLength(2);
  });

  it("handles code, an inline comment, and a trailing comment on one line", () => {
    const r = expectExactRoundTrip("foo(/* x */ 1); // y\n");
    expect(r.stripped).toBe("foo(1);\n");
  });

  it("handles a block comment that spans lines mid-expression", () => {
    const src = "foo(/* a\n   b */ 1);\n";
    const r = expectExactRoundTrip(src);
    expect(r.stripped).toBe("foo(1);\n");
  });

  it("handles two own-line comments separated by retained code", () => {
    const src = "// one\na();\n// two\nb();\n";
    const r = expectExactRoundTrip(src);
    expect(r.stripped).toBe("a();\nb();\n");
    expect(r.comments).toHaveLength(2);
  });

  it("handles an empty file", () => {
    expectExactRoundTrip("");
  });

  it("handles a file with no comments at all", () => {
    const r = expectExactRoundTrip("const a = 1;\nconst b = 2;\n");
    expect(r.comments).toHaveLength(0);
  });

  it("leaves pragma comments in place and splits blocks around them", () => {
    const src = "// explain\n// @ts-expect-error legacy\n// more\nfoo();\n";
    const r = expectExactRoundTrip(src);
    expect(r.stripped).toBe("// @ts-expect-error legacy\nfoo();\n");
    expect(r.comments).toHaveLength(2);
    expect(r.comments.map((c) => c.text)).toEqual(["// explain", "// more"]);
  });

  it("anchors against a preserved comment as if it were code", () => {
    const src = "// explain\n// @ts-expect-error legacy\nfoo();\n";
    const r = trip(src);
    expect(r.comments[0]!.anchor.after[0]).toBe("// @ts-expect-error legacy");
  });
});

describe("round trip exactness (C#)", () => {
  it("handles XML doc comments", () => {
    const src =
      "public class A\n{\n    /// <summary>Does a thing.</summary>\n    public void M() { }\n}\n";
    const r = expectExactRoundTrip(src, "csharp");
    expect(r.stripped).toBe("public class A\n{\n    public void M() { }\n}\n");
    expect(r.comments[0]!.cls).toBe("doc");
  });

  it("handles a multi-line XML doc block as one comment", () => {
    const src = [
      "    /// <summary>",
      "    /// Does a thing.",
      "    /// </summary>",
      "    public void M() { }",
      "",
    ].join("\n");
    const r = expectExactRoundTrip(src, "csharp");
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]!.indent).toBe("    ");
  });

  it("leaves strings containing comment markers untouched", () => {
    const src = 'var s = @"C:\\x // not";\n// real\nvar t = 1;\n';
    const r = expectExactRoundTrip(src, "csharp");
    expect(r.stripped).toBe('var s = @"C:\\x // not";\nvar t = 1;\n');
  });

  it("handles a license header", () => {
    const src = "// Copyright (c) 2026 Example Ltd.\n// SPDX-License-Identifier: MIT\n\nclass A { }\n";
    const r = expectExactRoundTrip(src, "csharp");
    expect(r.stripped).toBe("class A { }\n");
    expect(r.comments[0]!.cls).toBe("license");
  });
});

describe("verification", () => {
  it("accepts every round-trip case with verify enabled", () => {
    const cases: [string, Language][] = [
      ["const a = 1; // x\n", "jsts"],
      ["// h\n\nconst a = 1;\n", "jsts"],
      ["foo(/* a */ 1);\n", "jsts"],
      ["class A { /* x */ }\n", "csharp"],
      ['var s = $"{a} // no"; // yes\n', "csharp"],
    ];
    for (const [src, lang] of cases) {
      const outcome = stripText(src, lang, DEFAULT_CONFIG, { verify: true });
      expect(outcome.ok, `expected ${JSON.stringify(src)} to verify`).toBe(true);
    }
  });

  it("skips a .js file containing JSX", () => {
    const src = "const A = () => <div>hi</div>; // c\n";
    const outcome = stripText(src, "jsts", DEFAULT_CONFIG, { isJsFile: true });
    expect(outcome).toEqual({ ok: false, reason: "jsx" });
  });

  it("skips an auto-generated file", () => {
    const src = "// <auto-generated/>\n// c\nclass A { }\n";
    const outcome = stripText(src, "csharp", DEFAULT_CONFIG);
    expect(outcome).toEqual({ ok: false, reason: "auto-generated" });
  });

  it("skips a file with mixed line endings rather than normalising it", () => {
    const src = "const a = 1;\r\nconst b = 2;\n// c\nconst d = 3;\n";
    expect(stripText(src, "jsts", DEFAULT_CONFIG)).toEqual({
      ok: false,
      reason: "mixed-eol",
    });
  });
});

describe("line endings", () => {
  it("round-trips a CRLF file byte for byte", () => {
    const src = "const a = 1;\r\n\r\n// why\r\nconst b = 2;\r\n";
    const outcome = stripText(src, "jsts", DEFAULT_CONFIG);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toBe("const a = 1;\r\n\r\nconst b = 2;\r\n");
    expect(restoreText(outcome.text, toResolved(outcome.comments), outcome.meta)).toBe(src);
  });

  it("round-trips a file with no final newline whose last line is a comment", () => {
    const src = "const a = 1;\n// last";
    const outcome = stripText(src, "jsts", DEFAULT_CONFIG);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toBe("const a = 1;");
    expect(restoreText(outcome.text, toResolved(outcome.comments), outcome.meta)).toBe(src);
  });

  it("round-trips a file that strips down to nothing", () => {
    const src = "// just\n// comments\n";
    const outcome = stripText(src, "jsts", DEFAULT_CONFIG);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toBe("");
    expect(restoreText(outcome.text, toResolved(outcome.comments), outcome.meta)).toBe(src);
  });
});
