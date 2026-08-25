import * as vscode from "vscode";
import { SearchOptions, SearchRequest, SecretMatches } from "../models/search";
import { ConnectionStore } from "../storage/connectionStore";
import { BackupStore } from "../storage/backupStore";
import { Logger, summarizeError } from "../utils/logger";
import { getConfig, VaultServiceFactory } from "../vault/vaultServiceFactory";
import { SearchEngine } from "../search/searchEngine";
import { ReplaceEngine, applyMatchesToDocument } from "../replace/replaceEngine";
import { VaultFileSystemProvider } from "../editors/vaultFileSystemProvider";
import { ReplacePreviewProvider } from "../editors/replacePreviewProvider";
import { buildMatcher } from "../search/matcher";
import { renderSecretDocument, scanDocument } from "../search/document";
import { getNonce } from "./nonce";

/** Messages sent from the webview to the extension. */
type InMessage =
  | { type: "ready" }
  | { type: "selectConnection"; id: string }
  | { type: "search"; request: WireSearchRequest }
  | { type: "cancel" }
  | { type: "replace"; query: string; replacement: string; options: SearchOptions; mount: string; includedPaths: string[] }
  | { type: "openSecret"; mount: string; secretPath: string; selection?: MatchSelection; replacement?: string }
  | { type: "export"; format: "json" | "csv" };

interface MatchSelection {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

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
    private readonly previewProvider: ReplacePreviewProvider,
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
    // Refresh lists with the tree-selected connection preferred, then apply
    // prime last so startPath/mount win over defaults.
    await this.sendConnections(connectionId);
    if (connectionId) {
      await this.sendMounts(connectionId, mount);
    }
    this.post({ type: "prime", connectionId, mount: mount ?? "", startPath: startPath ?? "" });
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
        case "replace":
          await this.runReplace(msg);
          break;
        case "openSecret":
          await this.openSecret(msg.mount, msg.secretPath, msg.selection, msg.replacement);
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

  private async sendConnections(preferredId?: string): Promise<void> {
    const conns = this.store.list().map((c) => ({ id: c.id, name: c.name, defaultMount: c.defaultMount }));
    this.post({
      type: "connections",
      connections: conns,
      defaultConnection: getConfig().defaultConnection,
      preferredId: preferredId ?? "",
    });
  }

