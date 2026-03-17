# TypeScript SDK (@arkade-os/sdk)

## Architecture

Layered architecture: Wallet > Identity > Provider > Crypto > Storage

- **Wallet**: High-level API. `Wallet.create()` is the main entry point. Handles send/receive, balance, VTXO lifecycle.
- **Identity**: Key management. `MnemonicIdentity` (BIP39 mnemonic + BIP32 derivation), `SeedIdentity`, `SingleKey`, `ReadonlyDescriptorIdentity`.
- **Provider**: Server communication. `RestArkProvider` (arkd API), `RestIndexerProvider` (VTXO queries). Expo variants for React Native.
- **Crypto**: MuSig2 signing, Taproot tree construction, nonce management.
- **Storage**: Pluggable adapters. `InMemoryStorageAdapter` (default), `LocalStorageAdapter`, `IndexedDBStorageAdapter`, `AsyncStorageAdapter`, `FileSystemStorageAdapter`.

## Identity classes

- `MnemonicIdentity.fromMnemonic(phrase, opts)` where opts is `{ isMainnet: boolean }` or `{ descriptor: string }`. Lives in `src/identity/seedIdentity.ts`.
- `SingleKey` for raw private key management. Used in AI agent contexts.
- Mnemonic generation is NOT on MnemonicIdentity. Use `generateMnemonic(wordlist)` from `@scure/bip39`.

## Key API patterns

- `Wallet.create({ identity, arkServerUrl, storage? })` returns a Wallet instance
- `wallet.sendBitcoin({ address, amount, feeRate?, memo? })` where amount is `number` (sats), not bigint
- `wallet.getBalance()` returns `{ total, settled, pending }`
- `wallet.getAddress()` returns the current receiving address
- `VtxoManager` uses `{ enabled?, thresholdMs? }` config. Default threshold is 3 days in milliseconds.

## Integrations

- `@arkade-os/boltz-swap` for Lightning. `ArkadeLightningConfig` has `swapManager?: boolean | SwapManagerConfig`, no `storageProvider`.
- `SendLightningPaymentRequest` is `{ invoice: string }` only. No `maxFeeSats`.

## Platform support

Browser, Node.js, React Native (via Expo providers), Service Workers.

## Build

pnpm workspace, Vitest for tests, ESM + CJS output.
