import * as vscode from "vscode";
import AdmZip = require("adm-zip");
import { ConnectionStore } from "../storage/connectionStore";
import { BackupStore } from "../storage/backupStore";
import { CompareStore } from "../storage/compareStore";
import { VaultServiceFactory, getConfig } from "../vault/vaultServiceFactory";
import { VaultTreeProvider, VaultNode } from "../tree/vaultTreeProvider";
import { SearchViewProvider } from "../ui/searchViewProvider";
import { VaultFileSystemProvider } from "../editors/vaultFileSystemProvider";
import { Logger, summarizeError } from "../utils/logger";
import {
  isAuthError,
  offerReauthOnError,
  promptConnection,
  promptNewConnection,
  reauthenticateWithVaultUi,
  uuid,
} from "../ui/connectionInput";
import { VaultConnection } from "../models/connection";
import { joinPath } from "../utils/paths";

export interface CommandDeps {
  context: vscode.ExtensionContext;
  store: ConnectionStore;
  factory: VaultServiceFactory;
  treeProvider: VaultTreeProvider;
  searchView: SearchViewProvider;
  backups: BackupStore;
  fsProvider: VaultFileSystemProvider;
  compareStore: CompareStore;
  logger: Logger;
}

/** Register all extension commands and push their disposables onto the context. */
export function registerCommands(deps: CommandDeps): void {
  const { context, store, treeProvider, searchView, backups, compareStore, logger } = deps;

  const reg = (id: string, handler: (...args: any[]) => any) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, wrap(id, handler, logger, store, treeProvider))
    );

  reg("vault.addConnection", async (node?: VaultNode) => {
    const result = await promptNewConnection();
    if (!result) {
      return;
    }
    const { connection: conn, token } = result;
    if (node?.kind === "group" && node.groupId) {
      conn.groupId = node.groupId;
    }
    await store.upsert(conn);
    await store.setToken(conn.id, token);
    treeProvider.refresh();
    logger.info(`Added connection "${conn.name}".`);
  });

  reg("vault.addGroup", async () => {
    const name = await vscode.window.showInputBox({
      title: "New Connection Group",
      prompt: "Name for the group (e.g. Production, Staging)",
      validateInput: (v) => (v.trim().length === 0 ? "Name is required." : undefined),
    });
    if (!name) {
      return;
    }
    const trimmed = name.trim();
    if (store.listGroups().some((g) => g.name.toLowerCase() === trimmed.toLowerCase())) {
      vscode.window.showErrorMessage(`A group named "${trimmed}" already exists.`);
      return;
    }
    await store.upsertGroup({ id: uuid(), name: trimmed, sortOrder: store.listGroups().length });
    treeProvider.refresh();
    logger.info(`Added connection group "${trimmed}".`);
  });

  reg("vault.renameGroup", async (node?: VaultNode) => {
    if (!node || node.kind !== "group" || !node.groupId) {
      return;
    }
    const group = store.getGroup(node.groupId);
    if (!group) {
      return;
    }
    const name = await vscode.window.showInputBox({
      title: "Rename Group",
      prompt: "New group name",
      value: group.name,
      validateInput: (v) => {
        const trimmed = v.trim();
        if (!trimmed) {
          return "Name is required.";
        }
        if (
          store
            .listGroups()
            .some((g) => g.id !== group.id && g.name.toLowerCase() === trimmed.toLowerCase())
        ) {
          return "Another group already uses this name.";
        }
        return undefined;
      },
    });
    if (!name) {
      return;
    }
    await store.upsertGroup({ ...group, name: name.trim() });
    treeProvider.refresh();
    logger.info(`Renamed group to "${name.trim()}".`);
  });

  reg("vault.deleteGroup", async (node?: VaultNode) => {
    if (!node || node.kind !== "group" || !node.groupId) {
      return;
    }
    const group = store.getGroup(node.groupId);
    if (!group) {
      return;
    }
    const count = store.listInGroup(group.id).length;
    const confirm = await vscode.window.showWarningMessage(
      count > 0
        ? `Delete group "${group.name}"? Its ${count} connection(s) will become ungrouped (not deleted).`
        : `Delete group "${group.name}"?`,
      { modal: true },
      "Delete"
    );
    if (confirm !== "Delete") {
      return;
    }
    await store.removeGroup(group.id);
    treeProvider.refresh();
    logger.info(`Deleted connection group "${group.name}".`);
  });

  reg("vault.moveConnectionToGroup", async (node?: VaultNode) => {
    if (!node || node.kind !== "connection" || !node.connectionId) {
      return;
    }
    const groups = store.listGroups();
    const picks: Array<{ label: string; groupId: string | undefined }> = [
      { label: "$(root-folder) Ungrouped", groupId: undefined },
      ...groups.map((g) => ({ label: `$(folder-library) ${g.name}`, groupId: g.id })),
    ];
    const pick = await vscode.window.showQuickPick(picks, {
      title: "Move Connection to Group",
      placeHolder: node.label,
    });
    if (!pick) {
      return;
    }
    await store.setConnectionGroup(node.connectionId, pick.groupId);
    treeProvider.refresh();
  });

  reg("vault.moveUp", async (node?: VaultNode) => {
    if (!node) {
      return;
    }
    if (node.kind === "connection" && node.connectionId) {
      await store.shiftConnection(node.connectionId, -1);
    } else if (node.kind === "group" && node.groupId) {
      await store.shiftGroup(node.groupId, -1);
    } else {
      return;
    }
    treeProvider.refresh();
  });

  reg("vault.moveDown", async (node?: VaultNode) => {
    if (!node) {
      return;
    }
    if (node.kind === "connection" && node.connectionId) {
      await store.shiftConnection(node.connectionId, 1);
    } else if (node.kind === "group" && node.groupId) {
      await store.shiftGroup(node.groupId, 1);
    } else {
      return;
    }
    treeProvider.refresh();
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
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: "Open Vault UI and paste token",
          detail: "Opens the Vault login page in your browser, then asks you to paste the new token",
          openBrowser: true,
        },
        {
          label: "Paste token only",
          detail: "Enter a token without opening the browser",
          openBrowser: false,
        },
      ],
      { title: `Set Token — ${conn.name}`, ignoreFocusOut: true }
    );
    if (!pick) {
      return;
    }
    const token = await reauthenticateWithVaultUi(conn, { openBrowser: pick.openBrowser });
    if (token === undefined) {
      return;
    }
    await store.setToken(conn.id, token);
    treeProvider.refresh();
    logger.info(`Token updated for "${conn.name}".`);
    vscode.window.showInformationMessage(`Vault: token saved for "${conn.name}".`);
  });

  reg("vault.refresh", (node?: VaultNode) => treeProvider.refresh(node));

  reg("vault.openSecret", async (node?: VaultNode) => {
    if (!node || node.kind !== "secret" || !node.mount || node.path === undefined) {
      return;
    }
    const connName = store.get(node.connectionId)?.name;
    const uri = VaultFileSystemProvider.buildUri(node.connectionId, node.mount, node.path, connName);
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
    const connName = store.get(node.connectionId)?.name;
    const uri = VaultFileSystemProvider.buildUri(node.connectionId, node.mount, fullPath, connName);
    let isNew = false;
    try {
      await deps.fsProvider.readFile(uri);
    } catch {
      // Secret doesn't exist yet — write a placeholder directly via the provider
      // (bypasses vscode.workspace.fs which tries to mkdir parents and fails).
      const placeholder = Buffer.from('{\n  "key": "value"\n}\n', "utf8");
      await deps.fsProvider.writeFile(uri, placeholder, { create: true, overwrite: true });
      isNew = true;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(doc, "json");
    await vscode.window.showTextDocument(doc);
    if (isNew) {
      treeProvider.refresh();
      vscode.window.showInformationMessage(
        `Edit the JSON and save to create ${node.mount}/${fullPath}.`
      );
    }
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

  reg("vault.deletePath", async (node?: VaultNode) => {
    if (!node || !node.mount || (node.kind !== "secret" && node.kind !== "folder")) {
      return;
    }
    if (getConfig().readOnly) {
      vscode.window.showWarningMessage("Vault: read-only mode is enabled.");
      return;
    }

    const displayPath = `${node.mount}/${node.path ?? ""}`;
    const isFolder = node.kind === "folder";
    const label = isFolder ? "folder and all secrets under it" : "secret";

    const first = await vscode.window.showWarningMessage(
      `Are you sure you want to delete the ${label} "${displayPath}"?${isFolder ? " This will recursively delete ALL secrets in this path." : ""}`,
      { modal: true },
      "Delete"
    );
    if (first !== "Delete") {
      return;
    }

    if (isFolder) {
      const typed = await vscode.window.showInputBox({
        title: "Confirm Recursive Delete",
        prompt: `Type "${node.path}" to confirm permanent deletion of all secrets under this path`,
        validateInput: (v) => v === node.path ? undefined : "Input does not match the path.",
      });
      if (typed === undefined) {
        return;
      }
    }

    const service = await deps.factory.create(node.connectionId);
    let deleted = 0;

    async function deleteRecursive(mount: string, path: string): Promise<void> {
      const entries = await service.list(mount, path);
      for (const entry of entries) {
        if (entry.isFolder) {
          await deleteRecursive(mount, entry.path);
        } else {
          await service.delete(mount, entry.path);
          deleted++;
        }
      }
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Deleting ${displayPath}…`,
        cancellable: false,
      },
      async () => {
        if (isFolder) {
          await deleteRecursive(node.mount!, node.path ?? "");
        } else {
          await service.delete(node.mount!, node.path!);
          deleted = 1;
        }
      }
    );

    treeProvider.refresh();
    logger.info(`Deleted ${deleted} secret(s) under ${displayPath}.`);
    vscode.window.showInformationMessage(`Deleted ${deleted} secret(s) from "${displayPath}".`);
  });

  reg("vault.renamePath", async (node?: VaultNode) => {
    if (!node || !node.mount || !node.path || (node.kind !== "secret" && node.kind !== "folder")) {
      return;
    }
    if (getConfig().readOnly) {
      vscode.window.showWarningMessage("Vault: read-only mode is enabled.");
      return;
    }

    const service = await deps.factory.create(node.connectionId);
    const isFolder = node.kind === "folder";
    const parentPath = node.path.includes("/")
      ? node.path.slice(0, node.path.lastIndexOf("/"))
      : "";

    const newName = await vscode.window.showInputBox({
      title: isFolder ? "Rename Folder" : "Rename Secret",
      prompt: `Enter the new name for "${node.label}"`,
      value: node.label,
      validateInput: (v) => {
        const trimmed = v.trim();
        if (!trimmed) { return "Name is required."; }
        if (trimmed.includes("/")) { return "Name must not contain '/'."; }
        if (trimmed === node!.label) { return "Name is unchanged."; }
        return undefined;
      },
    });
    if (!newName) {
      return;
    }

    const newPath = parentPath ? joinPath(parentPath, newName.trim()) : newName.trim();

    // Check that the target doesn't already exist
    if (isFolder) {
      const siblings = await service.list(node.mount, parentPath);
      if (siblings.some((e) => e.isFolder && e.name === newName.trim())) {
        vscode.window.showErrorMessage(`A folder named "${newName.trim()}" already exists in this path.`);
        return;
      }
    } else {
      const existing = await service.read(node.mount, newPath);
      if (existing) {
        vscode.window.showErrorMessage(`A secret named "${newName.trim()}" already exists in this path.`);
        return;
      }
    }

    if (isFolder) {
      const confirm = await vscode.window.showWarningMessage(
        `Renaming a folder will copy all secrets to the new path and delete the originals. Version history for all secrets will be lost. Continue?`,
        { modal: true },
        "Rename"
      );
      if (confirm !== "Rename") {
        return;
      }
    }

    let moved = 0;

    async function moveRecursive(mount: string, oldBase: string, newBase: string): Promise<void> {
      const entries = await service.list(mount, oldBase);
      for (const entry of entries) {
        if (entry.isFolder) {
          const oldSub = entry.path;
          const newSub = newBase + oldSub.slice(oldBase.length);
          await moveRecursive(mount, oldSub, newSub);
        } else {
          const record = await service.read(mount, entry.path);
          if (record) {
            const targetPath = newBase + entry.path.slice(oldBase.length);
            await service.write(mount, targetPath, record.data);
            await service.delete(mount, entry.path);
            moved++;
          }
        }
      }
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Renaming "${node.label}" to "${newName.trim()}"…`,
        cancellable: false,
      },
      async () => {
        if (isFolder) {
          await moveRecursive(node.mount!, node.path!, newPath);
        } else {
          const record = await service.read(node.mount!, node.path!);
          if (record) {
            await service.write(node.mount!, newPath, record.data);
            await service.delete(node.mount!, node.path!);
            moved = 1;
          }
        }
      }
    );

    treeProvider.refresh();
    logger.info(`Renamed ${node.path} → ${newPath} (${moved} secret(s) moved).`);
    vscode.window.showInformationMessage(
      isFolder
        ? `Renamed folder: ${moved} secret(s) moved to "${newPath}".`
        : `Renamed secret to "${newPath}".`
    );
  });

  reg("vault.copyPath", async (node?: VaultNode) => {
    if (!node?.path) {
      return;
    }
    await vscode.env.clipboard.writeText(node.mount ? `${node.mount}/${node.path}` : node.path);
  });

  reg("vault.addToCompare", async (node?: VaultNode) => {
    if (!node || node.kind !== "secret" || !node.mount || node.path === undefined) {
      return;
    }
    const conn = store.get(node.connectionId);
    const entry = {
      connectionId: node.connectionId,
      connectionName: conn?.name ?? node.connectionId,
      mount: node.mount,
      path: node.path,
    };

    if (compareStore.has(entry)) {
      compareStore.remove(entry);
      const remaining = compareStore.list().map((e) => compareStore.display(e)).join(", ") || "(empty)";
      vscode.window.showInformationMessage(
        `Removed from compare (${compareStore.size}/2). Now: ${remaining}`
      );
      return;
    }

    const result = compareStore.add(entry);
    if (!result.ok) {
      vscode.window.showWarningMessage(result.reason);
      return;
    }
    const list = compareStore.list().map((e) => compareStore.display(e)).join(", ");
    vscode.window.showInformationMessage(`Added to compare (${compareStore.size}/2): ${list}`);
  });

  reg("vault.clearCompare", () => {
    if (compareStore.size === 0) {
      vscode.window.showInformationMessage("Compare list is already empty.");
      return;
    }
    compareStore.clear();
    vscode.window.showInformationMessage("Compare list cleared.");
  });

  reg("vault.compareSelected", async () => {
    const entries = [...compareStore.list()];
    if (entries.length < 2) {
      vscode.window.showWarningMessage('Add 2 secrets with "Add to Compare" first.');
      return;
    }

    const sourcePick = await vscode.window.showQuickPick(
      entries.map((e, index) => ({
        label: compareStore.display(e),
        description: `Slot ${index + 1}`,
        detail: "Use as the left (source) side of the diff",
        index,
      })),
      {
        title: "Compare — Choose Source",
        placeHolder: "Which secret is the comparison source?",
      }
    );
    if (!sourcePick) {
      return;
    }

    const source = entries[sourcePick.index];
    const other = entries.find((_, i) => i !== sourcePick.index);
    if (!other) {
      return;
    }

    const leftUri = VaultFileSystemProvider.buildUri(
      source.connectionId,
      source.mount,
      source.path,
      source.connectionName
    );
    const rightUri = VaultFileSystemProvider.buildUri(
      other.connectionId,
      other.mount,
      other.path,
      other.connectionName
    );

    try {
      await deps.fsProvider.readFile(leftUri);
    } catch {
      vscode.window.showErrorMessage(`Source secret not found: ${compareStore.display(source)}`);
      return;
    }
    try {
      await deps.fsProvider.readFile(rightUri);
    } catch {
      vscode.window.showErrorMessage(`Secret not found: ${compareStore.display(other)}`);
      return;
    }

    const title = `${compareStore.display(source)} ↔ ${compareStore.display(other)}`;
    await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title, { preview: true });
  });

  reg("vault.copyTo", async (node?: VaultNode) => {
    if (!node || !node.mount || (node.kind !== "secret" && node.kind !== "folder" && node.kind !== "mount")) {
      return;
    }
    if (getConfig().readOnly) {
      vscode.window.showWarningMessage("Vault: read-only mode is enabled.");
      return;
    }

    const connections = store.list();
    if (connections.length === 0) {
      vscode.window.showWarningMessage("No Vault connections configured.");
      return;
    }

    const sourceConn = store.get(node.connectionId);
    const sourceLabel = sourceConn?.name ?? node.connectionId;
    const sourceBase = node.kind === "mount" ? "" : node.path ?? "";
    const sourceDisplay = sourceBase
      ? `${sourceLabel}/${node.mount}/${sourceBase}`
      : `${sourceLabel}/${node.mount}`;

    const destConnPick = await vscode.window.showQuickPick(
      connections.map((c) => ({
        label: c.name,
        description: c.url.replace(/^https?:\/\//, ""),
        id: c.id,
      })),
      {
        title: "Copy To — Target Connection",
        placeHolder: `Copying from ${sourceDisplay}`,
      }
    );
    if (!destConnPick) {
      return;
    }

    const destService = await deps.factory.create(destConnPick.id);
    let mounts: string[] = [];
    try {
      mounts = (await destService.discoverKvMounts()).map((m) => m.path);
    } catch (err) {
      vscode.window.showErrorMessage(`Vault: ${summarizeError(err)}`);
      return;
    }
    if (mounts.length === 0) {
      vscode.window.showErrorMessage("Target connection has no KV mounts.");
      return;
    }

    const destMountPick = await vscode.window.showQuickPick(
      mounts.map((m) => ({ label: m })),
      {
        title: "Copy To — Target Mount",
        placeHolder: "Select the destination KV mount",
      }
    );
    if (!destMountPick) {
      return;
    }

    const defaultDestPath =
      node.kind === "secret"
        ? sourceBase
        : node.kind === "folder"
          ? sourceBase
          : "";
    const destPathInput = await vscode.window.showInputBox({
      title: "Copy To — Destination Path",
      prompt:
        node.kind === "secret"
          ? "Full secret path under the target mount (existing secrets are skipped)"
          : "Base path under the target mount (existing secrets are skipped; empty = mount root)",
      value: defaultDestPath,
      placeHolder: node.kind === "secret" ? "apps/my-secret" : "apps/backup (optional)",
    });
    if (destPathInput === undefined) {
      return;
    }
    const destBase = destPathInput.trim().replace(/^\/+|\/+$/g, "");

    const destDisplay = destBase
      ? `${destConnPick.label}/${destMountPick.label}/${destBase}`
      : `${destConnPick.label}/${destMountPick.label}`;
    const confirm = await vscode.window.showWarningMessage(
      `Copy ${sourceDisplay} → ${destDisplay}?\n\nExisting secrets at the destination will be skipped (not overwritten). Version history is not copied.`,
      { modal: true },
      "Copy"
    );
    if (confirm !== "Copy") {
      return;
    }

    const sourceService = await deps.factory.create(node.connectionId);
    let created = 0;
    let skipped = 0;
    let failed = 0;

    function remap(entryPath: string): string {
      if (node!.kind === "secret") {
        return destBase;
      }
      const relative = sourceBase
        ? entryPath.slice(sourceBase.length).replace(/^\//, "")
        : entryPath;
      return joinPath(destBase, relative);
    }

    async function copySecret(mount: string, path: string): Promise<void> {
      const targetPath = remap(path);
      if (!targetPath && node!.kind === "secret") {
        failed++;
        logger.error(`Copy skipped empty destination for ${mount}/${path}`);
        return;
      }
      try {
        const existing = await destService.read(destMountPick!.label, targetPath);
        if (existing) {
          skipped++;
          return;
        }
        const record = await sourceService.read(mount, path);
        if (!record) {
          skipped++;
          return;
        }
        await destService.write(destMountPick!.label, targetPath, record.data);
        created++;
      } catch (err) {
        failed++;
        logger.errorFrom(`Copy ${mount}/${path} → ${targetPath}`, err);
      }
    }

    async function copyRecursive(mount: string, path: string): Promise<void> {
      const entries = await sourceService.list(mount, path);
      for (const entry of entries) {
        if (entry.isFolder) {
          await copyRecursive(mount, entry.path);
        } else {
          await copySecret(mount, entry.path);
        }
      }
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Copying to ${destDisplay}…`,
        cancellable: false,
      },
      async () => {
        if (node.kind === "secret") {
          await copySecret(node.mount!, node.path!);
        } else {
          await copyRecursive(node.mount!, sourceBase);
        }
      }
    );

    treeProvider.refresh();
    logger.info(
      `Copy ${sourceDisplay} → ${destDisplay}: created=${created}, skipped=${skipped}, failed=${failed}`
    );
    vscode.window.showInformationMessage(
      `Copy finished: ${created} created, ${skipped} skipped, ${failed} failed.`
    );
  });

  reg("vault.searchHere", async (node?: VaultNode) => {
    if (!node) {
      return;
    }
    const conn = store.get(node.connectionId);
    const mount = node.mount ?? conn?.defaultMount;
    const startPath = node.kind === "folder" ? node.path : conn?.basePath ?? "";
    await searchView.prime(node.connectionId, mount, startPath);
  });

  reg("vault.focusSearch", async () => {
    await vscode.commands.executeCommand("vaultSearch.focus");
  });

  reg("vault.exportResultsJson", () => searchView.exportResults("json"));
  reg("vault.exportResultsCsv", () => searchView.exportResults("csv"));

  reg("vault.downloadPath", async (node?: VaultNode) => {
    if (!node || !node.mount) {
      return;
    }

    const service = await deps.factory.create(node.connectionId);
    const zip = new AdmZip();

    async function collect(mount: string, path: string) {
      const entries = await service.list(mount, path);
      for (const entry of entries) {
        if (entry.isFolder) {
          await collect(mount, entry.path);
        } else {
          const secret = await service.read(mount, entry.path);
          if (secret) {
            zip.addFile(
              `${entry.path}.json`,
              Buffer.from(JSON.stringify(secret.data, null, 2))
            );
          }
        }
      }
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Vault: Downloading...",
        cancellable: true,
      },
      async (_progress, _token) => {
        await collect(node.mount!, node.path ?? "");
      }
    );

    const saveUri = await vscode.window.showSaveDialog({
      saveLabel: "Save Archive",
      filters: { "Zip Files": ["zip"] },
    });

    if (saveUri) {
      zip.writeZip(saveUri.fsPath);
      vscode.window.showInformationMessage(`Vault: Saved to ${saveUri.fsPath}`);
    }
  });

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

/** Wrap a command handler with uniform error reporting and token re-auth offers. */
function wrap(
  id: string,
  handler: (...args: any[]) => any,
  logger: Logger,
  store: ConnectionStore,
  treeProvider: VaultTreeProvider
) {
  return async (...args: any[]) => {
    try {
      return await handler(...args);
    } catch (err) {
      logger.errorFrom(id, err);
      const conn = connectionFromArgs(store, args);
      const reauthed = await offerReauthOnError(err, conn, store);
      if (reauthed) {
        treeProvider.refresh();
        try {
          return await handler(...args);
        } catch (retryErr) {
          logger.errorFrom(id, retryErr);
          vscode.window.showErrorMessage(`Vault: ${summarizeError(retryErr)}`);
        }
        return;
      }
      // offerReauthOnError already displayed the message when an auth error had a connection.
      if (!conn || !isAuthError(err)) {
        vscode.window.showErrorMessage(`Vault: ${summarizeError(err)}`);
      }
    }
  };
}

/** Best-effort: find a connection from command args (tree node or similar). */
function connectionFromArgs(store: ConnectionStore, args: any[]): VaultConnection | undefined {
  for (const arg of args) {
    if (arg && typeof arg === "object" && typeof arg.connectionId === "string" && arg.connectionId) {
      const c = store.get(arg.connectionId);
      if (c) {
        return c;
      }
    }
  }
  const list = store.list();
  return list.length === 1 ? list[0] : undefined;
}
