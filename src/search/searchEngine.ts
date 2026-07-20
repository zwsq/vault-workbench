import { SearchMatch, SearchOptions, SearchRequest, SecretMatches } from "../models/search";
import { SecretData } from "../models/secret";
import { CancellationLike, mapConcurrent, throwIfCancelled } from "../utils/concurrency";
import { joinPath } from "../utils/paths";
import { VaultService } from "../vault/vaultService";
import { buildMatcher, findRanges } from "./matcher";

export interface SearchProgress {
  /** Number of secrets discovered so far during enumeration. */
  discovered: number;
  /** Number of secrets read/scanned so far. */
  scanned: number;
  /** Number of secrets with at least one match. */
  matched: number;
}

export interface SearchEngineCallbacks {
  onProgress?: (p: SearchProgress) => void;
  /** Emitted as soon as a secret with matches is found (streaming results). */
  onResult?: (result: SecretMatches) => void;
}

/**
 * Recursively enumerates every secret below a scope and scans keys/values for
 * matches. Enumeration and reads run with bounded concurrency and honor a
 * cancellation token so the UI never freezes.
 */
export class SearchEngine {
  constructor(private readonly service: VaultService, private readonly concurrency: number) {}

  async search(
    request: SearchRequest,
    token: CancellationLike,
    callbacks: SearchEngineCallbacks = {}
  ): Promise<SecretMatches[]> {
    const matcher = buildMatcher(request.query, request.options);
    const progress: SearchProgress = { discovered: 0, scanned: 0, matched: 0 };

    const secretPaths = await this.enumerate(request.scope.mount, request.scope.startPath, token, (count) => {
      progress.discovered = count;
      callbacks.onProgress?.({ ...progress });
    });

    const results: SecretMatches[] = [];
    await mapConcurrent(
      secretPaths,
      this.concurrency,
      async (secretPath) => {
        throwIfCancelled(token);
        const record = await this.service.read(request.scope.mount, secretPath);
        progress.scanned++;
        if (record && !record.deleted) {
          const matches = scanSecret(secretPath, record.data, matcher, request.options);
          if (matches.length > 0) {
            const grouped: SecretMatches = { secretPath, matches };
            results.push(grouped);
            progress.matched++;
            callbacks.onResult?.(grouped);
          }
        }
        callbacks.onProgress?.({ ...progress });
      },
      token
    );

    results.sort((a, b) => a.secretPath.localeCompare(b.secretPath));
    return results;
  }

  /** Depth-first enumeration of all leaf secret paths under `startPath`. */
  async enumerate(
    mount: string,
    startPath: string,
    token: CancellationLike,
    onCount?: (count: number) => void
  ): Promise<string[]> {
    const secrets: string[] = [];
    const queue: string[] = [startPath];

    while (queue.length > 0) {
      throwIfCancelled(token);
      // Process one level with bounded concurrency to keep memory flat.
      const batch = queue.splice(0, this.concurrency);
      const listings = await mapConcurrent(
        batch,
        this.concurrency,
        (folder) => this.service.list(mount, folder),
        token
      );
      for (const settled of listings) {
        if (settled.status !== "fulfilled") {
          continue; // Skip folders we cannot list (e.g. permission denied) but keep going.
        }
        for (const entry of settled.value) {
          if (entry.isFolder) {
            queue.push(entry.path);
          } else {
            secrets.push(entry.path);
          }
        }
      }
      onCount?.(secrets.length);
    }
    return secrets.map((p) => joinPath(p)).sort();
  }
}

/** Scan a single secret's key/value pairs for matches. */
export function scanSecret(
  secretPath: string,
  data: SecretData,
  matcher: RegExp,
  options: SearchOptions
): SearchMatch[] {
  const matches: SearchMatch[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (options.searchKeys) {
      const ranges = findRanges(matcher, key);
      if (ranges.length > 0) {
        matches.push({ secretPath, key, location: "key", original: key, ranges });
      }
    }
    if (options.searchValues) {
      const str = stringifyValue(value);
      const ranges = findRanges(matcher, str);
      if (ranges.length > 0) {
        matches.push({ secretPath, key, location: "value", original: str, ranges });
      }
    }
  }
  return matches;
}

/** Convert a secret value into a searchable string. */
export function stringifyValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
