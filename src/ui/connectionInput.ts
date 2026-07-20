import * as vscode from "vscode";
import { VaultConnection } from "../models/connection";

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

/** Total number of steps in the connection wizard, shown in each step's title. */
const TOTAL_STEPS = 7;

/** Build a consistent, numbered step title so users can track progress. */
function stepTitle(step: number, label: string): string {
  return `Add Vault Connection (${step}/${TOTAL_STEPS}) — ${label}`;
}

/**
 * Collect connection details via a sequence of input boxes and quick picks.
 * Returns undefined if the user cancels at any step. Never prompts for the token
 * here — the token is captured separately via a password-masked input and stored
 * in SecretStorage.
 *
 * Each step below sets a descriptive `prompt` (the helper line under the input),
 * an example `placeHolder`, and — for choices — per-option `detail` text, so the
 * user always knows exactly what a field means and what a valid value looks like.
 */
export async function promptConnection(existing?: VaultConnection): Promise<VaultConnection | undefined> {
  // Step 1 — Display name: a local label only. Not sent to Vault; purely to help
  // you tell multiple connections apart in the tree (e.g. "Production", "Dev").
  const name = await vscode.window.showInputBox({
    title: stepTitle(1, "Display Name"),
    prompt: "A friendly label shown in the Vault Explorer. Local only — never sent to Vault. Example: Production EU.",
    placeHolder: "e.g. Production EU",
    value: existing?.name ?? "",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? "A display name is required." : undefined),
  });
  if (name === undefined) {
    return undefined;
  }

  // Step 2 — URL: the base address of the Vault API, including scheme and port.
  // Do NOT include a path like /v1 — the extension adds API paths itself.
  const url = await vscode.window.showInputBox({
    title: stepTitle(2, "Server URL"),
    prompt:
      "Base address of your Vault server, including https:// and port. Do not add an API path (no /v1). Example: https://vault.company.local:8200",
    placeHolder: "https://vault.company.local:8200",
    value: existing?.url ?? "https://",
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

  // Step 3 — Namespace (optional): the Vault Enterprise / HCP tenant ("organization").
  // Leave blank for open-source Vault, which has no namespaces. Sent as the
  // X-Vault-Namespace header. Nested namespaces use "/" (e.g. admin/team-a).
  const namespace = await vscode.window.showInputBox({
    title: stepTitle(3, "Namespace / Organization (optional)"),
    prompt:
      "Vault Enterprise/HCP namespace (the org/tenant). Leave blank for open-source Vault. Nested paths allowed, e.g. admin/team-a.",
    placeHolder: "e.g. admin/team-a  (leave blank if unsure)",
    value: existing?.namespace ?? "",
    ignoreFocusOut: true,
  });
  if (namespace === undefined) {
    return undefined;
  }

  // Step 4 — Default KV mount: the name of the KV secrets engine to open first.
  // This is the mount path, not a secret path (e.g. "secret", "kv", "apps-kv").
  const defaultMount = await vscode.window.showInputBox({
    title: stepTitle(4, "Default KV Mount"),
    prompt:
      "The KV secrets engine mount to browse by default — its mount name, not a secret path. Common default: secret.",
    placeHolder: "e.g. secret",
    value: existing?.defaultMount ?? "secret",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? "A default mount is required (e.g. secret)." : undefined),
  });
  if (defaultMount === undefined) {
    return undefined;
  }

  // Step 5 — Path prefix (optional): where to start browsing inside the mount.
  // Essential for tokens scoped to a sub-path that cannot list the mount root.
  // Path is relative to the mount, without the mount name (e.g. "apps/api").
  const basePath = await vscode.window.showInputBox({
    title: stepTitle(5, "Path Prefix (optional)"),
    prompt:
      "Sub-path within the mount to start browsing from — relative to the mount, without the mount name. Use this when your token only has access to part of the mount. Leave blank to start at the mount root.",
    placeHolder: "e.g. apps/api  (leave blank for the mount root)",
    value: existing?.basePath ?? "",
    ignoreFocusOut: true,
  });
  if (basePath === undefined) {
    return undefined;
  }

  // Step 6 — KV engine version. Auto-detect probes Vault's sys endpoints; choose
  // an explicit version for scoped tokens that cannot read those endpoints.
  const kvPick = await vscode.window.showQuickPick(
    [
      {
        label: "Auto-detect",
        detail: "Ask Vault which KV version this mount uses. Needs access to Vault's sys endpoints.",
        value: undefined as 1 | 2 | undefined,
      },
      {
        label: "KV Version 2",
        detail: "Versioned secrets (data/ + metadata/ paths). The modern default for most Vaults.",
        value: 2 as const,
      },
      {
        label: "KV Version 1",
        detail: "Unversioned secrets (direct path). Choose this for older/simple KV mounts.",
        value: 1 as const,
      },
    ],
    {
      title: stepTitle(6, "KV Engine Version"),
      placeHolder: "How this mount stores secrets — pick explicitly if your token can't read sys endpoints",
      ignoreFocusOut: true,
    }
  );
  if (kvPick === undefined) {
    return undefined;
  }

  // Step 7 — TLS verification. Skipping is per-connection only and never changes
  // global Node TLS settings; use it for self-signed certs / internal PKI.
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
      title: stepTitle(7, "TLS Verification"),
      placeHolder: existing?.skipTlsVerify ? "Currently: skipping verification" : "Currently: verifying",
      ignoreFocusOut: true,
    }
  );
  if (tlsPick === undefined) {
    return undefined;
  }

  return {
    id: existing?.id ?? uuid(),
    name: name.trim(),
    url: url.trim().replace(/\/+$/, ""),
    authMethod: "token",
    namespace: namespace.trim() || undefined,
    defaultMount: defaultMount.trim(),
    basePath: basePath.trim() || undefined,
    skipTlsVerify: tlsPick.value,
    kvVersion: kvPick.value,
  };
}

/**
 * Prompt for a Vault token with masked input. The token authenticates every
 * request (sent as the X-Vault-Token header) and is the only credential that is
 * stored in VS Code SecretStorage — never in settings, logs, or Settings Sync.
 */
export async function promptToken(connectionName: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: `Vault Token — ${connectionName}`,
    prompt:
      "Your Vault token (e.g. from `vault login` or `vault token create`). Stored securely in VS Code SecretStorage; never written to settings, logs, or sync.",
    placeHolder: "hvs.… or s.… (input is hidden)",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? "A token is required to authenticate." : undefined),
  });
}
