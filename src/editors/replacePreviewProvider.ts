import * as vscode from "vscode";
import { normalizePath } from "../utils/paths";

export const PREVIEW_SCHEME = "vault-preview";

/**
 * Serves read-only "proposed" secret documents for the Replace Preview diff.
 *
 * The proposed text (secret document with the pending replacement applied) is
 * computed on demand by the search view and stashed here, then shown on the
 * right-hand side of a `vscode.diff` against the live secret.
 */
export class ReplacePreviewProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  static buildUri(connectionId: string, mount: string, path: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: PREVIEW_SCHEME,
      authority: connectionId,
      path: `/${normalizePath(mount)}/${normalizePath(path)}.json`,
    });
  }

  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this._onDidChange.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }
}
