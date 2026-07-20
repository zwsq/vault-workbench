# Vault Search & Replace

A Visual Studio Code extension to browse, search, edit, and perform batch
search-and-replace across HashiCorp Vault KV secrets — with a UX modeled on VS
Code's built-in Search panel.

**Everything runs locally.** No secret values, Vault URLs, or tokens are ever
sent to any external service. There is no telemetry, analytics, crash reporting,
or AI feature of any kind.

## Features

- **Multiple connections** — connect to one or more Vault instances (token auth),
  each with its own URL, namespace, default mount, and TLS setting. Switch freely.
- **Secure, sync-free storage** — tokens are stored in VS Code SecretStorage;
  connection metadata is stored in local-only `globalState` and explicitly opted
  out of Settings Sync. Nothing sensitive ever reaches synced settings.
- **Per-connection TLS control** — enable *Skip TLS Verification* for self-signed
  certs or internal PKI. Verification is relaxed **only for that connection's
  requests**, never globally.
- **KV v1 & v2** — automatic engine-version detection with per-mount handling,
  plus Vault Enterprise namespace support.
- **Vault Explorer** — a lazy-loading tree of connections → mounts → folders →
  secrets, so even vaults with tens of thousands of secrets stay responsive.
- **Native secret editor** — secrets open as formatted JSON via a `vault:`
  filesystem provider; saving writes back to Vault with version-aware
  (check-and-set) writes for KV v2.
- **Search panel** — search keys and/or values with Match Case, Whole Word, and
  Regex options, scoped to a connection, mount, and starting path. Results stream
  in with match highlighting.
- **Replace with preview** — see an old/new diff for every planned change before
  anything is written. Nothing is written until you confirm.
- **Batch replace** — progress notification, per-item continue-on-failure, and a
  final report of succeeded / skipped / failed counts.
- **Backups** — optionally snapshot each secret (full JSON, path, version,
  timestamp) before modifying it, and restore later.
- **Exports** — export search results to JSON or CSV.

## Architecture

Clean, layered, and free of business logic in UI components:

```
src/
  api/       Lightweight HTTPS Vault client (no third-party HTTP deps)
  vault/     KV-version-aware Vault service + factory
  search/    Pure text matcher + recursive search engine
  replace/   Preview generation + batch replace engine
  tree/      Vault Explorer TreeDataProvider
  editors/   vault: FileSystemProvider (native open/save)
  storage/   Connection store (globalState + SecretStorage) + backups
  ui/        Search webview provider, connection wizard
  commands/  Command registration
  models/    Shared types
  utils/     Logger (metadata-only), errors, concurrency, paths
```

Pure modules (`search/matcher`, `utils/paths`, `utils/errors`, `search`,
`replace`, `vault`, `api`) are free of VS Code imports and unit-tested with the
Node test runner. A mock-Vault HTTP server drives the service integration tests.

## Development

```bash
npm install
npm run compile        # type-check + bundle with esbuild
npm run watch          # incremental rebuilds
npm run test:unit      # unit + mock-Vault integration tests
npm run lint
```

Press `F5` in VS Code to launch an Extension Development Host.

## Settings

| Setting | Description |
| --- | --- |
| `vault.defaultConnection` | Connection selected on startup |
| `vault.defaultMount` | Fallback KV mount |
| `vault.concurrency` | Max concurrent Vault requests (search/batch) |
| `vault.timeoutMs` | Per-request timeout |
| `vault.backupBeforeReplace` | Snapshot secrets before batch replace |
| `vault.readOnly` | Disable all writes |

Connection URLs, tokens, and namespaces are **never** stored in settings.

## Security

- Tokens live only in SecretStorage; connection metadata only in local
  `globalState` (explicitly excluded from sync).
- The output log records metadata only — never tokens, secret values,
  connection strings, passwords, or API keys.
- TLS relaxation is scoped per request; global TLS settings are never modified.
- No network calls other than to your configured Vault server. Works fully
  offline after installation.

## License

MIT
