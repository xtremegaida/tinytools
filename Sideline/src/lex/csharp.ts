import type { CommentKind, CommentSpan } from "../comment.js";
import { LineMap } from "./scanner.js";

/**
 * Locate every comment in a C# source.
 *
 * C# has no regex-literal ambiguity, but it has by far the richer string
 * grammar: regular, verbatim (`@"…"`, where `""` escapes a quote and `\` is
 * literal), interpolated (`$"…"`), the two verbatim-interpolated spellings
 * (`$@"…"` and `@$"…"`), and raw strings (`"""…"""`) with N-quote delimiters
 * and an N-dollar interpolated form. Every one of them can contain `//` or
 * `/*` as ordinary text, so all of them have to be scanned properly.
 */
export function lexCSharp(text: string): CommentSpan[] {
  const map = new LineMap(text);
  const out: CommentSpan[] = [];

  let i = 0;

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

  /**
   * Consume an interpolation hole opener at `i` if one is present.
   *
   * With N dollar signs it takes N consecutive braces to open a hole. In the
   * ordinary single-dollar case `{{` is instead an escaped literal brace.
   * Returns true if it consumed something.
   */
  function tryInterpolationHole(dollars: number): boolean {
    if (dollars <= 0 || text[i] !== "{") return false;

    let k = 0;
    while (text[i + k] === "{") k++;

    if (dollars === 1) {
      if (k === 1) {
        i += 1;
        scan(true);
        if (text[i] === "}") i++;
      } else {
        i += 2; // `{{` escape; any remainder is re-examined next iteration
      }
      return true;
    }

    if (k >= dollars) {
      i += dollars;
      scan(true);
      if (text[i] === "}") i++;
    } else {
      i += k;
    }
    return true;
  }

  /** Regular or interpolated string starting at a single `"`. */
  function scanRegularString(dollars: number): void {
    i++; // opening quote
    while (i < text.length) {
      const c = text[i]!;
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        return;
      }
      if (c === "\n") return; // unterminated
      if (tryInterpolationHole(dollars)) continue;
      i++;
    }
  }

  /** `@"…"` / `$@"…"` / `@$"…"`. `""` escapes a quote; newlines are allowed. */
  function scanVerbatimString(dollars: number): void {
    i++; // opening quote
    while (i < text.length) {
      const c = text[i]!;
      if (c === '"') {
        if (text[i + 1] === '"') {
          i += 2;
          continue;
        }
        i++;
        return;
      }
      if (tryInterpolationHole(dollars)) continue;
      i++;
    }
  }

  /** `"""…"""` raw string. Closes on a run of at least `quotes` quotes. */
  function scanRawString(quotes: number, dollars: number): void {
    i += quotes;
    while (i < text.length) {
      if (text[i] === '"') {
        let k = 0;
        while (text[i + k] === '"') k++;
        i += k;
        if (k >= quotes) return;
        continue;
      }
      if (tryInterpolationHole(dollars)) continue;
      i++;
    }
  }

  /** Dispatch on the quote run length: 3+ means a raw string. */
  function scanStringAtQuote(dollars: number): void {
    let quotes = 0;
    while (text[i + quotes] === '"') quotes++;
    if (quotes >= 3) scanRawString(quotes, dollars);
    else scanRegularString(dollars);
  }

  function scanCharLiteral(): void {
    i++; // opening quote
    while (i < text.length) {
      const c = text[i]!;
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "'") {
        i++;
        return;
      }
      if (c === "\n") return; // unterminated
      i++;
    }
  }

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
        i++;
        continue;
      }

      if (c === '"') {
        scanStringAtQuote(0);
        continue;
      }

      if (c === "'") {
        scanCharLiteral();
        continue;
      }

      if (c === "@") {
        if (text[i + 1] === '"') {
          i++;
          scanVerbatimString(0);
          continue;
        }
        if (text[i + 1] === "$" && text[i + 2] === '"') {
          // `@$"…"` — verbatim interpolated
          i += 2;
          scanVerbatimString(1);
          continue;
        }
        i++; // `@identifier` escape
        continue;
      }

      if (c === "$") {
        let j = i;
        let dollars = 0;
        while (text[j] === "$") {
          dollars++;
          j++;
        }
        if (text[j] === "@" && text[j + 1] === '"') {
          i = j + 1;
          scanVerbatimString(dollars);
          continue;
        }
        if (text[j] === '"') {
          i = j;
          scanStringAtQuote(dollars);
          continue;
        }
        i = j;
        continue;
      }

      if (c === "{") {
        depth++;
        i++;
        continue;
      }

      if (c === "}") {
        if (depth > 0) {
          depth--;
          i++;
          continue;
        }
        if (stopAtCloseBrace) return;
        i++;
        continue;
      }

      i++;
    }
  }

  scan(false);
  return out;
}
