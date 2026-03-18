# Arkade Assets (V1 Spec)

UTXO-native asset system for fungible and non-fungible tokens on Bitcoin/Arkade.
Inspired by Runes and Liquid Assets.

## Hybrid System Architecture

Arkade Assets are designed to operate in a hybrid environment, with assets moving seamlessly between off-chain Arkade transactions and on-chain Bitcoin transactions. This architecture imposes a critical requirement: a unified view of the asset state.

- The **Arkade Signer** must be aware of on-chain events. To validate transactions that interact with on-chain assets (e.g., after a unilateral exit or collaborative-exit), the Signer must have access to the state of the Bitcoin blockchain. It effectively acts as a private indexer for the user.
- The **Arkade Indexer** must be aware of Arkade-native transactions. To present a complete and accurate public ledger of assets, the indexer must be able to ingest and validate state transitions that occur within the Arkade system, by observing all relevant Arkade-native transactions.

**NB:** Currently, Arkade Assets can only be used off-chain. Mainnet functionality is planned but not live.

## Asset IDs

Assets are identified by an Asset ID, which is always a pair: `AssetId: (genesis_txid, group_index)`

- `genesis_txid` = the transaction where the asset was first minted
- `group_index` = the index of the asset group inside that genesis transaction

There are two cases when issuing assets:
- **Fresh mint**. If an Asset Group omits its Asset ID, it creates a new asset. Its Asset ID is `(this_txid, group_index)`, where `this_txid` is the current transaction hash. Since this is the genesis transaction for that asset, `this_txid = genesis_txid`.
- **Reissuance of existing asset**. If the Asset Group specifies an Asset ID, it refers back to an already minted asset's `genesis_txid` and `group_index`.

## Control Assets

- Optional: set at genesis to allow future reissuance
- If `Σout > Σin`, the control asset MUST appear in the same tx.
- No control asset at genesis = supply permanently capped.
- Control is **not transitive** — only direct control asset required.
- Burning the control asset permanently locks supply.

## Metadata

- Key-value map, set at genesis, **immutable**.
- Well-known keys: `name`, `ticker`, `decimals` (no fixed standard yet, any key valid).
- `metadataHash` = Merkle root (BIP-341-aligned tagged hash tree).
  - Leaf: `tagged_hash("ArkadeAssetLeaf", leaf_version || varuint(len(key)) || key || varuint(len(value)) || value)`
  - Branch: `tagged_hash("ArkadeAssetBranch", min(left,right) || max(left,right))` (lex-sorted children)

## Implicit Burn

If a tx spends asset UTXOs but has **no** OP_RETURN with an asset packet → balances are **irrecoverably burned**.

## Intent / Batch Swap Flow
```
Old Asset VTXO → [Intent TX] → [Commitment TX] → New Asset VTXOs
```

- **Intent TX**: LOCAL inputs spend old VTXO assets; outputs lock assets for the batch; BIP322-signed message specifies VTXO vs collaborative-exit destinations.
- **Commitment TX**: INTENT inputs claim pending intents; output packets placed in commitment tx (for coll. exits) or in each batch leaf (for new VTXOs).
- Intent lifecycle: Submitted → Included in batch → (or) Dropped (assets unlocked).

## Validation Rules
- `AssetId` present → must reference valid genesis (txid + gidx).
- `Metadata` present → `AssetId` must be absent (genesis only).
- `ControlAsset` present → genesis-only; must reference valid existing asset or valid group index ≠ self.
- All amounts **> 0** (zero amount = INVALID).
- LOCAL input amounts must match actual VTXO balances.
- INTENT input amounts must match referenced intent output balances.
- Output indices must reference valid VTXOs (no out-of-bounds).
- `Σout ≤ Σin` unless control asset present in same tx.
- Forfeit transactions **do not require** an Arkade Asset packet
- A forfeit transaction without an asset packet **does not burn assets**
- Forfeits are operator defense mechanisms, not user-initiated asset transfers
