# Arkade Boltz Swap Integration (@arkade-os/boltz-swap)

## Purpose

TypeScript library enabling Lightning Network payments through Arkade wallets via Boltz exchange. Handles submarine swaps, reverse submarine swaps, and chain swaps.

## Architecture

- **SwapManager**: Orchestrates swap lifecycle. WebSocket + polling for status updates.
- **BoltzSwapProvider**: API client for Boltz exchange endpoints.
- **ArkadeChainSwap**: BTC-to-Ark and Ark-to-BTC chain swaps.
- **VHTLC**: Virtual Hash Time Locked Contracts for atomic swap execution.

## Key types

- `SendLightningPaymentRequest`: `{ invoice: string }` only
- `ArkadeLightningConfig`: `{ swapManager?: boolean | SwapManagerConfig }`, no storageProvider field
- `ArkadeChainSwapConfig`: `{ wallet, swapProvider }`

## Integration

Imported as `@arkade-os/boltz-swap`. Used by the wallet PWA and ts-sdk for Lightning functionality.
