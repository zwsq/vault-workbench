import { ReplacePreview, SearchOptions, SecretMatches } from "../models/search";
import { SecretBackup, SecretData } from "../models/secret";
import { CancellationLike, throwIfCancelled } from "../utils/concurrency";
import { ReadOnlyError, VaultError } from "../utils/errors";
import { VaultService } from "../vault/vaultService";
import { applyReplacement, buildMatcher } from "../search/matcher";
import { renderSecretDocument, scanDocument } from "../search/document";

export interface ReplaceReport {
  succeeded: number;
  skipped: number;
  failed: number;
  failures: Array<{ secretPath: string; message: string }>;
}

export interface BatchReplaceOptions {
  query: string;
  replacement: string;
  options: SearchOptions;
  mount: string;
  connectionId: string;
  /** Secret paths the user chose to include (subset of results). */
  includedPaths: Set<string>;
  readOnly: boolean;
  backup: boolean;
  /** Called before each write with the pre-modification snapshot. */
  onBackup?: (backup: SecretBackup) => Promise<void>;
}

export interface BatchProgress {
  processed: number;
  total: number;
  currentPath: string;
}

/**
 * Generates non-destructive replacement previews and applies confirmed batch
 * replacements.
 *
 * Replacement is performed on the secret's rendered JSON document (the exact
 * text shown in the editor): matched ranges are spliced with their replacement
 * and the result is re-parsed as JSON. This naturally supports value edits, key
 * renames, and multi-line/nested changes, and guarantees the write reflects
 * precisely what the user saw. Reads happen fresh at write time so KV v2
 * check-and-set can detect concurrent modifications.
 */
export class ReplaceEngine {
  constructor(private readonly service: VaultService) {}

  /** Compute per-match previews from the already-found matches. Nothing is written. */
  computePreviews(
    results: SecretMatches[],
    query: string,
    replacement: string,
    options: SearchOptions
  ): ReplacePreview[] {
    const matcher = buildMatcher(query, options);
    const previews: ReplacePreview[] = [];
    for (const group of results) {
      for (const match of group.matches) {
        const after = applyReplacement(matcher, match.matchText, replacement, options);
        if (after !== match.matchText) {
          previews.push({
            secretPath: group.secretPath,
            startLine: match.startLine,
            location: match.location,
            before: match.matchText,
            after,
          });
        }
      }
    }
    return previews;
  }

  /**
   * Apply replacements to selected secrets. Re-reads and re-scans each secret at
   * write time, continues past individual failures, and returns an aggregate
   * report.
   */
  async applyBatch(
    results: SecretMatches[],
    opts: BatchReplaceOptions,
    token: CancellationLike,
    onProgress?: (p: BatchProgress) => void
  ): Promise<ReplaceReport> {
    if (opts.readOnly) {
      throw new ReadOnlyError();
    }
    const report: ReplaceReport = { succeeded: 0, skipped: 0, failed: 0, failures: [] };
    const targets = results.filter((r) => opts.includedPaths.has(r.secretPath));
    let processed = 0;

    for (const group of targets) {
      throwIfCancelled(token);
      processed++;
      onProgress?.({ processed, total: targets.length, currentPath: group.secretPath });
      try {
        const record = await this.service.read(opts.mount, group.secretPath);
        if (!record || record.deleted) {
          report.skipped++;
          continue;
        }

        const document = renderSecretDocument(record.data);
        const matcher = buildMatcher(opts.query, opts.options);
        const matches = scanDocument(document, matcher, opts.options);
        if (matches.length === 0) {
          report.skipped++;
          continue;
        }

        const nextText = applyMatchesToDocument(document, matches, matcher, opts.replacement, opts.options);
        if (nextText === document) {
          report.skipped++;
          continue;
        }

        let newData: SecretData;
        try {
          const parsed = JSON.parse(nextText);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("not an object");
          }
          newData = parsed;
        } catch {
          report.failed++;
          report.failures.push({
            secretPath: group.secretPath,
            message: "Replacement produced invalid JSON; skipped for safety.",
          });
          continue;
        }

        if (opts.backup && opts.onBackup) {
          await opts.onBackup({
            connectionId: opts.connectionId,
            mount: opts.mount,
            path: group.secretPath,
            kvVersion: record.kvVersion,
            version: record.version,
            timestamp: new Date().toISOString(),
            data: record.data,
          });
        }

        await this.service.write(opts.mount, group.secretPath, newData, record.version);
        report.succeeded++;
      } catch (err) {
        report.failed++;
        report.failures.push({
          secretPath: group.secretPath,
          message: err instanceof VaultError ? err.message : "Unexpected error",
        });
      }
    }
    return report;
  }
}

/**
 * Splice replacements into a document at each match's range, working from the
 * last match to the first so earlier offsets remain valid.
 */
export function applyMatchesToDocument(
  document: string,
  matches: Array<{ startOffset: number; endOffset: number }>,
  matcher: RegExp,
  replacement: string,
  options: SearchOptions
): string {
  const ordered = [...matches].sort((a, b) => b.startOffset - a.startOffset);
  let text = document;
  for (const m of ordered) {
    const matched = text.slice(m.startOffset, m.endOffset);
    const replaced = applyReplacement(matcher, matched, replacement, options);
    if (replaced !== matched) {
      text = text.slice(0, m.startOffset) + replaced + text.slice(m.endOffset);
    }
  }
  return text;
}
