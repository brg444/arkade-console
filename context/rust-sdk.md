# Rust SDK (ark-rs)

Rust workspace for building Bitcoin wallets with Arkade protocol support. Multi-crate architecture with trait-based abstractions for transport, storage, and key management.

## Crate Map

| Crate | Role |
|-------|------|
| `ark-core` | Core types: ArkAddress, Vtxo, BoardingOutput, ArkNote, batch/round types, server messages |
| `ark-client` | Client library: wallet ops, round participation, balance, coin selection, Boltz swap storage |
| `ark-grpc` | gRPC transport (tonic). ArkServiceClient + IndexerServiceClient |
| `ark-rest` | REST transport (reqwest, OpenAPI-generated). WASM-compatible alternative to gRPC |
| `ark-bdk-wallet` | Concrete OnchainWallet/BoardingWallet/Persistence impl using BDK + Esplora |
| `ark-fees` | Fee estimation via CEL (Common Expression Language) programs from server config |
| `ark-rs` | Top-level re-export crate |

## Key Traits (ark-client)

**`Blockchain`** - Async. Find outpoints, find/broadcast transactions, get fee rate, get tx/output status.

**`OnchainWallet`** - Async. On-chain address, sync, balance (immature/pending/confirmed), PSBT preparation, signing, coin selection.

**`BoardingWallet`** - Sync. Create and store boarding outputs, retrieve stored outputs, sign for public key. Boarding outputs are the on-chain entry point into Arkade (structurally identical to VTXOs: 2-of-2 multisig + CSV timeout).

**`KeyProvider`** - Key derivation and management. Two implementations:
- `StaticKeyProvider`: single keypair, always returns same. Good for testing.
- `Bip32KeyProvider`: HD derivation from Xpriv, supports key discovery with gap limit.

**`Persistence`** - Database trait for boarding outputs. Save/load/lookup by public key.

**`SwapStorage`** - Boltz swap state. Insert/get/update submarine and reverse swaps. In-memory and SQLite implementations.

## Core Types (ark-core)

**`ArkAddress`** - Bech32m-encoded (ark/tark HRP). 65 bytes: 1 version + 32 server pubkey + 32 VTXO taproot key.

**`Vtxo`** - Virtual transaction output. Contains server/owner public keys, TaprootSpendInfo, tapscripts, address, exit_delay, network.

**`BoardingOutput`** - On-chain UTXO gating entry to Arkade. Same structure as Vtxo.

**`ArkNote`** - Bearer token. 32-byte preimage + u32 value, hash-locked taproot.

**`VtxoList`** - Categorized VirtualTxOutPoints: pre_confirmed, confirmed, recoverable, spent.

**`Intent`** - Round participation request: inputs, outputs, fee.

**`TxGraph`** - Complete transaction ancestry for a VTXO.

## Server Messages (ark-core/server.rs)

**`Info`** - Server metadata: signer_pk, dust threshold, exit delays, fees config.

**`StreamEvent`/`RoundEvent`** - Batch state machine events (started, tree signing, finalization).

**`VirtualTxsResponse`** - Indexer response with VTXOs and pagination.

## Client Architecture

```
OfflineClient<B, W, S, K>  (unconnected: transport + refs to blockchain/wallet/keys)
    │
    ▼
Client<B, W, S, K>         (connected: adds server_info + fee_estimator)
```

Generic over: B (Blockchain), W (OnchainWallet+BoardingWallet), S (SwapStorage), K (KeyProvider).

Concrete composition typically: ark-grpc transport, ark-bdk-wallet for on-chain ops, Bip32KeyProvider for keys.

## Balance Model

**Off-chain:** `OffChainBalance` with pre_confirmed (pending round), confirmed (settled), recoverable (expired/swept/dust), total().

**On-chain:** Managed by OnchainWallet impl. BDK Balance: immature, trusted_pending, untrusted_pending, confirmed.

## Round Participation Flow

1. Prepare inputs (VTXOs + boarding outputs)
2. Register intent with server (ephemeral keypair, get payment_id)
3. Generate and send MuSig2 nonces
4. Receive aggregate nonces
5. Compute and send partial signatures
6. Server finalizes, broadcasts settlement transaction

## Fee Estimation

Server provides CEL program strings for four fee categories: intent_offchain_input, intent_onchain_input, intent_offchain_output, intent_onchain_output. Client compiles these into an `Estimator` at connect time and evaluates per-intent fees using variables like amount, inputType, weight, expiry.

## Transport

gRPC (ark-grpc) is the default. REST (ark-rest) is OpenAPI-generated and WASM-compatible. Both expose the same logical interface. Transport is not yet fully pluggable at the top level (TODO in source).

## Development

Requires Rust 1.86+. Proto codegen: `RUSTFLAGS="--cfg genproto" cargo build`. Local dev uses Just + Nigiri for bitcoind + arkd from source.
