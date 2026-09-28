import { describe, expect, it } from "vitest";
import { lexCSharp } from "../src/lex/csharp.js";
import { lexJsTs, looksLikeJsx } from "../src/lex/jsts.js";

function texts(spans: { text: string }[]): string[] {
  return spans.map((s) => s.text);
}

describe("lexJsTs", () => {
  it("ignores // inside string literals", () => {
    expect(texts(lexJsTs(`const a = "// not a comment";`))).toEqual([]);
    expect(texts(lexJsTs(`const u = 'https://example.com';`))).toEqual([]);
  });

  it("finds a comment after a string containing //", () => {
    expect(texts(lexJsTs(`const u = "https://x.com"; // real`))).toEqual(["// real"]);
  });

  it("treats / as division after a value and still finds the comment", () => {
    expect(texts(lexJsTs(`const x = a / b; // real`))).toEqual(["// real"]);
    expect(texts(lexJsTs(`const x = y / z / w; // real`))).toEqual(["// real"]);
  });

  it("scans regex literals without mistaking their contents for comments", () => {
    expect(texts(lexJsTs(`const r = /ab\\/\\/cd/g; // real`))).toEqual(["// real"]);
    expect(texts(lexJsTs(`const r = /[/]/; // real`))).toEqual(["// real"]);
    expect(texts(lexJsTs(`const r = /a[^/]*b/gi;`))).toEqual([]);
  });

  it("allows a regex directly after a comment", () => {
    expect(texts(lexJsTs(`x = /* c */ /re/.test(s);`))).toEqual(["/* c */"]);
  });

  it("handles template literals and their holes", () => {
    expect(texts(lexJsTs('const t = `${ "//" }`; // real'))).toEqual(["// real"]);
    expect(texts(lexJsTs("const t = `a//b`;"))).toEqual([]);
  });

  it("handles nested template literals", () => {
    const src = 'const t = `a${`b${"//"}c`}d`; // real';
    expect(texts(lexJsTs(src))).toEqual(["// real"]);
  });

  it("finds comments inside template holes", () => {
    expect(texts(lexJsTs("const t = `${ x /* c */ }`;"))).toEqual(["/* c */"]);
  });

  it("handles object literals inside template holes", () => {
    const src = "const t = `${ JSON.stringify({ a: 1 }) }`; // real";
    expect(texts(lexJsTs(src))).toEqual(["// real"]);
  });

  it("reads a shebang as a comment", () => {
    const spans = lexJsTs("#!/usr/bin/env node\nconst a = 1;");
    expect(texts(spans)).toEqual(["#!/usr/bin/env node"]);
  });

  it("does not treat a mid-file #! as a comment", () => {
    expect(texts(lexJsTs("const a = 1;\nconst b = 2;"))).toEqual([]);
  });

  it("runs an unterminated block comment to end of file", () => {
    expect(texts(lexJsTs("code();\n/* never closed\nmore"))).toEqual([
      "/* never closed\nmore",
    ]);
  });

  it("reports accurate positions", () => {
    const spans = lexJsTs("a();\nb(); // why\n");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.start).toEqual({ line: 1, col: 5 });
    expect(spans[0]!.end).toEqual({ line: 1, col: 11 });
  });

  it("spans multi-line block comments", () => {
    const spans = lexJsTs("a();\n/* one\n   two */\nb();");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.start).toEqual({ line: 1, col: 0 });
    expect(spans[0]!.end).toEqual({ line: 2, col: 9 });
  });
});

describe("looksLikeJsx", () => {
  it("detects JSX in .js source", () => {
    expect(looksLikeJsx("const A = () => <div>hi</div>;")).toBe(true);
    expect(looksLikeJsx("function f() { return <Foo bar={1} />; }")).toBe(true);
  });

  it("does not flag ordinary comparisons or generics", () => {
    expect(looksLikeJsx("if (a < b) { return 1; }")).toBe(false);
    expect(looksLikeJsx("const n = count < 10;")).toBe(false);
  });
});

describe("lexCSharp", () => {
  it("ignores // inside verbatim strings", () => {
    expect(texts(lexCSharp(`var s = @"C:\\path // not a comment";`))).toEqual([]);
  });

  it("handles doubled quotes in verbatim strings", () => {
    expect(texts(lexCSharp(`var s = @"say ""hi"" // no"; // real`))).toEqual(["// real"]);
  });

  it("ignores escaped quotes in regular strings", () => {
    expect(texts(lexCSharp(`var s = "a\\"// not"; // real`))).toEqual(["// real"]);
  });

  it("ignores // in the literal part of an interpolated string", () => {
    expect(texts(lexCSharp(`var s = $"{a} // not"; // real`))).toEqual(["// real"]);
  });

  it("handles escaped braces in interpolated strings", () => {
    expect(texts(lexCSharp(`var s = $"{{literal}} // not"; // real`))).toEqual(["// real"]);
  });

  it("handles verbatim interpolated strings in both spellings", () => {
    expect(texts(lexCSharp(`var s = $@"{a} // not"; // real`))).toEqual(["// real"]);
    expect(texts(lexCSharp(`var s = @$"{a} // not"; // real`))).toEqual(["// real"]);
  });

  it("handles raw strings", () => {
    expect(texts(lexCSharp(`var s = """ // not a comment """; // real`))).toEqual([
      "// real",
    ]);
  });

  it("handles raw strings with longer delimiters", () => {
    const src = `var s = """"contains """ inside""""; // real`;
    expect(texts(lexCSharp(src))).toEqual(["// real"]);
  });

  it("handles multi-line raw strings", () => {
    const src = 'var s = """\n  // not a comment\n  """;\n// real';
    expect(texts(lexCSharp(src))).toEqual(["// real"]);
  });

  it("handles raw interpolated strings with double dollars", () => {
    const src = `var s = $$"""{{x}} // not"""; // real`;
    expect(texts(lexCSharp(src))).toEqual(["// real"]);
  });

  it("handles char literals", () => {
    expect(texts(lexCSharp(`char c = '/'; // real`))).toEqual(["// real"]);
    expect(texts(lexCSharp(`char c = '\\''; // real`))).toEqual(["// real"]);
  });

  it("finds XML doc comments", () => {
    const src = "/// <summary>Does a thing.</summary>\npublic void M() { }";
    expect(texts(lexCSharp(src))).toEqual(["/// <summary>Does a thing.</summary>"]);
  });

  it("finds comments inside interpolation holes", () => {
    expect(texts(lexCSharp(`var s = $"{a /* c */}";`))).toEqual(["/* c */"]);
  });

  it("does not treat @identifier as a string", () => {
    expect(texts(lexCSharp(`var @class = 1; // real`))).toEqual(["// real"]);
  });

  it("handles block comments spanning lines", () => {
    const spans = lexCSharp("a();\n/* one\n   two */\nb();");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.start).toEqual({ line: 1, col: 0 });
  });
});
