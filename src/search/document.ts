import { SearchMatch, SearchOptions } from "../models/search";
import { SecretData } from "../models/secret";
import { findRanges } from "./matcher";

/**
 * Render a secret's data exactly as it appears in the editor. This single
 * function is the source of truth for both the {@link VaultFileSystemProvider}
 * and the search engine, guaranteeing that match offsets computed during search
 * map precisely to editor positions.
 */
export function renderSecretDocument(data: SecretData): string {
  return JSON.stringify(data, null, 2) + "\n";
}

/** Precompute the starting offset of every line for fast offset→position mapping. */
export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      starts.push(i + 1);
    }
  }
  return starts;
}

/** Convert an absolute offset to a zero-based {line, character} position. */
export function offsetToPosition(lineStarts: number[], offset: number): { line: number; character: number } {
  // Binary search for the greatest lineStart <= offset.
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return { line: lo, character: offset - lineStarts[lo] };
}

const KEY_TOKEN = /^(\s*)"((?:[^"\\]|\\.)*)"\s*:/;

/**
 * Scan a rendered JSON document for matches, honoring the key/value filters.
 *
 * Matching runs over the full document text so multi-line values (nested,
 * indented objects/arrays) are searched exactly as displayed. Each match is
 * classified as `key` or `value` based on whether it lands inside a JSON key
 * token on its starting line.
 */
export function scanDocument(document: string, matcher: RegExp, options: SearchOptions): SearchMatch[] {
  if (!options.searchKeys && !options.searchValues) {
    return [];
  }
  const lineStarts = computeLineStarts(document);
  const ranges = findRanges(matcher, document);
  const matches: SearchMatch[] = [];

  for (const [startOffset, endOffset] of ranges) {
    const start = offsetToPosition(lineStarts, startOffset);
    const end = offsetToPosition(lineStarts, endOffset);
    const lineStart = lineStarts[start.line];
    const nextLineStart = start.line + 1 < lineStarts.length ? lineStarts[start.line + 1] : document.length;
    const lineText = document.slice(lineStart, nextLineStart).replace(/\n$/, "");

    const location = classify(lineText, start.character);
    if (location === "key" && !options.searchKeys) {
      continue;
    }
    if (location === "value" && !options.searchValues) {
      continue;
    }

    const lineMatchEnd = start.line === end.line ? end.character : lineText.length;
    matches.push({
      location,
      startOffset,
      endOffset,
      startLine: start.line,
      startChar: start.character,
      endLine: end.line,
      endChar: end.character,
      lineText,
      lineMatchStart: start.character,
      lineMatchEnd,
      matchText: document.slice(startOffset, endOffset),
    });
  }
  return matches;
}

/** Decide whether a position on a line falls inside the JSON key token. */
function classify(lineText: string, character: number): "key" | "value" {
  const m = KEY_TOKEN.exec(lineText);
  if (!m) {
    return "value";
  }
  const keyContentStart = m[1].length + 1; // after opening quote
  const keyContentEnd = keyContentStart + m[2].length; // before closing quote
  return character >= keyContentStart && character < keyContentEnd ? "key" : "value";
}
