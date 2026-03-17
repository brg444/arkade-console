# VHTLC (Virtual Hash Time-Locked Contract)

VHTLCs enable trustless Lightning-Arkade atomic swaps. They create virtual UTXOs with hash-locked and time-locked spending conditions, forming the bridge between Lightning Network and Arkade.

## Participants

- **Sender**: Locks funds in the VHTLC
- **Receiver**: Claims with preimage knowledge
- **Server**: Co-signs collaborative paths (operator)

## Script Structure

```go
type VHTLCScript struct {
    Sender, Receiver, Server  *btcec.PublicKey

    // Collaborative paths (require server co-signature)
    ClaimClosure                           // Receiver + Server + Preimage
    RefundClosure                          // Sender + Receiver + Server
    RefundWithoutReceiverClosure           // Sender + Server + CLTV

    // Unilateral exit paths (no server needed, after timelock)
    UnilateralClaimClosure                 // Receiver + Preimage + CSV
    UnilateralRefundClosure                // Sender + Receiver + CSV
    UnilateralRefundWithoutReceiverClosure // Sender only + longest CSV
}
```

## Six Spending Paths

### Collaborative (off-chain, fast)

| Path | Keys | Condition |
|------|------|-----------|
| **Claim** | Receiver + Server + Preimage | Immediate |
| **Refund** | Sender + Receiver + Server | Immediate (mutual agreement) |
| **RefundWithoutReceiver** | Sender + Server | After CLTV locktime |

### Unilateral Exit (on-chain, after delay)

| Path | Keys | Condition |
|------|------|-----------|
| **UnilateralClaim** | Receiver + Preimage | After CSV delay |
| **UnilateralRefund** | Sender + Receiver | After CSV delay |
| **UnilateralRefundWithoutReceiver** | Sender only | After longest CSV delay |

## Cryptographic Constraints

**Preimage hash**: Must be 20 bytes. `RIPEMD160(SHA256(preimage))` for Lightning compatibility.

```go
// Preimage condition script: OP_HASH160 <20-byte-hash> OP_EQUAL
const hash160Len = 20
```

**Timelocks**: Minimum 512 seconds, must be multiples of 512 seconds.

```go
const (
    minSecondsTimelock      = 512
    secondsTimelockMultiple = 512
)
```

**Timelock ordering**: `UnilateralRefundWithoutReceiverDelay` must be the longest (last resort for sender).

## Configuration

```go
type Opts struct {
    Sender, Receiver, Server             *btcec.PublicKey
    PreimageHash                         []byte              // 20 bytes (hash160)
    RefundLocktime                       AbsoluteLocktime    // CLTV for collaborative refund
    UnilateralClaimDelay                 RelativeLocktime    // CSV for receiver exit
    UnilateralRefundDelay                RelativeLocktime    // CSV for mutual exit
    UnilateralRefundWithoutReceiverDelay RelativeLocktime    // CSV for sender-only exit
}
```

## Swap Patterns

### Submarine Swap (send to Lightning)

Fulmine is **sender** (locks funds), Boltz is **receiver** (claims with preimage after paying the Lightning invoice).

```go
opts := vhtlc.Opts{
    Sender:       fulminePubkey,
    Receiver:     boltzClaimPubkey,
    Server:       aspPubkey,
    PreimageHash: invoicePaymentHash,
}
```

### Reverse Swap (receive from Lightning)

Boltz is **sender** (locks funds), Fulmine is **receiver** (claims with preimage it generated).

```go
opts := vhtlc.Opts{
    Sender:       boltzRefundPubkey,
    Receiver:     fulminePubkey,
    Server:       aspPubkey,
    PreimageHash: preimageHash,  // Fulmine knows the preimage
}
```

## Claiming and Refunding

**Off-chain claim**: Build Arkade TX with preimage in witness, submit to server for co-signing. If the VTXO is recoverable (swept but claimable), falls back to batch settlement claim.

**Batch settlement claim/refund**: Register intent with server, join a round, coordinator handles MuSig2 signing.

**Collaborative refund with receiver**: Boltz co-signs the refund (used when swap fails after VHTLC is created).

## Key Counts Per Closure

| Closure | Expected Pubkeys |
|---------|-----------------|
| Claim | 2 (Receiver + Server) |
| Refund | 3 (Sender + Receiver + Server) |
| RefundWithoutReceiver | 2 (Sender + Server) |
| UnilateralClaim | 1 (Receiver) |
| UnilateralRefund | 2 (Sender + Receiver) |
| UnilateralRefundWithoutReceiver | 1 (Sender) |

## VHTLC Identity

```go
// ID = SHA256(preimageHash || sender || receiver)
func GetVhtlcId(preimageHash, sender, receiver []byte) string
```

## Key Files

| File | Contents |
|------|----------|
| `pkg/vhtlc/vhtlc.go` | Core script construction |
| `pkg/vhtlc/opts.go` | Options and closure builders |
| `pkg/vhtlc/utils.go` | Validation, parsing, preimage condition script |
| `internal/core/domain/vhtlc.go` | Domain model and repository interface |
| `pkg/swap/swap.go` | SwapHandler: ClaimVHTLC, RefundSwap, SettleVHTLC |

## Security

1. Never reveal preimage until funds are secured in the VHTLC
2. Timelock ordering prevents sender from claiming before receiver has a chance
3. RIPEMD160(SHA256()) for hash160 compatibility with Lightning payment hashes
4. Collaborative paths require server liveness; unilateral paths are the fallback
