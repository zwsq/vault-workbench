import { KvVersion } from "./connection";

/** A key/value secret payload. Vault KV stores arbitrary JSON objects. */
export type SecretData = Record<string, unknown>;

/** A secret read from Vault together with KV metadata. */
export interface SecretRecord {
  /** Path relative to the mount, e.g. "apps/api/config". */
  path: string;
  /** Mount name, e.g. "secret". */
  mount: string;
  /** KV engine version this secret was read from. */
  kvVersion: KvVersion;
  /** The decoded data object. */
  data: SecretData;
  /** KV v2 version number, if applicable. */
  version?: number;
  /** True if KV v2 reports the secret as soft-deleted. */
  deleted?: boolean;
}

/** An entry in a listing: either a folder (ends with "/") or a leaf secret. */
export interface ListingEntry {
  /** Name of the entry within its parent (no leading path). */
  name: string;
  /** Full path relative to the mount. */
  path: string;
  /** True when the entry is a folder (Vault list keys ending in "/"). */
  isFolder: boolean;
}

/** A stored backup of a secret prior to modification. */
export interface SecretBackup {
  connectionId: string;
  mount: string;
  path: string;
  kvVersion: KvVersion;
  version?: number;
  timestamp: string;
  data: SecretData;
}
