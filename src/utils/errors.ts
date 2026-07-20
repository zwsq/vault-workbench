/**
 * Error types for Vault operations.
 *
 * These errors are designed to be safe to log and display: they carry only
 * metadata (status codes, paths, categories) and NEVER embed tokens or secret
 * values. Callers should construct them via {@link classifyVaultError} so that
 * messages remain consistent and friendly.
 */

export type VaultErrorKind =
  | "unauthorized" // 403 / permission denied
  | "forbidden"
  | "notFound" // 404 / mount or secret not found
  | "tokenExpired"
  | "tls"
  | "timeout"
  | "network"
  | "namespaceNotFound"
  | "mountNotFound"
  | "secretDeleted"
  | "versionConflict"
  | "readOnly"
  | "badRequest"
  | "unknown";

export class VaultError extends Error {
  readonly kind: VaultErrorKind;
  readonly statusCode?: number;
  /** Non-sensitive path metadata for diagnostics. */
  readonly path?: string;

  constructor(kind: VaultErrorKind, message: string, opts?: { statusCode?: number; path?: string }) {
    super(message);
    this.name = "VaultError";
    this.kind = kind;
    this.statusCode = opts?.statusCode;
    this.path = opts?.path;
  }
}

/** Raised when the user has enabled read-only mode but a write was attempted. */
export class ReadOnlyError extends VaultError {
  constructor() {
    super("readOnly", "Read-only mode is enabled. Writes to Vault are disabled.");
  }
}

/**
 * Map a low-level HTTP failure or Node error into a friendly {@link VaultError}.
 *
 * @param status HTTP status code, if the request completed.
 * @param nodeCode Node error code (e.g. ETIMEDOUT, DEPTH_ZERO_SELF_SIGNED_CERT).
 * @param vaultErrors Array of error strings returned in the Vault JSON body.
 * @param path Non-sensitive path metadata.
 */
export function classifyVaultError(params: {
  status?: number;
  nodeCode?: string;
  vaultErrors?: string[];
  path?: string;
}): VaultError {
  const { status, nodeCode, vaultErrors, path } = params;
  const detail = (vaultErrors ?? []).join("; ").toLowerCase();

  if (nodeCode) {
    if (nodeCode === "ETIMEDOUT" || nodeCode === "ESOCKETTIMEDOUT") {
      return new VaultError("timeout", "The Vault request timed out.", { path });
    }
    if (isTlsErrorCode(nodeCode)) {
      return new VaultError(
        "tls",
        "TLS certificate verification failed. Enable \"Skip TLS Verification\" on this connection if you trust it.",
        { path }
      );
    }
    if (nodeCode === "ECONNREFUSED" || nodeCode === "ENOTFOUND" || nodeCode === "EHOSTUNREACH") {
      return new VaultError("network", "Could not reach the Vault server. Check the URL and network.", { path });
    }
  }

  switch (status) {
    case 400:
      if (isCasConflict(detail)) {
        return new VaultError("versionConflict", "The secret changed since you last read it (version conflict).", { statusCode: status, path });
      }
      return new VaultError("badRequest", "Vault rejected the request.", { statusCode: status, path });
    case 403:
      if (detail.includes("namespace")) {
        return new VaultError("namespaceNotFound", "The requested Vault namespace was not found or is not accessible.", { statusCode: status, path });
      }
      if (detail.includes("permission denied") || detail.includes("expired") || detail.includes("invalid token")) {
        return new VaultError("tokenExpired", "Permission denied. Your token may be expired or lacks access to this path.", { statusCode: status, path });
      }
      return new VaultError("unauthorized", "Permission denied for this path.", { statusCode: status, path });
    case 404:
      if (detail.includes("no handler")) {
        return new VaultError("mountNotFound", "The KV mount was not found.", { statusCode: status, path });
      }
      return new VaultError("notFound", "The requested secret or path was not found.", { statusCode: status, path });
    case 412:
      return new VaultError("versionConflict", "The secret changed since you last read it (version conflict).", { statusCode: status, path });
    default:
      if (status && status >= 500) {
        return new VaultError("network", "Vault returned a server error.", { statusCode: status, path });
      }
  }
  return new VaultError("unknown", "An unexpected Vault error occurred.", { statusCode: status, path });
}

function isCasConflict(detail: string): boolean {
  return (
    detail.includes("check-and-set") ||
    detail.includes("did not match the current version") ||
    (detail.includes("cas") && detail.includes("version")) ||
    (detail.includes("version") && detail.includes("mismatch"))
  );
}

function isTlsErrorCode(code: string): boolean {
  return (
    code.startsWith("DEPTH_ZERO") ||
    code.startsWith("SELF_SIGNED") ||
    code.startsWith("UNABLE_TO_") ||
    code.startsWith("CERT_") ||
    code.startsWith("ERR_TLS") ||
    code === "CERT_HAS_EXPIRED" ||
    code === "HOSTNAME_MISMATCH" ||
    code === "ERR_TLS_CERT_ALTNAME_INVALID"
  );
}
