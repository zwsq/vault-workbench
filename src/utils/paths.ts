/**
 * Path helpers for Vault KV paths. Vault uses "/" as a separator; folders are
 * listing keys that end with "/". These helpers are pure and vscode-free.
 */

/** Remove leading and trailing slashes and collapse duplicate slashes. */
export function normalizePath(path: string): string {
  return path
    .split("/")
    .filter((seg) => seg.length > 0)
    .join("/");
}

/** Join path segments into a normalized Vault path. */
export function joinPath(...segments: string[]): string {
  return normalizePath(segments.join("/"));
}

/** Return the parent folder path ("" for a top-level entry). */
export function parentPath(path: string): string {
  const norm = normalizePath(path);
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? "" : norm.slice(0, idx);
}

/** Return the final segment of a path. */
export function baseName(path: string): string {
  const norm = normalizePath(path);
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? norm : norm.slice(idx + 1);
}

/** True when a Vault list key denotes a folder. */
export function isFolderKey(key: string): boolean {
  return key.endsWith("/");
}
