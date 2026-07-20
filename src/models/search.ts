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

/** A single match inside one key/value pair of a secret. */
export interface SearchMatch {
  /** Path of the secret relative to the mount. */
  secretPath: string;
  /** The key within the secret where the match was found. */
  key: string;
  /** Whether the match occurred in the key name or the value. */
  location: "key" | "value";
  /** The full original string that was searched (key name or stringified value). */
  original: string;
  /** Character ranges [start, end) within `original` that matched. */
  ranges: Array<[number, number]>;
}

/** Matches grouped by secret path. */
export interface SecretMatches {
  secretPath: string;
  matches: SearchMatch[];
}

/** A preview of a single planned replacement in one key. */
export interface ReplacePreview {
  secretPath: string;
  key: string;
  location: "key" | "value";
  before: string;
  after: string;
}
