import * as vscode from "vscode";
import { SearchOptions, SearchRequest, SecretMatches } from "../models/search";
import { ConnectionStore } from "../storage/connectionStore";
import { BackupStore } from "../storage/backupStore";
import { Logger, summarizeError } from "../utils/logger";
import { getConfig, VaultServiceFactory } from "../vault/vaultServiceFactory";
import { SearchEngine } from "../search/searchEngine";
import { ReplaceEngine } from "../replace/replaceEngine";
import { VaultFileSystemProvider } from "../editors/vaultFileSystemProvider";
import { getNonce } from "./nonce";

/** Messages sent from the webview to the extension. */
type InMessage =
  | { type: "ready" }
  | { type: "selectConnection"; id: string }
  | { type: "search"; request: WireSearchRequest }
  | { type: "cancel" }
  | { type: "preview"; query: string; replacement: string; options: SearchOptions }
  | { type: "replace"; query: string; replacement: string; options: SearchOptions; mount: string; includedPaths: string[] }
  | { type: "openSecret"; mount: string; secretPath: string }
  | { type: "export"; format: "json" | "csv" };

interface WireSearchRequest {
  query: string;
  replacement: string;
  options: SearchOptions;
  connectionId: string;
  mount: string;
  startPath: string;
}

/**
 * Backs the "Search & Replace" webview. Owns the current search results so that
 * preview, replace, and export operations all act on a consistent snapshot.
 * Contains no matching/IO logic itself — it delegates to the engines.
 */
