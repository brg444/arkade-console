# Round Lifecycle

How arkd processes batches of transactions. Rounds are the core coordination mechanism: they collect user intents, build a VTXO tree, coordinate MuSig2 signing, and broadcast the commitment transaction.

## State Machine

```
[UNDEFINED] → StartRegistration()
    │
    ▼
REGISTRATION
    Accepting user intents, collecting VTXOs/boarding inputs,
    validating proofs of ownership
    │
    ▼ StartFinalization()
FINALIZATION
    Building VTXO tree + commitment tx, MuSig2 tree signing
    with cosigners, collecting forfeit txs, signing + broadcasting
    │
    ▼ EndFinalization()
ENDED
    Commitment tx broadcast, VTXOs created with expiration,
    previous VTXOs marked spent, batch output scheduled for sweep
    │
    └──► Fail() can be called at any stage → FAILED (terminal)
```

Only one round active at a time. Stages are one-way. Failed rounds cannot recover.

## Event Types

| Event | Trigger |
|-------|---------|
| `RoundStarted` | Registration begins |
| `IntentsRegistered` | User intents added |
| `RoundFinalizationStarted` | Tree built, signing begins |
| `RoundFinalized` | Round completed successfully |
| `RoundFailed` | Round aborted |
| `BatchSwept` | Server reclaimed expired batch output |

The Round is event-sourced. All state changes go through events. Rounds can be reconstructed from their event log via `NewRoundFromEvents(events)`.

## Round Domain Model

```go
type Round struct {
    Id                 string
    StartingTimestamp  int64
    EndingTimestamp    int64
    Stage              Stage              // { Code int, Ended bool, Failed bool }
    Intents            map[string]Intent   // User intents by UUID
    CommitmentTxid     string              // On-chain anchor
    CommitmentTx       string              // Transaction hex
    ForfeitTxs         []ForfeitTx         // Collected forfeits
    VtxoTree           tree.FlatTxTree     // VTXO transaction tree
    Connectors         tree.FlatTxTree     // Connector tree
    ConnectorAddress   string
    VtxoTreeExpiration int64               // Seconds until VTXOs expire
    Swept              bool
    SweepTxs           map[string]string
}
```

Source: `arkd/internal/core/domain/round.go`

## Intent Structure

```go
type Intent struct {
    Id        string      // UUID
    Inputs    []Vtxo      // VTXOs being spent
    Receivers []Receiver  // Output destinations
    Proof     string      // Ownership proof (PSBT)
    Message   string      // Signed message
}
```

Intents are validated for proof validity, non-duplicated inputs, and expiration ranges. Total input amount must cover total output amount.

## Finalization Flow (Service Layer)

1. **Build commitment transaction and VTXO tree** from registered intents
2. **Create MuSig2 coordinator session** for tree signing
3. **Generate operator's nonces**, add to coordinator
4. **Broadcast tree-signing-started event** to users
5. **Collect user nonces**, aggregate via coordinator
6. **Broadcast aggregated nonces** back to users
7. **Collect partial signatures** from all participants
8. **Produce signed tree** via coordinator
9. **Collect forfeit transactions** (required for non-note VTXOs)
10. **Sign and broadcast commitment tx**
11. **End finalization**, persist events, schedule batch sweep
12. **Start next round**

## Forfeit Requirements

Non-note, non-swept VTXOs require a forfeit transaction when spent. The forfeit tx ensures the server can reclaim the VTXO's on-chain backing if the user tries to double-spend.

```go
// Round fails if forfeit txs are missing for VTXOs that require them
for _, intent := range r.Intents {
    for _, in := range intent.Inputs {
        if in.RequiresForfeit() {
            return nil, fmt.Errorf("missing list of signed forfeit txs")
        }
    }
}
```

## Batch Sweeping

After a round ends, VTXOs eventually expire. The server sweeps expired batch outputs:

```go
func (r *Round) Sweep(leafVtxos, preconfirmedVtxos []Outpoint, txid, tx string) ([]Event, error)
```

Sweeping can be incremental. The `Swept` flag is set to true only when all leaf VTXOs have been swept (`FullySwept`).

## Expiration

```go
func (r *Round) ExpiryTimestamp() int64 {
    if r.IsEnded() {
        return r.EndingTimestamp + r.VtxoTreeExpiration
    }
    return -1
}
```

## Key Files

| File | Contents |
|------|----------|
| `arkd/internal/core/domain/round.go` | Round entity, stages, state machine |
| `arkd/internal/core/domain/round_event.go` | Event types |
| `arkd/internal/core/domain/intent.go` | Intent entity, validation |
| `arkd/internal/core/application/service.go` | startRound, startFinalization, finalizeRound |
| `arkd/internal/core/ports/cache.go` | CurrentRound, ForfeitTxs cache interfaces |

## Edge Cases

1. **Boarding inputs** are treated differently from VTXOs. They don't require forfeit txs but need their own signatures.
2. **Round timing** uses a `roundTiming` helper for registration, confirmation, and finalization durations. Forfeits have a timeout; if not received in time, the round fails.
3. **Concurrent intents** can be registered during the registration phase. They're keyed by UUID in the Intents map.
4. **Event replay** reconstructs round state. The `on()` method applies events with a `replayed` flag for version tracking.
