import * as vscode from "vscode";
import { KvVersion, VaultConnection } from "../models/connection";
import { ConnectionStore } from "../storage/connectionStore";
import { summarizeError } from "../utils/logger";
import { VaultError } from "../utils/errors";
import { normalizePath } from "../utils/paths";
import { getConfig } from "../vault/vaultServiceFactory";
import { VaultService } from "../vault/vaultService";

/** Simple UUID v4 generator (no external dependency). */
export function uuid(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex
    .slice(8, 10)
    .join("")}-${hex.slice(10, 16).join("")}`;
}

/** Result of the add-connection wizard (token captured in-flow). */
export interface NewConnectionResult {
  connection: VaultConnection;
  token: string;
}

function stepTitle(step: number, total: number, label: string, kind: "Add" | "Edit" = "Add"): string {
  return `${kind} Vault Connection (${step}/${total}) — ${label}`;
}

type ConnectionMode = "normal" | "advanced";

async function pickConnectionMode(
  kind: "Add" | "Edit",
  options?: { preferAdvanced?: boolean }
): Promise<ConnectionMode | undefined> {
  const preferAdvanced = Boolean(options?.preferAdvanced);
  const normalMode = {
    label: "Normal",
    description: "Recommended",
    detail: "Show every KV mount and path this token can access. No mount/path restriction.",
    mode: "normal" as const,
  };
  const advancedMode = {
    label: "Advanced",
    description: preferAdvanced ? "Currently restricted" : undefined,
    detail: "Limit the explorer to a specific KV mount and/or path prefix.",
    mode: "advanced" as const,
  };
  const pick = await vscode.window.showQuickPick(
    preferAdvanced ? [advancedMode, normalMode] : [normalMode, advancedMode],
    {
      title: `${kind} Vault Connection — Mode`,
      placeHolder: preferAdvanced
        ? "This connection currently restricts mount/path (Advanced)"
        : "Choose how this connection browses Vault",
      ignoreFocusOut: true,
    }
  );
  return pick?.mode;
}

interface AdvancedRestrictions {
  defaultMount: string;
  basePath?: string;
  kvVersion?: KvVersion;
}

async function promptAdvancedRestrictions(
  kind: "Add" | "Edit",
  total: number,
  startStep: number,
  existing?: Pick<VaultConnection, "defaultMount" | "basePath" | "kvVersion">
): Promise<AdvancedRestrictions | undefined> {
  const mountIn = await vscode.window.showInputBox({
    title: stepTitle(startStep, total, "Restrict to KV Mount (optional)", kind),
    prompt:
      "If set, the explorer shows only this KV mount. Leave blank to list every mount this token can access.",
    placeHolder: "e.g. secret  (leave blank to show all mounts)",
    value: existing?.defaultMount ?? "",
    ignoreFocusOut: true,
  });
  if (mountIn === undefined) {
    return undefined;
  }

  const pathIn = await vscode.window.showInputBox({
    title: stepTitle(startStep + 1, total, "Path Prefix (optional)", kind),
    prompt:
      "If set, the explorer shows only this path under the mount. Leave blank for the mount root.",
    placeHolder: "e.g. apps/api  (leave blank for the mount root)",
    value: existing?.basePath ?? "",
    ignoreFocusOut: true,
  });
  if (pathIn === undefined) {
    return undefined;
  }

  const kvPick = await vscode.window.showQuickPick(
    [
      {
        label: "Auto-detect",
        detail: "Ask Vault which KV version this mount uses when possible.",
        value: undefined as KvVersion | undefined,
      },
      {
        label: "KV Version 2",
        detail: "Versioned secrets (data/ + metadata/ paths).",
        value: 2 as const,
      },
      {
        label: "KV Version 1",
        detail: "Unversioned secrets (direct path).",
        value: 1 as const,
      },
    ],
    {
      title: stepTitle(startStep + 2, total, "KV Engine Version", kind),
      placeHolder: existing?.kvVersion ? `Currently: KV v${existing.kvVersion}` : "Auto-detect when possible",
      ignoreFocusOut: true,
    }
  );
  if (kvPick === undefined) {
    return undefined;
  }

  return {
    defaultMount: mountIn.trim(),
    basePath: normalizePath(pathIn) || undefined,
    kvVersion: kvPick.value,
  };
}

/**
 * Add-connection wizard: mode → name → URL → namespace → TLS → token (verified).
 * Normal mode discovers mounts/paths when browsing. Advanced mode can pin a
 * KV mount, path prefix, and KV version up front.
 */
export async function promptNewConnection(): Promise<NewConnectionResult | undefined> {
  const mode = await pickConnectionMode("Add");
  if (!mode) {
    return undefined;
  }
  const advanced = mode === "advanced";
  const total = advanced ? 8 : 5;
  const kind = "Add" as const;

  const name = await vscode.window.showInputBox({
    title: stepTitle(1, total, "Display Name", kind),
    prompt: "A friendly label shown in the Vault Explorer. Local only — never sent to Vault. Example: Production EU.",
    placeHolder: "e.g. Production EU",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? "A display name is required." : undefined),
  });
  if (name === undefined) {
    return undefined;
  }

  const url = await vscode.window.showInputBox({
    title: stepTitle(2, total, "Server URL", kind),
    prompt:
      "Base address of your Vault server, including https:// and port. Do not add an API path (no /v1). Example: https://vault.company.local:8200",
    placeHolder: "https://vault.company.local:8200",
    value: "https://",
    ignoreFocusOut: true,
    validateInput: (v) => {
      try {
        const u = new URL(v);
        return u.protocol === "http:" || u.protocol === "https:"
          ? undefined
          : "URL must start with http:// or https://.";
      } catch {
        return "Enter a valid URL, e.g. https://vault.company.local:8200";
      }
    },
  });
  if (url === undefined) {
    return undefined;
  }

  const namespace = await vscode.window.showInputBox({
    title: stepTitle(3, total, "Namespace / Organization (optional)", kind),
    prompt:
      "Vault Enterprise/HCP namespace (the org/tenant). Leave blank for open-source Vault. Nested paths allowed, e.g. admin/team-a.",
    placeHolder: "e.g. admin/team-a  (leave blank if unsure)",
    ignoreFocusOut: true,
  });
  if (namespace === undefined) {
    return undefined;
  }

  const tlsPick = await vscode.window.showQuickPick(
    [
      {
        label: "Verify TLS certificate (recommended)",
        detail: "Reject untrusted certificates. Use for public CAs and properly trusted internal CAs.",
        value: false,
      },
      {
        label: "Skip TLS verification",
        detail: "Accept self-signed / internal-PKI certificates. Applies to THIS connection only, never globally.",
        value: true,
      },
    ],
    {
      title: stepTitle(4, total, "TLS Verification", kind),
      placeHolder: "Verify or skip TLS for this connection",
      ignoreFocusOut: true,
    }
  );
  if (tlsPick === undefined) {
    return undefined;
  }

  const token = await vscode.window.showInputBox({
    title: stepTitle(5, total, "Vault Token", kind),
    prompt:
      "Your Vault token (e.g. from `vault login` or the Vault UI). Stored securely in VS Code SecretStorage; never written to settings, logs, or sync.",
    placeHolder: "hvs.… or s.… (input is hidden)",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? "A token is required to authenticate." : undefined),
  });
  if (token === undefined) {
    return undefined;
  }

  const trimmedUrl = url.trim().replace(/\/+$/, "");
  const trimmedNs = namespace.trim() || undefined;
  const trimmedToken = token.trim();
  const { timeoutMs } = getConfig();

  const service = new VaultService(
    {
      id: "__wizard__",
      name: name.trim(),
      url: trimmedUrl,
      authMethod: "token",
      namespace: trimmedNs,
      skipTlsVerify: tlsPick.value,
      defaultMount: "",
      token: trimmedToken,
    },
    timeoutMs
  );

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Vault: verifying token…" },
      async () => {
        await service.verify();
      }
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Vault: could not verify token — ${summarizeError(err)}`);
    return undefined;
  }

  let defaultMount = "";
  let basePath: string | undefined;
  let kvVersion: KvVersion | undefined;
  if (advanced) {
    const restrictions = await promptAdvancedRestrictions(kind, total, 6);
    if (!restrictions) {
      return undefined;
    }
    defaultMount = restrictions.defaultMount;
    basePath = restrictions.basePath;
    kvVersion = restrictions.kvVersion;
  }

  return {
    connection: {
      id: uuid(),
      name: name.trim(),
      url: trimmedUrl,
      authMethod: "token",
      namespace: trimmedNs,
      skipTlsVerify: tlsPick.value,
      defaultMount,
      basePath,
      kvVersion,
    },
    token: trimmedToken,
  };
}

