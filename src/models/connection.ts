/**
 * Definition of a single Vault connection.
 *
 * IMPORTANT: This object is persisted to local-only extension storage
 * (globalState). It must NEVER contain the authentication token — the token is
 * stored separately in VS Code SecretStorage keyed by {@link VaultConnection.id}.
 */
export interface VaultConnection {
  /** Stable unique id (uuid-like). Used as the SecretStorage key. */
  id: string;
  /** Human-friendly display name shown in the UI. */
  name: string;
  /** Base Vault URL, e.g. https://vault.company.local:8200 */
  url: string;
  /** Authentication method. Only "token" is supported initially. */
  authMethod: VaultAuthMethod;
  /** Optional Vault Enterprise namespace. */
  namespace?: string;
  /** When true, HTTPS requests for this connection skip TLS verification. */
  skipTlsVerify: boolean;
  /** Default KV mount for this connection, e.g. "secret". */
  defaultMount: string;
  /**
   * Optional path prefix (relative to the mount) to browse from. Useful for
   * tokens scoped to a sub-path that cannot list the mount root, e.g. "apps/api".
   */
  basePath?: string;
  /** Optional explicit KV engine version override; auto-detected when omitted. */
  kvVersion?: KvVersion;
}

export type VaultAuthMethod = "token";

export type KvVersion = 1 | 2;

/** A connection with its resolved token, used at request time only. Never persisted. */
export interface ResolvedConnection extends VaultConnection {
  token: string;
}
