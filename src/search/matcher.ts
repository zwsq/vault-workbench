import { SearchOptions } from "../models/search";

/**
 * Compile a search query + options into a global RegExp used for matching and
 * replacement. Pure and vscode-free so it can be unit tested.
 *
 * Literal (non-regex) multi-line queries are matched whitespace-flexibly: every
 * run of whitespace in the query matches any run of whitespace in the document.
 * This lets a user paste a formatted JSON block (with its own indentation) and
 * still match the pretty-printed secret regardless of nesting depth.
 *
 * @throws SyntaxError if `regex` is enabled and the pattern is invalid.
 */
export function buildMatcher(query: string, options: SearchOptions): RegExp {
  let source: string;
  if (options.regex) {
    source = query;
  } else if (/[\r\n]/.test(query)) {
    source = literalMultilineSource(query);
  } else {
    source = escapeRegExp(query);
  }
  if (options.wholeWord) {
    source = `\\b(?:${source})\\b`;
  }
  const flags = "g" + (options.matchCase ? "" : "i");
  return new RegExp(source, flags);
}

/** Turn a multi-line literal into a whitespace-flexible pattern. */
function literalMultilineSource(query: string): string {
  const trimmed = query.replace(/^\s+|\s+$/g, "");
  return trimmed
    .split(/\s+/)
    .map(escapeRegExp)
    .join("\\s+");
}

/** Find all match ranges of `matcher` within `text`. Handles zero-width safely. */
export function findRanges(matcher: RegExp, text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  matcher.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = matcher.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    ranges.push([start, end]);
    if (m[0].length === 0) {
      matcher.lastIndex++; // avoid infinite loop on zero-width matches
    }
  }
  return ranges;
}

/**
 * Apply a replacement across all matches in `text`.
 *
 * When `options.regex` is true, the replacement string supports the standard
 * JS `$1`, `$<name>`, `$&` substitution semantics. Otherwise the replacement is
 * treated as a literal string.
 */
export function applyReplacement(
  matcher: RegExp,
  text: string,
  replacement: string,
  options: SearchOptions
): string {
  matcher.lastIndex = 0;
  if (options.regex) {
    return text.replace(matcher, replacement);
  }
  // Literal replacement: escape $ so it is not interpreted as a group reference.
  const literal = replacement.replace(/\$/g, "$$$$");
  return text.replace(matcher, literal);
}

/** Does `text` contain at least one match? */
export function hasMatch(matcher: RegExp, text: string): boolean {
  matcher.lastIndex = 0;
  return matcher.test(text);
}

export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
