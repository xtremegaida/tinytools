import type { CommentKind, CommentSpan } from "../comment.js";
import { LineMap, isWordChar } from "./scanner.js";

/**
 * Keywords after which a `/` must begin a regex literal rather than a division.
 */
const REGEX_ALLOWING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "do",
  "else",
  "case",
  "yield",
  "await",
]);

type TokenClass = "none" | "punct" | "word" | "value";

/**
 * Locate every comment in a TypeScript or JavaScript source.
 *
 * The only genuinely hard part is telling a regex literal from a division,
 * since `/` starts both. That is decided from the preceding significant token:
 * after a value (number, string, template, regex, `)`, `]`, `++`, `--`) a `/`
 * divides; otherwise it opens a regex. The two known-ambiguous cases are `)`
 * (read as division, so `if (x) /re/.test(s)` misreads) and `}` (read as a
 * block end, so regex is allowed). Both are rare, and `verifyRoundTrip` in
 * strip.ts catches any resulting corruption before anything is written.
 */
export function lexJsTs(text: string): CommentSpan[] {
  const map = new LineMap(text);
  const out: CommentSpan[] = [];

  let i = 0;
  let tokClass: TokenClass = "none";
  let lastPunct = "";
  let lastWord = "";

  function push(start: number, end: number, kind: CommentKind): void {
    out.push({
      kind,
      start: map.posAt(start),
      end: map.posAt(end),
      text: text.slice(start, end),
    });
  }

  function lineComment(): void {
    const start = i;
    i += 2;
    while (i < text.length && text[i] !== "\n") i++;
    push(start, i, "line");
    // Deliberately leaves tokClass alone: a comment is not a token, so
    // `x = /* c */ /re/` still sees `=` and reads a regex.
  }

  function blockComment(): void {
    const start = i;
    i += 2;
    while (i < text.length) {
      if (text[i] === "*" && text[i + 1] === "/") {
        i += 2;
        break;
      }
      i++;
    }
    push(start, i, "block");
  }

  function regexAllowed(): boolean {
    switch (tokClass) {
      case "none":
        return true;
      case "value":
        return false;
      case "word":
        return REGEX_ALLOWING_KEYWORDS.has(lastWord);
      case "punct":
        return !(
          lastPunct === ")" ||
          lastPunct === "]" ||
          lastPunct === "++" ||
          lastPunct === "--"
        );
    }
  }

  function scanRegex(): void {
    i++; // past the opening slash
    let inClass = false;
    while (i < text.length) {
      const c = text[i]!;
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "\n") break; // unterminated; bail rather than swallow the file
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) {
        i++;
        break;
      }
      i++;
    }
    while (i < text.length && isWordChar(text[i]!)) i++; // flags
    tokClass = "value";
  }

  function scanQuoted(quote: string): void {
    i++;
    while (i < text.length) {
      const c = text[i]!;
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) {
        i++;
        break;
      }
      if (c === "\n") break; // unterminated
      i++;
    }
    tokClass = "value";
  }

  function scanTemplate(): void {
    i++; // past the opening backtick
    while (i < text.length) {
      const c = text[i]!;
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        i++;
        break;
      }
      if (c === "$" && text[i + 1] === "{") {
        i += 2;
        scan(true);
        if (text[i] === "}") i++;
        continue;
      }
      i++;
    }
    tokClass = "value";
  }

  /**
   * Main loop. When `stopAtCloseBrace` is set (we are inside a `${}` hole) it
   * returns at the first `}` not matched by a `{` it consumed itself.
   */
  function scan(stopAtCloseBrace: boolean): void {
    let depth = 0;

    while (i < text.length) {
      const c = text[i]!;

      if (c === "/") {
        const n = text[i + 1];
        if (n === "/") {
          lineComment();
          continue;
        }
        if (n === "*") {
          blockComment();
          continue;
        }
        if (regexAllowed()) {
          scanRegex();
          continue;
        }
        i++;
        tokClass = "punct";
        lastPunct = "/";
        continue;
      }

      if (c === '"' || c === "'") {
        scanQuoted(c);
        continue;
      }

      if (c === "`") {
        scanTemplate();
        continue;
      }

      if (c === "{") {
        depth++;
        i++;
        tokClass = "punct";
        lastPunct = "{";
        continue;
      }

      if (c === "}") {
        if (depth > 0) {
          depth--;
          i++;
          tokClass = "punct";
          lastPunct = "}";
          continue;
        }
        if (stopAtCloseBrace) return;
        i++;
        tokClass = "punct";
        lastPunct = "}";
        continue;
      }

      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        i++;
        continue;
      }

      if (/[0-9]/.test(c)) {
        while (i < text.length && /[0-9A-Za-z_.]/.test(text[i]!)) i++;
        tokClass = "value";
        continue;
      }

      if (isWordChar(c)) {
        const start = i;
        while (i < text.length && isWordChar(text[i]!)) i++;
        lastWord = text.slice(start, i);
        tokClass = "word";
        continue;
      }

      if ((c === "+" || c === "-") && text[i + 1] === c) {
        i += 2;
        tokClass = "punct";
        lastPunct = c + c;
        continue;
      }

      i++;
      tokClass = "punct";
      lastPunct = c;
    }
  }

  // A shebang is only a comment on the very first line.
  if (text.startsWith("#!")) {
    const start = 0;
    i = 2;
    while (i < text.length && text[i] !== "\n") i++;
    push(start, i, "line");
  }

  scan(false);
  return out;
}

/**
 * Heuristic detection of JSX in a `.js` file.
 *
 * JSX is outside the supported set, and inside JSX text a `//` is literal
 * content rather than a comment — stripping it would corrupt the file. Callers
 * skip such files with a warning instead of guessing.
 */
export function looksLikeJsx(text: string): boolean {
  return /(?:^|[=(,{[:?]|=>|\breturn)\s*<[A-Za-z][A-Za-z0-9.]*(?:\s|\/?>)/m.test(text);
}
