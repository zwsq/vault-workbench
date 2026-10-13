import * as vscode from "vscode";

/** A secret staged for side-by-side comparison. */
export interface CompareEntry {
  connectionId: string;
  connectionName: string;
  mount: string;
  path: string;
}

const MAX_COMPARE = 2;

/**
 * In-memory bag of up to two secrets selected for comparison.
 * Updates VS Code context keys so title-bar buttons can show/hide.
 */
export class CompareStore {
  private readonly entries: CompareEntry[] = [];

  get size(): number {
    return this.entries.length;
  }

  list(): readonly CompareEntry[] {
    return this.entries;
  }

  keyOf(entry: Pick<CompareEntry, "connectionId" | "mount" | "path">): string {
    return `${entry.connectionId}\0${entry.mount}\0${entry.path}`;
  }

  has(entry: Pick<CompareEntry, "connectionId" | "mount" | "path">): boolean {
    const key = this.keyOf(entry);
    return this.entries.some((e) => this.keyOf(e) === key);
  }

  /**
   * Add a secret. Returns `{ ok: true }` or a reason string.
   * Adding an already-staged secret is a no-op success.
   */
  add(entry: CompareEntry): { ok: true } | { ok: false; reason: string } {
    if (this.has(entry)) {
      return { ok: true };
    }
    if (this.entries.length >= MAX_COMPARE) {
      return { ok: false, reason: `Compare list is full (max ${MAX_COMPARE}). Clear it or remove one first.` };
    }
    this.entries.push(entry);
    this.syncContext();
    return { ok: true };
  }

  remove(entry: Pick<CompareEntry, "connectionId" | "mount" | "path">): boolean {
    const key = this.keyOf(entry);
    const idx = this.entries.findIndex((e) => this.keyOf(e) === key);
    if (idx === -1) {
      return false;
    }
    this.entries.splice(idx, 1);
    this.syncContext();
    return true;
  }

  clear(): void {
    this.entries.length = 0;
    this.syncContext();
  }

  display(entry: CompareEntry): string {
    return `${entry.connectionName}/${entry.mount}/${entry.path}`;
  }

  private syncContext(): void {
    void vscode.commands.executeCommand("setContext", "vault.compareCount", this.entries.length);
    void vscode.commands.executeCommand("setContext", "vault.compareReady", this.entries.length >= 2);
  }
}