export class SearchViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "vaultSearch";

  private view?: vscode.WebviewView;
  private cancelSource?: vscode.CancellationTokenSource;
  private currentResults: SecretMatches[] = [];
  private currentRequest?: SearchRequest;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: ConnectionStore,
    private readonly factory: VaultServiceFactory,
    private readonly backups: BackupStore,
    private readonly fsProvider: VaultFileSystemProvider,
    private readonly logger: Logger
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: InMessage) => this.onMessage(msg));
  }

  /** Pre-fill the panel with a scope chosen from the tree, and reveal it. */
  async prime(connectionId: string, mount?: string, startPath?: string): Promise<void> {
    if (this.view) {
      this.view.show?.(true);
    } else {
      await vscode.commands.executeCommand("vaultSearch.focus");
    }
    this.post({ type: "prime", connectionId, mount: mount ?? "", startPath: startPath ?? "" });
    await this.sendConnections();
    if (mount !== undefined) {
      await this.sendMounts(connectionId);
    }
  }

  private post(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  private async onMessage(msg: InMessage): Promise<void> {
    try {
      switch (msg.type) {
        case "ready":
          await this.sendConnections();
          break;
        case "selectConnection":
          await this.sendMounts(msg.id);
          break;
        case "search":
          await this.runSearch(msg.request);
          break;
        case "cancel":
          this.cancelSource?.cancel();
          break;
        case "preview":
          await this.runPreview(msg.query, msg.replacement, msg.options);
          break;
        case "replace":
          await this.runReplace(msg);
          break;
        case "openSecret":
          await this.openSecret(msg.mount, msg.secretPath);
          break;
        case "export":
          await this.exportResults(msg.format);
          break;
      }
    } catch (err) {
      this.logger.errorFrom("SearchView", err);
      this.post({ type: "error", message: summarizeError(err) });
    }
  }

  private async sendConnections(): Promise<void> {
    const conns = this.store.list().map((c) => ({ id: c.id, name: c.name, defaultMount: c.defaultMount }));
    this.post({ type: "connections", connections: conns, defaultConnection: getConfig().defaultConnection });
  }

  private async sendMounts(connectionId: string): Promise<void> {
    if (!connectionId) {
      return;
    }
    try {
      const service = await this.factory.create(connectionId);
      let mounts = await service.listMounts();
      const conn = this.store.get(connectionId);
      if (mounts.length === 0 && conn?.defaultMount) {
        mounts = [conn.defaultMount];
      }
      this.post({ type: "mounts", connectionId, mounts, defaultMount: conn?.defaultMount ?? "" });
    } catch (err) {
      this.post({ type: "error", message: summarizeError(err) });
    }
  }

  private async runSearch(req: WireSearchRequest): Promise<void> {
    if (!req.query) {
      this.post({ type: "error", message: "Enter a search term." });
      return;
    }
    if (!req.connectionId || !req.mount) {
      this.post({ type: "error", message: "Choose a connection and mount." });
      return;
    }
    this.cancelSource?.cancel();
    this.cancelSource = new vscode.CancellationTokenSource();
    const token = this.cancelSource.token;

    const request: SearchRequest = {
      query: req.query,
      options: req.options,
      scope: { connectionId: req.connectionId, mount: req.mount, startPath: req.startPath },
    };
    this.currentRequest = request;
    this.currentResults = [];
    this.post({ type: "searchStarted" });

    try {
      const service = await this.factory.create(req.connectionId);
      const engine = new SearchEngine(service, getConfig().concurrency);
      const results = await engine.search(request, token, {
        onProgress: (p) => this.post({ type: "progress", progress: p }),
        onResult: (r) => this.post({ type: "result", result: r }),
      });
      this.currentResults = results;
      this.post({ type: "searchDone", count: results.length, cancelled: token.isCancellationRequested });
      this.logger.info(
        `Search "${redactQuery(req.query)}" on ${req.mount}: ${results.length} secret(s) matched.`
      );
    } catch (err) {
      this.post({ type: "error", message: summarizeError(err) });
      this.post({ type: "searchDone", count: this.currentResults.length, cancelled: true });
    }
  }

  private async runPreview(query: string, replacement: string, options: SearchOptions): Promise<void> {
    if (!this.currentRequest) {
      return;
    }
    const service = await this.factory.create(this.currentRequest.scope.connectionId);
    const engine = new ReplaceEngine(service);
    const previews = engine.computePreviews(this.currentResults, query, replacement, options);
    this.post({ type: "previews", previews });
  }

  private async runReplace(msg: Extract<InMessage, { type: "replace" }>): Promise<void> {
    if (!this.currentRequest) {
      return;
    }
    const cfg = getConfig();
    if (cfg.readOnly) {
      this.post({ type: "error", message: "Read-only mode is enabled; writes are disabled." });
      return;
    }
    const connectionId = this.currentRequest.scope.connectionId;
    const service = await this.factory.create(connectionId);
    const engine = new ReplaceEngine(service);
    const included = new Set(msg.includedPaths);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Vault: Replacing secrets", cancellable: true },
      async (progress, token) => {
        const report = await engine.applyBatch(
          this.currentResults,
          {
            query: msg.query,
            replacement: msg.replacement,
            options: msg.options,
            mount: msg.mount,
            connectionId,
            includedPaths: included,
            readOnly: cfg.readOnly,
            backup: cfg.backupBeforeReplace,
            onBackup: async (b) => {
              await this.backups.save(b);
            },
          },
          token,
          (p) => {
            progress.report({
              message: `${p.processed}/${p.total} — ${p.currentPath}`,
              increment: (1 / p.total) * 100,
            });
          }
        );
        this.logger.info(
          `Replace complete: ${report.succeeded} succeeded, ${report.skipped} skipped, ${report.failed} failed.`
        );
        this.post({ type: "replaceDone", report });
        const summary = `Replace finished: ${report.succeeded} updated, ${report.skipped} skipped, ${report.failed} failed.`;
        if (report.failed > 0) {
          vscode.window.showWarningMessage(summary, "Show Log").then((s) => s && this.logger.show());
        } else {
          vscode.window.showInformationMessage(summary);
        }
      }
    );
  }

  private async openSecret(mount: string, secretPath: string): Promise<void> {
    if (!this.currentRequest) {
      return;
    }
    const uri = VaultFileSystemProvider.buildUri(this.currentRequest.scope.connectionId, mount, secretPath);
    void this.fsProvider; // provider is registered globally; open via workspace
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(doc, "json");
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  getResults(): SecretMatches[] {
    return this.currentResults;
  }

  private async exportResults(format: "json" | "csv"): Promise<void> {
    if (this.currentResults.length === 0) {
      vscode.window.showInformationMessage("Vault: no search results to export.");
      return;
    }
    const content = format === "json" ? exportJson(this.currentResults) : exportCsv(this.currentResults);
    const doc = await vscode.workspace.openTextDocument({
      content,
      language: format === "json" ? "json" : "csv",
    });
    await vscode.window.showTextDocument(doc);
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "search.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "search.css"));
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Vault Search</title>
</head>
<body>
  <div class="scope">
    <select id="connection" title="Connection"></select>
    <select id="mount" title="Mount"></select>
    <input id="startPath" type="text" placeholder="Starting path (optional)" />
  </div>

  <div class="query-row">
    <input id="query" type="text" placeholder="Search" />
    <div class="options">
      <button data-opt="matchCase" title="Match Case">Aa</button>
      <button data-opt="wholeWord" title="Whole Word">ab|</button>
      <button data-opt="regex" title="Use Regular Expression">.*</button>
    </div>
  </div>

  <div class="query-row">
    <input id="replacement" type="text" placeholder="Replace" />
    <div class="options">
      <button id="previewBtn" title="Preview replacements">Preview</button>
      <button id="replaceBtn" class="primary" title="Replace All">Replace All</button>
    </div>
  </div>

  <div class="scope-opts">
    <label><input type="checkbox" id="searchKeys" checked /> Keys</label>
    <label><input type="checkbox" id="searchValues" checked /> Values</label>
    <span class="spacer"></span>
    <button id="searchBtn" class="primary">Search</button>
    <button id="cancelBtn" hidden>Cancel</button>
  </div>

  <div id="status" class="status"></div>
  <div id="results" class="results"></div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** Keep only length metadata for logs; never log the actual query text verbatim beyond a short prefix. */
function redactQuery(query: string): string {
  return query.length <= 3 ? "***" : `${query.slice(0, 2)}…(${query.length})`;
}

function exportJson(results: SecretMatches[]): string {
  return JSON.stringify(results, null, 2);
}

function exportCsv(results: SecretMatches[]): string {
  const rows: string[] = ["secretPath,key,location,match"];
  for (const group of results) {
    for (const match of group.matches) {
      for (const [start, end] of match.ranges) {
        const excerpt = match.original.slice(start, end);
        rows.push([group.secretPath, match.key, match.location, excerpt].map(csvEscape).join(","));
      }
    }
  }
  return rows.join("\n");
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
