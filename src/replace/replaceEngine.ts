import { ReplacePreview, SearchOptions, SecretMatches } from "../models/search";
import { SecretBackup, SecretData } from "../models/secret";
import { CancellationLike, throwIfCancelled } from "../utils/concurrency";
import { ReadOnlyError, VaultError } from "../utils/errors";
import { VaultService } from "../vault/vaultService";
import { applyReplacement, buildMatcher } from "../search/matcher";

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
 * replacements. Reads are always performed fresh at write time so KV v2
 * check-and-set can detect concurrent modifications.
 */
export class ReplaceEngine {
  constructor(private readonly service: VaultService) {}

  /** Compute previews for every match. Nothing is written. */
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
        const after = applyReplacement(matcher, match.original, replacement, options);
        if (after !== match.original) {
          previews.push({
            secretPath: group.secretPath,
            key: match.key,
            location: match.location,
            before: match.original,
            after,
          });
        }
      }
    }
    return previews;
  }

  /**
   * Apply replacements to selected secrets. Continues past individual failures
   * and returns an aggregate report.
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
    const matcher = buildMatcher(opts.query, opts.options);

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

        const { data: newData, changed } = applyToSecret(
          record.data,
          group,
          matcher,
          opts.replacement,
          opts.options
        );
        if (!changed) {
          report.skipped++;
          continue;
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

/** Apply matcher-based replacement to a single secret's data. */
export function applyToSecret(
  data: SecretData,
  group: SecretMatches,
  matcher: RegExp,
  replacement: string,
  options: SearchOptions
): { data: SecretData; changed: boolean } {
  const next: SecretData = { ...data };
  let changed = false;

  for (const match of group.matches) {
    if (match.location === "value" && options.searchValues) {
      const current = next[match.key];
      if (typeof current === "string") {
        const replaced = applyReplacement(matcher, current, replacement, options);
        if (replaced !== current) {
          next[match.key] = replaced;
          changed = true;
        }
      }
    } else if (match.location === "key" && options.searchKeys) {
      const newKey = applyReplacement(matcher, match.key, replacement, options);
      if (newKey !== match.key && !(newKey in next)) {
        next[newKey] = next[match.key];
        delete next[match.key];
        changed = true;
      }
    }
  }
  return { data: next, changed };
}
