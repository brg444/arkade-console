# Arkade Go SDK (github.com/arkade-os/go-sdk)

## Architecture

Single-module Go library. gRPC-only transport (REST client was removed).

- **ArkClient**: Main interface for interacting with the Arkade server. Init, send, receive, settle.
- **Wallet**: Key management, coin selection, transaction building.
- **Store**: Pluggable storage backends. In-memory, file-based, SQL (SQLite via sqlc).

## Key types

- `ArkClient` interface in `client.go`
- `InitArgs` for client initialization
- `SendArgs` for sending payments
- `Vtxo` domain model

## Storage backends

- In-memory (default, for testing)
- File-based (JSON persistence)
- SQL/SQLite (via sqlc-generated code)

## Build

Standard Go module. Makefile-based. Requires Go 1.26+.
