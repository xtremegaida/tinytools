import path from "node:path";
import type { CommentSpan } from "../comment.js";
import { lexCSharp } from "./csharp.js";
import { lexJsTs, looksLikeJsx } from "./jsts.js";

export type Language = "csharp" | "jsts";

export { looksLikeJsx };

const BY_EXTENSION: Record<string, Language> = {
  ".cs": "csharp",
  ".ts": "jsts",
  ".mts": "jsts",
  ".cts": "jsts",
  ".js": "jsts",
  ".mjs": "jsts",
  ".cjs": "jsts",
};

export function languageOf(filePath: string): Language | undefined {
  return BY_EXTENSION[path.extname(filePath).toLowerCase()];
}

export function lex(language: Language, text: string): CommentSpan[] {
  return language === "csharp" ? lexCSharp(text) : lexJsTs(text);
}