/**
 * Edit an existing connection via field prompts (no rediscovery).
 *
 * Normal mode: name, URL, namespace, TLS — explorer lists all mounts/paths the
 * token can access. Advanced mode: also set optional KV mount + path prefix
 * (and KV version) to restrict the explorer.
 *
 * Defaults to Advanced when the connection already has a mount or path set.
 */
export async function promptConnection(existing?: VaultConnection): Promise<VaultConnection | undefined> {
  if (!existing) {
    const created = await promptNewConnection();
    return created?.connection;
  }

  const hasRestriction = Boolean(
    (existing.defaultMount ?? "").trim() || (existing.basePath ?? "").trim() || existing.kvVersion
  );

  const mode = await pickConnectionMode("Edit", { preferAdvanced: hasRestriction });
  if (!mode) {
    return undefined;
  }
  const advanced = mode === "advanced";
  const total = advanced ? 7 : 4;
  const kind = "Edit" as const;

  const name = await vscode.window.showInputBox({
    title: stepTitle(1, total, "Display Name", kind),
    prompt: "A friendly label shown in the Vault Explorer. Local only — never sent to Vault.",
    placeHolder: "e.g. Production EU",
    value: existing.name,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? "A display name is required." : undefined),
  });
  if (name === undefined) {
    return undefined;
  }

  const url = await vscode.window.showInputBox({
    title: stepTitle(2, total, "Server URL", kind),
    prompt:
      "Base address of your Vault server, including https:// and port. Do not add an API path (no /v1).",
    placeHolder: "https://vault.company.local:8200",
    value: existing.url,
    ignoreFocusOut: true,
    validateInput: (v) => {
      try {
        const u = new URL(v);
        return u.protocol === "http:" || u.protocol === "https:"
          ? undefined
          : "URL must start with http:// or https://.";
      } catch {
        return "Enter a valid URL, e.g. https://vault.company.local:8200";
      }
    },
  });
  if (url === undefined) {
    return undefined;
  }

  const namespace = await vscode.window.showInputBox({
    title: stepTitle(3, total, "Namespace / Organization (optional)", kind),
    prompt: "Vault Enterprise/HCP namespace. Leave blank for open-source Vault.",
    placeHolder: "e.g. admin/team-a  (leave blank if unsure)",
    value: existing.namespace ?? "",
    ignoreFocusOut: true,
  });
  if (namespace === undefined) {
    return undefined;
  }

  let defaultMount = "";
  let basePath: string | undefined;
  let kvVersion: KvVersion | undefined;

  if (advanced) {
    const restrictions = await promptAdvancedRestrictions(kind, total, 4, existing);
    if (!restrictions) {
      return undefined;
    }
    defaultMount = restrictions.defaultMount;
    basePath = restrictions.basePath;
    kvVersion = restrictions.kvVersion;
  }

  const tlsPick = await vscode.window.showQuickPick(
    [
      {
        label: "Verify TLS certificate (recommended)",
        detail: "Reject untrusted certificates.",
        value: false,
      },
      {
        label: "Skip TLS verification",
        detail: "Accept self-signed / internal-PKI certificates for THIS connection only.",
        value: true,
      },
    ],
    {
      title: stepTitle(advanced ? 7 : 4, total, "TLS Verification", kind),
      placeHolder: existing.skipTlsVerify ? "Currently: skipping verification" : "Currently: verifying",
      ignoreFocusOut: true,
    }
  );
  if (tlsPick === undefined) {
    return undefined;
  }

  return {
    id: existing.id,
    name: name.trim(),
    url: url.trim().replace(/\/+$/, ""),
    authMethod: "token",
    namespace: namespace.trim() || undefined,
    // Normal mode clears restrictions so the explorer uses full discovery again.
    defaultMount: advanced ? defaultMount : "",
    basePath: advanced ? basePath : undefined,
    skipTlsVerify: tlsPick.value,
    kvVersion: advanced ? kvVersion : undefined,
    groupId: existing.groupId,
    sortOrder: existing.sortOrder,
  };
}