  private async sendMounts(connectionId: string, preferredMount?: string): Promise<void> {
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
      this.post({
        type: "mounts",
        connectionId,
        mounts,
        defaultMount: preferredMount || conn?.defaultMount || "",
      });
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

  private async runReplace(msg: Extract<InMessage, { type: "replace" }>): Promise<void> {
    if (!this.currentRequest) {
      return;
    }
    const cfg = getConfig();
    if (cfg.readOnly) {
      this.post({ type: "error", message: "Read-only mode is enabled; writes are disabled." });
      return;
    }

    // Nothing is written before this explicit confirmation.
    const count = msg.includedPaths.length;
    if (count === 0) {
      this.post({ type: "error", message: "Select at least one secret to replace." });
      return;
    }
    const backupNote = cfg.backupBeforeReplace ? " A backup of each secret is saved first." : "";
    const isDeletion = msg.replacement.length === 0;

    if (isDeletion) {
      // Deleting matched text is destructive; require a two-step confirmation.
      const first = await vscode.window.showWarningMessage(
        `Delete the matched text in ${count} secret(s)?`,
        {
          modal: true,
          detail: "The replacement is empty, so every match will be removed (replace-with-nothing).",
        },
        "Continue"
      );
      if (first !== "Continue") {
        return;
      }
      const second = await vscode.window.showWarningMessage(
        `Confirm: permanently modify ${count} secret(s) in Vault?`,
        { modal: true, detail: `This cannot be undone.${backupNote}` },
        "Delete Matched Text"
      );
      if (second !== "Delete Matched Text") {
        return;
      }
    } else {
      const confirm = await vscode.window.showWarningMessage(
        `Replace matches in ${count} secret(s)?`,
        { modal: true, detail: `This writes changes back to Vault. Review the inline diffs before confirming.${backupNote}` },
        "Replace"
      );
      if (confirm !== "Replace") {
        return;
      }
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

  private async openSecret(
    mount: string,
    secretPath: string,
    selection?: MatchSelection,
    replacement?: string
  ): Promise<void> {
    if (!this.currentRequest) {
      return;
    }
    const connectionId = this.currentRequest.scope.connectionId;
    const uri = VaultFileSystemProvider.buildUri(connectionId, mount, secretPath);
    void this.fsProvider; // provider is registered globally; open via workspace

    // With a replacement present, show a live diff (current vs proposed) so the
    // change is visible in an editor before anything is written.
    if (replacement && replacement.length > 0) {
      const opened = await this.openReplaceDiff(connectionId, mount, secretPath, uri, replacement);
      if (opened) {
        return;
      }
    }

    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(doc, "json");
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    if (selection) {
      const range = new vscode.Range(
        selection.startLine,
        selection.startChar,
        selection.endLine,
        selection.endChar
      );
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  /** Open a diff of the secret's current content vs the proposed replacement. */
  private async openReplaceDiff(
    connectionId: string,
    mount: string,
    secretPath: string,
    originalUri: vscode.Uri,
    replacement: string
  ): Promise<boolean> {
    if (!this.currentRequest) {
      return false;
    }
    const service = await this.factory.create(connectionId);
    const record = await service.read(mount, secretPath);
    if (!record) {
      return false;
    }
    const document = renderSecretDocument(record.data);
    const matcher = buildMatcher(this.currentRequest.query, this.currentRequest.options);
    const matches = scanDocument(document, matcher, this.currentRequest.options);
    const proposed = applyMatchesToDocument(document, matches, matcher, replacement, this.currentRequest.options);
    if (proposed === document) {
      return false; // nothing would change; fall back to plain open
    }
    const previewUri = ReplacePreviewProvider.buildUri(connectionId, mount, secretPath);
    this.previewProvider.set(previewUri, proposed);
    await vscode.commands.executeCommand(
      "vscode.diff",
      originalUri,
      previewUri,
      `${secretPath} — Replace Preview (right is proposed)`,
      { preview: true }
    );
    return true;
  }

  getResults(): SecretMatches[] {
    return this.currentResults;
  }

  async exportResults(format: "json" | "csv"): Promise<void> {
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
  <title>Vault Workbench</title>
</head>
<body>
  <div class="scope">
    <select id="connection" title="Connection"></select>
  </div>
  <div class="scope">
    <select id="mount" title="Mount"></select>
  </div>
  <div class="scope">
    <input id="startPath" type="text" placeholder="Starting path (optional)" />
  </div>

  <div class="find-input">
    <textarea id="query" rows="1" placeholder="Search"></textarea>
    <div class="find-actions">
      <button type="button" data-opt="matchCase" class="icon-btn" title="Match Case (Aa)" aria-label="Match Case">Aa</button>
      <button type="button" data-opt="wholeWord" class="icon-btn" title="Match Whole Word" aria-label="Match Whole Word">ab|</button>
      <button type="button" data-opt="regex" class="icon-btn" title="Use Regular Expression" aria-label="Use Regular Expression">.*</button>
      <button type="button" id="searchBtn" class="icon-btn action" title="Search (Ctrl+Enter)" aria-label="Search">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zm-.82 4.74a6 6 0 1 1 1.06-1.06l2.79 2.79a.75.75 0 1 1-1.06 1.06l-2.79-2.79z"/></svg>
      </button>
      <button type="button" id="cancelBtn" class="icon-btn action" title="Cancel" aria-label="Cancel" hidden>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 8.707l3.646 3.647.708-.708L8.707 8l3.647-3.646-.708-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z"/></svg>
      </button>
    </div>
  </div>

  <div class="find-input">
    <textarea id="replacement" rows="1" placeholder="Replace"></textarea>
    <div class="find-actions">
      <button type="button" id="replaceBtn" class="icon-btn action" title="Replace All" aria-label="Replace All">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2.5 3.5h7.793L8.146 1.354l.708-.708L12.207 4l-3.353 3.354-.708-.708L10.293 4.5H2.5a2 2 0 0 0-2 2v2h1v-2a1 1 0 0 1 1-1zm11 9H5.707l2.147 2.146-.708.708L3.793 12l3.353-3.354.708.708L5.707 11.5H13.5a2 2 0 0 0 2-2v-2h-1v2a1 1 0 0 1-1 1z"/></svg>
      </button>
    </div>
  </div>

  <div class="scope-opts">
    <label><input type="checkbox" id="searchKeys" checked /> Keys</label>
    <label><input type="checkbox" id="searchValues" checked /> Values</label>
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
  const rows: string[] = ["secretPath,line,location,match"];
  for (const group of results) {
    for (const match of group.matches) {
      rows.push(
        [group.secretPath, String(match.startLine + 1), match.location, match.matchText]
          .map(csvEscape)
          .join(",")
      );
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
