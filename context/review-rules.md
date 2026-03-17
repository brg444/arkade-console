# PR Review Rules for Arkade

Architecture compliance rules, cross-project dependency awareness, and breaking change detection for reviewing PRs across Arkade repos.

## Hexagonal Architecture (arkd)

arkd uses strict hexagonal (ports and adapters) architecture. All PRs to arkd must comply.

### Layer Map

```
Interface (internal/interface/)
    ↓ depends on
Application (internal/core/application/)
    ↓ depends on
Domain (internal/core/domain/) + Ports (internal/core/ports/)
    ↑ implemented by
Infrastructure (internal/infrastructure/)
```

### Dependency Rules

| Rule | Check |
|------|-------|
| Domain NEVER imports Infrastructure | `grep "import.*infrastructure" internal/core/domain/` |
| Domain NEVER imports Application | `grep "import.*application" internal/core/domain/` |
| Application NEVER imports Infrastructure | `grep "import.*infrastructure" internal/core/application/` |
| Ports contain only interfaces | No concrete implementations in `internal/core/ports/` |
| Port interfaces return domain types only | No infra types leaking through ports |
| Type conversion at boundaries | Proto types converted at interface layer, DB types at infra layer |

### Layer Responsibilities

**Domain** (`internal/core/domain/`): Pure business logic, entities (Round, Vtxo, Intent, OffchainTx, Asset, Fee), domain events, state machines. Zero external dependencies, no I/O.

**Ports** (`internal/core/ports/`): Interfaces only. RepoManager, WalletService, SignerService, Scanner, TxBuilder, LiveStore, Scheduler, FeeManager.

**Application** (`internal/core/application/`): Use case orchestration. Main service, sweeper, fraud detection, indexer, asset validation. Depends on domain + ports only.

**Infrastructure** (`internal/infrastructure/`): Implements ports. Database adapters (PostgreSQL, SQLite, Badger, MongoDB), wallet, signer, scanner, tx-builder, live-store. Converts infra types to domain types.

**Interface** (`internal/interface/`): gRPC/REST handlers, event broker, interceptors. Validates requests, converts proto types to domain types. No business logic.

### Anti-Patterns

```go
// Domain importing infrastructure
package domain
import "github.com/lib/pq"  // VIOLATION

// Returning infrastructure types from ports
func GetRound(ctx, id) (*queries.Round, error)  // VIOLATION

// Business logic in handlers
func (h *handler) RegisterIntent(ctx, req) {
    if time.Now().Unix() > round.EndingTimestamp { ... }  // VIOLATION
}

// Application importing infrastructure directly
package application
import "arkd/infrastructure/db/postgres"  // VIOLATION
```

## Cross-Project Dependencies

```
arkd ──→ go-sdk ──→ ark-faucet, ark-simulator, kms-unlocker
arkd ──→ wallet, arkade-escrow (via @arkade-os/sdk)
```

### Impact Chains

| Change in | Affects |
|-----------|---------|
| Proto definitions (arkd) | go-sdk, ts-sdk, rust-sdk, wallet |
| Database migrations (arkd) | All deployments |
| go-sdk API | ark-faucet, ark-simulator, kms-unlocker |
| ts-sdk API | wallet, arkade-escrow, docs |
| Infrastructure changes | All deployments |

## Breaking Change Detection

### Proto Changes (High Risk)

```bash
git diff main...feature-branch -- api-spec/protobuf/
```

Breaking: removed fields, changed field numbers, changed field types, new required fields.
Safe: new optional fields, new endpoints.

Proto breaking changes require version bump and SDK updates.

### Database Migrations

```bash
git diff main...feature-branch -- internal/infrastructure/db/*/migration/
```

Check: up.sql/down.sql pairs exist, reversibility, data loss potential, index additions.

### SDK API Changes

Any change to exported types, function signatures, or interface definitions in go-sdk or ts-sdk. Check if downstream consumers need updating.

## Review Methodology

For arkd PRs, review in this order:

1. **Proto/API changes first** (define the contract)
2. **Domain layer** (business logic correctness, invariant preservation)
3. **Application layer** (correct port usage, no infra leaks)
4. **Infrastructure layer** (adapter correctness, migrations)
5. **Tests** (coverage of happy paths, edge cases, error conditions)
6. **Cross-project impact** (does this require SDK/wallet/faucet changes?)

## Risk Levels

**Low**: docs, tests, comments, minor same-file refactoring, bug fixes with test coverage.

**Medium**: new features, DB schema changes with migrations, backward-compatible proto additions, cross-file refactoring.

**High**: proto breaking changes, migrations with data loss potential, core algorithm changes, security-related code, architecture changes, major dependency upgrades.

## Testing Strategy by Layer

| Layer | Test Type | Dependencies |
|-------|-----------|-------------|
| Domain | Unit tests | None (pure logic) |
| Application | Unit tests | Mocked ports |
| Infrastructure | Integration tests | Real DB/services |
| Interface | Unit tests | Mocked application service |