/**
 * Prompt for a Vault token with masked input.
 */
export async function promptToken(connectionName: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: `Vault Token — ${connectionName}`,
    prompt:
      "Your Vault token (e.g. from `vault login` or the Vault UI). Stored securely in VS Code SecretStorage; never written to settings, logs, or sync.",
    placeHolder: "hvs.… or s.… (input is hidden)",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? "A token is required to authenticate." : undefined),
  });
}

/** Build the Vault web UI auth URL for a connection. */
export function vaultUiAuthUrl(conn: Pick<VaultConnection, "url" | "namespace">): string {
  const base = conn.url.replace(/\/+$/, "");
  const u = new URL(`${base}/ui/vault/auth`);
  if (conn.namespace && conn.namespace.trim()) {
    u.searchParams.set("namespace", conn.namespace.trim());
  }
  return u.toString();
}

/**
 * Open Vault UI in the browser and prompt the user to paste a new token.
 * Returns the trimmed token, or undefined if cancelled.
 */
export async function reauthenticateWithVaultUi(
  conn: VaultConnection,
  options?: { openBrowser?: boolean }
): Promise<string | undefined> {
  const openBrowser = options?.openBrowser !== false;
  if (openBrowser) {
    const uiUrl = vaultUiAuthUrl(conn);
    await vscode.env.openExternal(vscode.Uri.parse(uiUrl));
  }

  return vscode.window
    .showInputBox({
      title: `Re-authenticate — ${conn.name}`,
      prompt: openBrowser
        ? "Sign in via the Vault UI that just opened, then paste your new token here."
        : "Paste a new Vault token for this connection.",
      placeHolder: "hvs.… or s.… (input is hidden)",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length === 0 ? "A token is required." : undefined),
    })
    .then((v) => (v === undefined ? undefined : v.trim()));
}

/**
 * If `err` is an auth/expiry error, offer Re-authenticate… for `conn`.
 * Returns true when a new token was saved.
 */
export async function offerReauthOnError(
  err: unknown,
  conn: VaultConnection | undefined,
  store: ConnectionStore
): Promise<boolean> {
  if (!conn || !isAuthError(err)) {
    return false;
  }
  const choice = await vscode.window.showErrorMessage(
    `Vault: ${summarizeError(err)}`,
    { modal: false },
    "Re-authenticate…"
  );
  if (choice !== "Re-authenticate…") {
    return false;
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
    { title: `Re-authenticate — ${conn.name}`, ignoreFocusOut: true }
  );
  if (!pick) {
    return false;
  }

  const token = await reauthenticateWithVaultUi(conn, { openBrowser: pick.openBrowser });
  if (!token) {
    return false;
  }
  await store.setToken(conn.id, token);
  vscode.window.showInformationMessage(`Vault: token saved for "${conn.name}".`);
  return true;
}

export function isAuthError(err: unknown): boolean {
  if (err instanceof VaultError) {
    return err.kind === "tokenExpired" || err.kind === "unauthorized" || err.kind === "forbidden";
  }
  return false;
}
