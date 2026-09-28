/**
 * Byte-exact text file decoding and re-encoding.
 *
 * Sideline's headline promise is that non-comment code survives untouched, so
 * this module keeps the terminator of every individual line rather than
 * normalising to a single style. A file with mixed CRLF/LF re-encodes exactly
 * as it came in; only lines Sideline itself inserts use the dominant style.
 */

export type EolStyle = "lf" | "crlf";

export type Encoding = "utf8" | "utf8bom" | "utf16le";

export interface TextFile {
  /** Line contents, without terminators. */
  lines: string[];
  /**
   * Terminator for each line, parallel to `lines`. Empty string for a final
   * line with no trailing newline. Always the same length as `lines`.
   */
  lineEols: string[];
  /** Dominant style, used for lines Sideline inserts. */
  eol: EolStyle;
  encoding: Encoding;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

export class UnsupportedEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedEncodingError";
  }
}

export function detectEncoding(buf: Buffer): Encoding {
  if (buf.length >= 3 && buf.subarray(0, 3).equals(UTF8_BOM)) return "utf8bom";
  if (buf.length >= 2 && buf.subarray(0, 2).equals(UTF16LE_BOM)) return "utf16le";
  if (buf.length >= 2 && buf.subarray(0, 2).equals(UTF16BE_BOM)) {
    throw new UnsupportedEncodingError("UTF-16BE is not supported");
  }
  return "utf8";
}

function toStringWith(buf: Buffer, encoding: Encoding): string {
  switch (encoding) {
    case "utf8bom":
      return buf.subarray(UTF8_BOM.length).toString("utf8");
    case "utf16le":
      return buf.subarray(UTF16LE_BOM.length).toString("utf16le");
    case "utf8":
      return buf.toString("utf8");
  }
}

/**
 * Split text into lines, keeping each line's own terminator.
 *
 * A lone CR is deliberately treated as line content rather than a terminator:
 * CR-only files are extinct, and treating it as content is what round-trips.
 */
export function splitLines(text: string): { lines: string[]; lineEols: string[] } {
  const lines: string[] = [];
  const lineEols: string[] = [];

  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n") continue;
    const hasCr = i > 0 && text[i - 1] === "\r";
    lines.push(text.slice(start, hasCr ? i - 1 : i));
    lineEols.push(hasCr ? "\r\n" : "\n");
    start = i + 1;
  }

  if (start < text.length) {
    lines.push(text.slice(start));
    lineEols.push("");
  }

  return { lines, lineEols };
}

export function dominantEol(lineEols: readonly string[]): EolStyle {
  let crlf = 0;
  let lf = 0;
  for (const e of lineEols) {
    if (e === "\r\n") crlf++;
    else if (e === "\n") lf++;
  }
  // Ties go to LF; a file with no terminators at all has no evidence either way.
  return crlf > lf ? "crlf" : "lf";
}

export function decode(buf: Buffer): TextFile {
  const encoding = detectEncoding(buf);
  const text = toStringWith(buf, encoding);
  const { lines, lineEols } = splitLines(text);
  return { lines, lineEols, eol: dominantEol(lineEols), encoding };
}

export function encode(file: TextFile): Buffer {
  if (file.lines.length !== file.lineEols.length) {
    throw new Error(
      `TextFile invariant violated: ${file.lines.length} lines vs ${file.lineEols.length} terminators`,
    );
  }

  let text = "";
  for (let i = 0; i < file.lines.length; i++) {
    text += file.lines[i]! + file.lineEols[i]!;
  }

  switch (file.encoding) {
    case "utf8bom":
      return Buffer.concat([UTF8_BOM, Buffer.from(text, "utf8")]);
    case "utf16le":
      return Buffer.concat([UTF16LE_BOM, Buffer.from(text, "utf16le")]);
    case "utf8":
      return Buffer.from(text, "utf8");
  }
}

/** The literal terminator string for a style. */
export function eolString(style: EolStyle): string {
  return style === "crlf" ? "\r\n" : "\n";
}

/**
 * Terminators for a line array that has had lines added or removed.
 *
 * `trailing` is whatever ended the original file — usually a newline, but empty
 * when the file had no final newline. Carrying it explicitly is what lets a
 * file whose last line was a comment round-trip: stripping that line would
 * otherwise silently introduce or drop a final newline.
 */
export function rebuildEols(
  lineCount: number,
  dominant: EolStyle,
  trailing: string,
): string[] {
  if (lineCount === 0) return [];
  const e = eolString(dominant);
  const out = new Array<string>(lineCount).fill(e);
  out[lineCount - 1] = trailing;
  return out;
}

/** True when the file mixes CRLF and LF terminators. */
export function hasMixedEol(lineEols: readonly string[]): boolean {
  let crlf = false;
  let lf = false;
  for (const e of lineEols) {
    if (e === "\r\n") crlf = true;
    else if (e === "\n") lf = true;
    if (crlf && lf) return true;
  }
  return false;
}

export function joinLines(lines: readonly string[], lineEols: readonly string[]): string {
  let text = "";
  for (let i = 0; i < lines.length; i++) text += lines[i]! + (lineEols[i] ?? "");
  return text;
}

