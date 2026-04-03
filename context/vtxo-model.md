# VTXO Domain Model

Protocol-level reference for Virtual Transaction Outputs in Arkade.

## What is a VTXO

A VTXO is an off-chain output representing a user's balance. Backed by an on-chain commitment transaction, it has an expiration time and can be spent off-chain (fast, cooperative) or on-chain (unilateral exit after timeout).

## Script Structure

```
Taproot Output
├── Key path: Unspendable (NUMS point)
└── Script tree:
    ├── Leaf 0 (Forfeit): Owner + Server multisig
    └── Leaf 1 (Exit): Owner after CSV delay
```

- **Forfeit path**: Owner and server sign together (collaborative spend)
- **Exit path**: Owner alone after timeout (unilateral exit, no server needed)

## Six States

| State | Description |
|-------|-------------|
| **Created** | Exists but not yet in a settled round |
| **Preconfirmed** | Created in a round, commitment tx not yet mined |
| **Settled** | Commitment tx confirmed on-chain |
| **Spent** | Used as input to another Arkade transaction (via forfeit) |
| **Swept** | Server reclaimed after expiration |
| **Unrolled** | User performed unilateral exit on-chain |

```
User Intent → Round Registration → Tree Construction
                                         │
                                    PRECONFIRMED
                                    (commitment in mempool)
                                         │
                                    commitment confirmed
                                         │
                                      SETTLED
                                    (on-chain, spendable)
                                    /     |     \
                                SPENT  UNROLLED  SWEPT
                              (forfeit) (exit)  (server reclaim)
```

## VTXO vs Note

- **VTXO**: Has a commitment chain (tree path back to root). Requires forfeit tx when spent.
- **Note (ArkNote)**: Direct output, no commitment chain, no forfeit needed. Simpler spending.

Distinguishing: `IsNote() = len(CommitmentTxids) == 0 && RootCommitmentTxid == ""`

## Server-Side Model (Go, arkd)

```go
type Vtxo struct {
    Outpoint                      // Txid:VOut
    Amount             uint64     // Satoshi value
    PubKey             string     // Owner taproot key (hex, x-only 32 bytes)
    CommitmentTxids    []string   // Chain of commitment txids to root
    RootCommitmentTxid string     // First commitment in chain
    SettledBy          string     // Commitment txid that settled this
    SpentBy            string     // Forfeit/checkpoint txid
    ArkTxid            string     // Arkade TX that consumed this
    Spent, Unrolled, Swept, Preconfirmed bool
    ExpiresAt          int64      // Unix timestamp
    CreatedAt          int64      // Unix timestamp
}
```

Source: `internal/core/domain/vtxo.go`

## Client-Side Model (Go SDK)

```go
type Vtxo struct {
    Outpoint
    Script          string     // Hex-encoded VTXO script
    Amount          uint64
    CommitmentTxids []string
    ExpiresAt       time.Time  // Note: time.Time, not int64
    CreatedAt       time.Time
    Preconfirmed, Swept, Unrolled, Spent bool
    SpentBy, SettledBy, ArkTxid string
}
```

Source: `types/types.go`

## Spending Rules

| Condition | Spending Path |
|-----------|--------------|
| Note (no commitment chain) | Direct spend, no forfeit |
| Normal VTXO | Forfeit path (cooperative, owner + server) |
| Swept VTXO (not spent) | Recoverable via unilateral exit (wait for CSV delay) |
| Expired VTXO | Must be refreshed in a new round |

```go
func (v Vtxo) RequiresForfeit() bool { return !v.Swept && !v.IsNote() }
func (v Vtxo) IsSettled() bool       { return v.SettledBy != "" }
func (v Vtxo) IsRecoverable() bool   { return v.Swept && !v.Spent }
```

## Expiration

VTXOs expire based on their round's `VtxoTreeExpiration`: `expiresAt = round.EndingTimestamp + round.VtxoTreeExpiration`. Always check before spending. Expired VTXOs need refresh (participation in a new round).

## Client-Side Events

```go
const (
    VtxosAdded   VtxoEventType = iota
    VtxosSpent
    VtxosUpdated
)
```

## Edge Cases

1. **Preconfirmed != secure.** Don't treat preconfirmed VTXOs as fully settled.
2. **Commitment chain must be valid.** All txids in the chain must resolve for the VTXO to be spendable.
3. **PubKey format differs.** Server stores hex x-only (32 bytes). Client stores full script.
4. **Timestamps.** Server uses `int64` (Unix UTC). Client uses `time.Time`.
5. **Swept but recoverable.** If swept and not spent, user can still claim via unilateral exit after CSV delay.
6. **Concurrent updates.** VTXOs can be updated from multiple sources (rounds, sweeps, settlements).
