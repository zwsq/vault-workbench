import * as vscode from "vscode";
import { ConnectionStore } from "./storage/connectionStore";
import { BackupStore } from "./storage/backupStore";
import { VaultServiceFactory } from "./vault/vaultServiceFactory";
import { VaultTreeProvider } from "./tree/vaultTreeProvider";
import { SearchViewProvider } from "./ui/searchViewProvider";
import { VaultFileSystemProvider, VAULT_SCHEME } from "./editors/vaultFileSystemProvider";
import { registerCommands } from "./commands/registerCommands";
import { Logger } from "./utils/logger";

/**
 * Composition root. Constructs the layers (storage → services → UI) and wires
 * them together. Keeps all cross-cutting concerns (logging, disposal) in one place.
 */
export function activate(context: vscode.ExtensionContext): void {
  const logger = new Logger("Vault");
  context.subscriptions.push(logger);
  logger.info("Vault Search & Replace activated (fully local, no telemetry).");

  const store = new ConnectionStore(context);
  const factory = new VaultServiceFactory(store);
  const backups = new BackupStore(context);

  const fsProvider = new VaultFileSystemProvider(factory, logger);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(VAULT_SCHEME, fsProvider, { isCaseSensitive: true })
  );

  const treeProvider = new VaultTreeProvider(store, factory, logger);
  const tree = vscode.window.createTreeView("vaultExplorer", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(tree);

  const searchView = new SearchViewProvider(context.extensionUri, store, factory, backups, fsProvider, logger);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SearchViewProvider.viewType, searchView, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  registerCommands({ context, store, factory, treeProvider, searchView, backups, fsProvider, logger });
}

export function deactivate(): void {
  // Disposables are cleaned up via context.subscriptions.
}
