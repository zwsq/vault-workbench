import * as vscode from "vscode";
import { VaultConnection } from "../models/connection";
import { ConnectionStore } from "../storage/connectionStore";
import { Logger, summarizeError } from "../utils/logger";
import { joinPath } from "../utils/paths";
import { VaultServiceFactory } from "../vault/vaultServiceFactory";

export type VaultNodeKind = "group" | "connection" | "mount" | "folder" | "secret";

/** A node in the Vault Explorer tree. */
export interface VaultNode {
  kind: VaultNodeKind;
  label: string;
  /** Connection id; empty string for group nodes. */
  connectionId: string;
  /** Present for group nodes and connections that belong to a group. */
  groupId?: string;
  mount?: string;
  /** Path relative to the mount (folders and secrets). */
  path?: string;
}

/**
 * Provides the lazy-loading Vault Explorer tree. Children are fetched on demand
 * as folders are expanded so opening a connection with tens of thousands of
 * secrets never blocks the UI.
 *
 * Root children are connection groups plus ungrouped connections.
 */
export class VaultTreeProvider implements vscode.TreeDataProvider<VaultNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<VaultNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly store: ConnectionStore,
    private readonly factory: VaultServiceFactory,
    private readonly logger: Logger
  ) {}

  refresh(node?: VaultNode): void {
    this._onDidChangeTreeData.fire(node);
  }

  getTreeItem(node: VaultNode): vscode.TreeItem {
    switch (node.kind) {
      case "group":
        return this.groupItem(node);
      case "connection":
        return this.connectionItem(node);
      case "mount": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `mount:${node.connectionId}:${node.mount}`;
        item.iconPath = new vscode.ThemeIcon("database");
        item.contextValue = "vaultMount";
        return item;
      }
      case "folder": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `folder:${node.connectionId}:${node.mount}:${node.path}`;
        item.iconPath = vscode.ThemeIcon.Folder;
        item.contextValue = "vaultFolder";
        item.tooltip = `${node.mount}/${node.path}`;
        return item;
      }
      case "secret": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = `secret:${node.connectionId}:${node.mount}:${node.path}`;
        item.iconPath = new vscode.ThemeIcon("key");
        item.contextValue = "vaultSecret";
        item.command = {
          command: "vault.openSecret",
          title: "Open Secret",
          arguments: [node],
        };
        return item;
      }
    }
  }

  private groupItem(node: VaultNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `group:${node.groupId}`;
    item.iconPath = new vscode.ThemeIcon("folder-library");
    item.contextValue = "vaultGroup";
    item.tooltip = `Group: ${node.label}`;
    return item;
  }

  private connectionItem(node: VaultNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `connection:${node.connectionId}`;
    item.iconPath = new vscode.ThemeIcon("server-environment");
    item.contextValue = "vaultConnection";
    const conn = this.store.get(node.connectionId);
    if (conn) {
      item.description = conn.url.replace(/^https?:\/\//, "");
      item.tooltip = new vscode.MarkdownString(
        [
          `**${conn.name}**`,
          `URL: ${conn.url}`,
          conn.namespace ? `Namespace: ${conn.namespace}` : undefined,
          conn.defaultMount ? `Mount: ${conn.defaultMount}` : undefined,
          conn.basePath ? `Path prefix: ${conn.basePath}` : undefined,
          `TLS verify: ${conn.skipTlsVerify ? "off" : "on"}`,
        ]
          .filter(Boolean)
          .join("\n\n")
      );
    }
    return item;
  }

  async getChildren(node?: VaultNode): Promise<VaultNode[]> {
    if (!node) {
      const groups = this.store.listGroups().map((g) => this.toGroupNode(g.id, g.name));
      const ungrouped = this.store.listInGroup(undefined).map((c) => this.toConnectionNode(c));
      return [...groups, ...ungrouped];
    }
    try {
      switch (node.kind) {
        case "group":
          return this.store.listInGroup(node.groupId).map((c) => this.toConnectionNode(c));
        case "connection":
          return await this.mountsOf(node.connectionId);
        case "mount": {
          const base = this.store.get(node.connectionId)?.basePath ?? "";
          return await this.listChildren(node.connectionId, node.mount!, base);
        }
        case "folder":
          return await this.listChildren(node.connectionId, node.mount!, node.path!);
        default:
          return [];
      }
    } catch (err) {
      this.logger.warn(`Failed to expand ${node.kind}: ${summarizeError(err)}`);
      vscode.window.showErrorMessage(`Vault: ${summarizeError(err)}`);
      return [];
    }
  }

  private toGroupNode(groupId: string, name: string): VaultNode {
    return { kind: "group", label: name, connectionId: "", groupId };
  }

  private toConnectionNode(c: VaultConnection): VaultNode {
    return { kind: "connection", label: c.name, connectionId: c.id, groupId: c.groupId };
  }

  private async mountsOf(connectionId: string): Promise<VaultNode[]> {
    const service = await this.factory.create(connectionId);
    const conn = this.store.get(connectionId)!;
    let mounts = await service.listMounts();
    if (mounts.length === 0 && conn.defaultMount) {
      mounts = [conn.defaultMount];
    }
    return mounts.map((m) => ({ kind: "mount" as const, label: m, connectionId, mount: m }));
  }

  private async listChildren(connectionId: string, mount: string, path: string): Promise<VaultNode[]> {
    const service = await this.factory.create(connectionId);
    const entries = await service.list(mount, path);
    const folders = entries
      .filter((e) => e.isFolder)
      .map<VaultNode>((e) => ({
        kind: "folder",
        label: e.name,
        connectionId,
        mount,
        path: joinPath(path, e.name),
      }));
    const secrets = entries
      .filter((e) => !e.isFolder)
      .map<VaultNode>((e) => ({
        kind: "secret",
        label: e.name,
        connectionId,
        mount,
        path: joinPath(path, e.name),
      }));
    return [...folders, ...secrets];
  }
}
