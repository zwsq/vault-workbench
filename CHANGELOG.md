# Changelog

All notable changes to the "Vault Workbench" extension are documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-08-25

### Added

- **Copy To…** — recursively copy a mount, folder, or secret to another
  connection/mount/path. Existing destination secrets are skipped (never
  overwritten); version history is not copied.

### Fixed

- **Search In This Path** now keeps the connection of the selected tree node
  instead of resetting to the first / default Vault instance.
- Search/replace textareas expand vertically with content; horizontal
  scrolling is disabled (long lines wrap).

### Changed

- Search & Replace panel matches VS Code find-widget style: each field on its
  own full-width row, auto-growing textareas, and trailing icon actions
  (match options, search, replace).

## [0.2.0] - 2026-08-19

### Added

- **Download as ZIP** — right-click a mount or folder to download all secrets
  as a `.zip` archive.
- **Recursive delete** — right-click a folder or secret to delete it (folders
  delete all nested secrets recursively). Two-step confirmation with path
  re-typing for folders.
- **Rename** — rename secrets and folders from the context menu. Folders are
  moved recursively with a warning that version history will be lost.
  Duplicate-name check prevents accidental overwrites.
- **Refresh in context menu** — right-click a connection, mount, or folder to
  refresh just that subtree.
- Auto-refresh of the Vault Explorer after creating, deleting, or renaming
  secrets.

### Fixed

- **New secret save bug** — creating a new secret no longer opens the OS
  "Save As" dialog; Ctrl+S now saves directly to Vault via the `vault:`
  filesystem provider.
- **Duplicate save prevention** — pressing Ctrl+S multiple times without
  changing the document no longer writes redundant versions to Vault.

## [0.1.0] - 2026-07-20

### Added

- Initial release.
- Multiple token-based Vault connections; tokens stored in SecretStorage,
  metadata kept local-only (excluded from Settings Sync).
- KV v1 & v2 support with auto-detection and Enterprise namespace support.
- Per-connection Skip TLS Verification and optional Path Prefix for scoped tokens.
- Lazy Vault Explorer tree; secrets open as JSON and save back (CAS for v2).
- Search panel (regex / match case / whole word / keys / values) scoped to
  connection + mount + path, with concurrency, cancellation, and progress.
- Replace preview with inline before/after diff, batch replace with
  success/skip/fail report, optional backups + restore, JSON/CSV export,
  read-only mode, and a metadata-only Output log.
