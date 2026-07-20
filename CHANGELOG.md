# Changelog

All notable changes to the "Vault Workbench" extension are documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
