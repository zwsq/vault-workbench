/** User-selectable search options, mirroring VS Code's search panel. */
export interface SearchOptions {
  regex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
  searchKeys: boolean;
  searchValues: boolean;
}

/** Scope describing where to search. */
export interface SearchScope {
  connectionId: string;
  mount: string;
  /** Starting path relative to the mount. Empty string means mount root. */
  startPath: string;
}

/** A full search request. */
export interface SearchRequest {
  query: string;
  options: SearchOptions;
  scope: SearchScope;
}

/**
 * A single match located within the secret's pretty-printed JSON document.
 *
 * Positions refer to the exact text produced by rendering the secret for the
 * editor (`JSON.stringify(data, null, 2) + "\n"`), so they map 1:1 to editor
 * line/character coordinates for reveal + selection.
 */
export interface SearchMatch {
  /** Whether the match falls on a JSON key token or a value. */
  location: "key" | "value";
  /** Absolute character offsets [start, end) within the document text. */
  startOffset: number;
  endOffset: number;
  /** Zero-based start position. */
  startLine: number;
  startChar: number;
  /** Zero-based end position (exclusive). */
  endLine: number;
  endChar: number;
  /** Text of the start line (without trailing newline) for previewing. */
  lineText: string;
  /** Highlight range within `lineText` (end clamped to line length for multi-line). */
  lineMatchStart: number;
  lineMatchEnd: number;
  /** The exact matched substring (may span multiple lines). */
  matchText: string;
}

/** Matches grouped by secret path. */
export interface SecretMatches {
  secretPath: string;
  matches: SearchMatch[];
}

/** A preview of a single planned replacement. */
export interface ReplacePreview {
  secretPath: string;
  startLine: number;
  location: "key" | "value";
  before: string;
  after: string;
}
