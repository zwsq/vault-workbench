import * as vscode from "vscode";
import { getConfig, VaultServiceFactory } from "../vault/vaultServiceFactory";
import { Logger, summarizeError } from "../utils/logger";
import { ReadOnlyError, VaultError } from "../utils/errors";
import { normalizePath } from "../utils/paths";

export const VAULT_SCHEME = "vault";

interface ParsedUri {
  connectionId: string;
  mount: string;
  path: string;
}

/**
 * Exposes Vault secrets as editable virtual files under the `vault:` scheme so
 * they open and save with the native VS Code editor experience.
 *
 * URI shape: `vault://<connectionId>/<mount>/<secret/path>.json`
 *
 * Read returns formatted JSON. Save parses the JSON, preserves the object shape,
 * and writes back to Vault using a version-aware (check-and-set) write for KV v2.
 */
export class VaultFileSystemProvider implements vscode.FileSystemProvider {
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  /** Tracks the last-read KV v2 version per URI to enable CAS writes. */
  private readonly versions = new Map<string, number | undefined>();
  private readonly sizes = new Map<string, number>();

  constructor(private readonly factory: VaultServiceFactory, private readonly logger: Logger) {}

  static buildUri(connectionId: string, mount: string, path: string): vscode.Uri {
    const clean = normalizePath(path);
    return vscode.Uri.from({
      scheme: VAULT_SCHEME,
      authority: connectionId,
      path: `/${normalizePath(mount)}/${clean}.json`,
    });
  }

  private parse(uri: vscode.Uri): ParsedUri {
    const segments = uri.path.replace(/^\/+/, "").split("/");
    const mount = segments.shift() ?? "";
    let joined = segments.join("/");
    if (joined.endsWith(".json")) {
      joined = joined.slice(0, -".json".length);
    }
    return { connectionId: uri.authority, mount, path: joined };
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: Date.now(),
      size: this.sizes.get(uri.toString()) ?? 0,
    };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    // no-op; folders are implied by secret paths
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { connectionId, mount, path } = this.parse(uri);
    const service = await this.factory.create(connectionId);
    const record = await service.read(mount, path);
    if (!record) {
      this.versions.set(uri.toString(), undefined);
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    this.versions.set(uri.toString(), record.version);
    const text = JSON.stringify(record.data, null, 2) + "\n";
    const bytes = Buffer.from(text, "utf8");
    this.sizes.set(uri.toString(), bytes.length);
    return bytes;
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    _options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    const { connectionId, mount, path } = this.parse(uri);
    const cfg = getConfig();
    if (cfg.readOnly) {
      const err = new ReadOnlyError();
      vscode.window.showErrorMessage(`Vault: ${err.message}`);
      throw vscode.FileSystemError.NoPermissions(err.message);
    }

    const text = Buffer.from(content).toString("utf8").trim() || "{}";
    let data: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Secret must be a JSON object of key/value pairs.");
      }
      data = parsed;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid JSON.";
      vscode.window.showErrorMessage(`Vault: cannot save — ${message}`);
      throw vscode.FileSystemError.NoPermissions(message);
    }

    try {
      const service = await this.factory.create(connectionId);
      const expected = this.versions.get(uri.toString());
      const record = await service.write(mount, path, data, expected);
      this.versions.set(uri.toString(), record.version);
      this.sizes.set(uri.toString(), content.length);
      this.logger.info(`Saved secret ${mount}/${path} (v${record.version ?? "1"}).`);
      this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    } catch (err) {
      this.logger.errorFrom(`Save ${mount}/${path}`, err);
      const message =
        err instanceof VaultError && err.kind === "versionConflict"
          ? "This secret changed in Vault since you opened it. Reopen it to get the latest version, then reapply your edits."
          : summarizeError(err);
      vscode.window.showErrorMessage(`Vault: ${message}`);
      throw vscode.FileSystemError.Unavailable(message);
    }
  }

  async delete(uri: vscode.Uri): Promise<void> {
    const { connectionId, mount, path } = this.parse(uri);
    const service = await this.factory.create(connectionId);
    await service.delete(mount, path);
    this.versions.delete(uri.toString());
    this.sizes.delete(uri.toString());
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions("Renaming Vault secrets is not supported.");
  }
}
