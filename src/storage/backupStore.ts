import * as vscode from "vscode";
import { SecretBackup } from "../models/secret";

/**
 * Stores secret backups as JSON files under the extension's local global
 * storage directory (never synced). Each backup captures the full JSON, path,
 * version, and timestamp so it can be restored later.
 */
export class BackupStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private get root(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, "backups");
  }

  async save(backup: SecretBackup): Promise<vscode.Uri> {
    await vscode.workspace.fs.createDirectory(this.root);
    const safe = backup.path.replace(/[^a-zA-Z0-9._-]/g, "_");
    const stamp = backup.timestamp.replace(/[:.]/g, "-");
    const fileName = `${backup.connectionId}__${backup.mount}__${safe}__${stamp}.json`;
    const uri = vscode.Uri.joinPath(this.root, fileName);
    const content = Buffer.from(JSON.stringify(backup, null, 2), "utf8");
    await vscode.workspace.fs.writeFile(uri, content);
    return uri;
  }

  async list(): Promise<vscode.Uri[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.root);
      return entries
        .filter(([name, type]) => type === vscode.FileType.File && name.endsWith(".json"))
        .map(([name]) => vscode.Uri.joinPath(this.root, name));
    } catch {
      return [];
    }
  }

  async read(uri: vscode.Uri): Promise<SecretBackup> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as SecretBackup;
  }
}
