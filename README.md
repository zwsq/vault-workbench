# Vault Search & Replace

A Visual Studio Code extension to browse, search, edit, and perform batch
search-and-replace across HashiCorp Vault KV secrets — with a UX modeled on VS
Code's built-in Search panel.

**Everything runs locally.** No secret values, Vault URLs, or tokens are ever
sent to any external service. There is no telemetry, analytics, crash reporting,
or AI feature of any kind.

## Features

- **Multiple connections** — connect to one or more Vault instances (token auth),
  each with its own URL, namespace, default mount, optional path prefix, KV
  version, and TLS setting. Switch freely.
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
- **Replace with preview** — inline before/after diffs appear as you type in the
  Replace box, and opening a result shows a full diff editor (current vs
  proposed). Nothing is written until you confirm.
- **Delete matched text** — leave the Replace box empty to remove matches; this
  path requires a two-step confirmation to prevent accidents.
- **Selective replace** — tick/untick secrets in the results; the action button
  reads *Replace All (N)* or *Replace Selected (k)* accordingly.
- **Batch replace** — progress notification, per-item continue-on-failure, and a
  final report of succeeded / skipped / failed counts.
- **Backups** — optionally snapshot each secret (full JSON, path, version,
  timestamp) before modifying it, and restore later.
- **Exports** — export search results to JSON or CSV.

## Creating a connection

Open the **Vault** view in the Activity Bar and run **Add Connection** (the `+`
button or `Vault: Add Connection`). The wizard prompts, in order, for:

1. **Display name** — a friendly label shown in the tree.
2. **URL** — e.g. `https://vault.company.local:8200` (http or https).
3. **Namespace** *(optional)* — Vault Enterprise namespace, or blank.
4. **Default KV mount** — e.g. `secret`.
5. **Path prefix** *(optional)* — a sub-path to browse from, e.g. `apps/api`.
   Use this when your token is scoped to part of a mount and cannot list the
   mount root.
6. **KV version** — `Auto-detect`, `KV Version 2`, or `KV Version 1`. Choosing an
   explicit version is recommended for tokens that lack access to Vault's
   `sys/*` endpoints, since it skips version probing entirely.
7. **TLS** — verify the certificate (recommended) or *Skip TLS verification* for
   self-signed certificates / internal PKI.

You are then prompted for the **token**, which is stored in VS Code
SecretStorage (never in settings, never synced). Use `Vault: Set Token` on a
connection to update it later.

> Scoped tokens: browsing and searching require `list` on the KV `metadata`
> path and `read` on the `data` path for whatever prefix you use (for KV v2,
> e.g. `secret/metadata/apps/api/*` and `secret/data/apps/api/*`). The extension
> tolerates missing `sys/*` access and falls back to your default mount.

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
