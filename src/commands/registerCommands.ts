import * as vscode from "vscode";
import { ConnectionStore } from "../storage/connectionStore";
import { BackupStore } from "../storage/backupStore";
import { VaultServiceFactory, getConfig } from "../vault/vaultServiceFactory";
import { VaultTreeProvider, VaultNode } from "../tree/vaultTreeProvider";
import { SearchViewProvider } from "../ui/searchViewProvider";
import { VaultFileSystemProvider } from "../editors/vaultFileSystemProvider";
import { Logger, summarizeError } from "../utils/logger";
import { promptConnection, promptToken } from "../ui/connectionInput";
import { joinPath } from "../utils/paths";

export interface CommandDeps {
  context: vscode.ExtensionContext;
  store: ConnectionStore;
  factory: VaultServiceFactory;
  treeProvider: VaultTreeProvider;
  searchView: SearchViewProvider;
  backups: BackupStore;
  fsProvider: VaultFileSystemProvider;
  logger: Logger;
}

/** Register all extension commands and push their disposables onto the context. */
export function registerCommands(deps: CommandDeps): void {
  const { context, store, treeProvider, searchView, backups, logger } = deps;

  const reg = (id: string, handler: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, wrap(id, handler, logger)));

  reg("vault.addConnection", async () => {
    const conn = await promptConnection();
    if (!conn) {
      return;
    }
    await store.upsert(conn);
    const token = await promptToken(conn.name);
    if (token) {
      await store.setToken(conn.id, token);
    }
    treeProvider.refresh();
    logger.info(`Added connection "${conn.name}".`);
  });

  reg("vault.editConnection", async (node?: VaultNode) => {
    const conn = await pickConnection(store, node?.connectionId, "Edit which connection?");
    if (!conn) {
      return;
    }
    const updated = await promptConnection(conn);
    if (!updated) {
      return;
    }
    await store.upsert(updated);
    treeProvider.refresh();
    logger.info(`Updated connection "${updated.name}".`);
  });

  reg("vault.deleteConnection", async (node?: VaultNode) => {
    const conn = await pickConnection(store, node?.connectionId, "Delete which connection?");
    if (!conn) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Delete connection "${conn.name}"? Its stored token will also be removed.`,
      { modal: true },
      "Delete"
    );
    if (confirm !== "Delete") {
      return;
    }
    await store.remove(conn.id);
    treeProvider.refresh();
    logger.info(`Deleted connection "${conn.name}".`);
  });

  reg("vault.setToken", async (node?: VaultNode) => {
    const conn = await pickConnection(store, node?.connectionId, "Set token for which connection?");
    if (!conn) {
      return;
    }
    const token = await promptToken(conn.name);
    if (token === undefined) {
      return;
    }
    await store.setToken(conn.id, token);
    treeProvider.refresh();
    logger.info(`Token updated for "${conn.name}".`);
    vscode.window.showInformationMessage(`Vault: token saved for "${conn.name}".`);
  });

  reg("vault.refresh", () => treeProvider.refresh());

  reg("vault.openSecret", async (node?: VaultNode) => {
    if (!node || node.kind !== "secret" || !node.mount || node.path === undefined) {
      return;
    }
    const uri = VaultFileSystemProvider.buildUri(node.connectionId, node.mount, node.path);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(doc, "json");
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  reg("vault.newSecret", async (node?: VaultNode) => {
    if (!node || !node.mount) {
      return;
    }
    if (getConfig().readOnly) {
      vscode.window.showWarningMessage("Vault: read-only mode is enabled.");
      return;
    }
    const base = node.kind === "folder" ? node.path ?? "" : "";
    const rel = await vscode.window.showInputBox({
      title: "New Secret Path",
      prompt: `Path under ${node.mount}${base ? "/" + base : ""}`,
      validateInput: (v) => (v.trim().length === 0 ? "Path is required." : undefined),
    });
    if (!rel) {
      return;
    }
    const fullPath = joinPath(base, rel);
    const uri = VaultFileSystemProvider.buildUri(node.connectionId, node.mount, fullPath);
    const doc = await vscode.workspace.openTextDocument(uri).then(
      (d) => d,
      async () => {
        // File does not exist yet; open an untitled-like editing session by writing later.
        return vscode.workspace.openTextDocument({ language: "json", content: "{\n  \n}\n" });
      }
    );
    await vscode.languages.setTextDocumentLanguage(doc, "json");
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(
      `Vault: edit the JSON and save to create ${node.mount}/${fullPath}. (Use "Save As" to the vault path if needed.)`
    );
  });

  reg("vault.deleteSecret", async (node?: VaultNode) => {
    if (!node || node.kind !== "secret" || !node.mount || node.path === undefined) {
      return;
    }
    if (getConfig().readOnly) {
      vscode.window.showWarningMessage("Vault: read-only mode is enabled.");
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Delete secret "${node.mount}/${node.path}"?`,
      { modal: true },
      "Delete"
    );
    if (confirm !== "Delete") {
      return;
    }
    const service = await deps.factory.create(node.connectionId);
    await service.delete(node.mount, node.path);
    treeProvider.refresh();
    logger.info(`Deleted secret ${node.mount}/${node.path}.`);
  });

  reg("vault.copyPath", async (node?: VaultNode) => {
    if (!node?.path) {
      return;
    }
    await vscode.env.clipboard.writeText(node.mount ? `${node.mount}/${node.path}` : node.path);
  });

  reg("vault.searchHere", async (node?: VaultNode) => {
    if (!node) {
      return;
    }
    await searchView.prime(node.connectionId, node.mount, node.kind === "folder" ? node.path : "");
  });

  reg("vault.focusSearch", async () => {
    await vscode.commands.executeCommand("vaultSearch.focus");
  });

  reg("vault.exportResultsJson", () => searchView.exportResults("json"));
  reg("vault.exportResultsCsv", () => searchView.exportResults("csv"));

  reg("vault.showLog", () => logger.show());

  reg("vault.restoreBackup", async () => {
    const files = await backups.list();
    if (files.length === 0) {
      vscode.window.showInformationMessage("Vault: no backups found.");
      return;
    }
    const items = await Promise.all(
      files.map(async (uri) => {
        const b = await backups.read(uri);
        return {
          label: `${b.mount}/${b.path}`,
          description: `${b.timestamp}${b.version ? ` (v${b.version})` : ""}`,
          uri,
          backup: b,
        };
      })
    );
    const pick = await vscode.window.showQuickPick(items, { title: "Restore which backup?" });
    if (!pick) {
      return;
    }
    if (getConfig().readOnly) {
      vscode.window.showWarningMessage("Vault: read-only mode is enabled.");
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Restore "${pick.label}" from backup taken ${pick.backup.timestamp}? This overwrites the current secret.`,
      { modal: true },
      "Restore"
    );
    if (confirm !== "Restore") {
      return;
    }
    const service = await deps.factory.create(pick.backup.connectionId);
    await service.write(pick.backup.mount, pick.backup.path, pick.backup.data);
    logger.info(`Restored ${pick.label} from backup.`);
    vscode.window.showInformationMessage(`Vault: restored ${pick.label}.`);
    treeProvider.refresh();
  });
}

async function pickConnection(store: ConnectionStore, preferId: string | undefined, title: string) {
  if (preferId) {
    const c = store.get(preferId);
    if (c) {
      return c;
    }
  }
  const conns = store.list();
  if (conns.length === 0) {
    vscode.window.showInformationMessage("Vault: no connections. Add one first.");
    return undefined;
  }
  if (conns.length === 1) {
    return conns[0];
  }
  const pick = await vscode.window.showQuickPick(
    conns.map((c) => ({ label: c.name, description: c.url, id: c.id })),
    { title }
  );
  return pick ? store.get(pick.id) : undefined;
}

/** Wrap a command handler with uniform error reporting. */
function wrap(id: string, handler: (...args: any[]) => any, logger: Logger) {
  return async (...args: any[]) => {
    try {
      return await handler(...args);
    } catch (err) {
      logger.errorFrom(id, err);
      vscode.window.showErrorMessage(`Vault: ${summarizeError(err)}`);
    }
  };
}
