# noa CLI + Ark Indexer API

Developer debugging toolkit for inspecting Arkade primitives on-chain and off-chain.

Source: `github.com/louisinger/noa` | Depends on: `arkd/pkg/ark-lib`

## noa Commands

### address - Decode an Ark address

```bash
noa address <ark_address>
```

Output: version, HRP, signer pubkey, VTXO tapkey, pkScript (hex + asm). Uses `arklib.DecodeAddressV0`.

### script - Decode a Bitcoin script to ASM + Ark closure

```bash
noa script <script_hex>
```

Recognized closure types: MultisigClosure, CLTVMultisigClosure, CSVMultisigClosure, ConditionMultisigClosure, ConditionCSVMultisigClosure.

Note: expects raw tapscript leaf scripts (closure scripts), NOT P2TR pkScripts.

### note fromTxid - Generate a note closure from a txid

```bash
noa note fromTxid <txid_hex>
```

Takes 32-byte txid as preimage hash, creates NoteClosure, derives taproot tapkey and pkScript.

### taptree decode/encode

```bash
noa taptree decode <taptree_hex>    # All leaf scripts + derived pkScript
noa taptree encode <script1> ...    # Encode scripts into a taptree
```

### psbt decode - Decode PSBT with Ark extensions

```bash
noa psbt decode <psbt_base64_or_hex>
```

Auto-detects base64 vs hex. Shows standard PSBT fields plus Ark-specific:
- `ConditionWitness` - witness stack items
- `CosignerPublicKey` - index + schnorr pubkey
- `VtxoTaprootTree` - list of script hex strings
- `VtxoTreeExpiry` - relative locktime type + value

## Ark Indexer REST API

Base URL: configurable per environment (default `http://localhost:7070`).

### Commitment TX

```
GET /v1/indexer/commitmentTx/{txid}              # Round info: batches, amounts, timestamps
GET /v1/indexer/commitmentTx/{txid}/forfeitTxs   # Forfeit txids for a commitment
GET /v1/indexer/commitmentTx/{txid}/connectors   # Connector tree nodes
```

### Batch / VTXO Tree

```
GET /v1/indexer/batch/{txid}/{vout}/tree          # Full VTXO tree structure
GET /v1/indexer/batch/{txid}/{vout}/tree/leaves   # Leaf outpoints only
GET /v1/indexer/batch/{txid}/{vout}/sweepTxs      # Sweep txids for this batch
```

### VTXOs

```
GET /v1/indexer/vtxos?outpoints={txid}:{vout}     # Lookup by outpoint
GET /v1/indexer/vtxos?scripts={script_hex}         # Lookup by pkScript
```

Filters: `spendable_only`, `spent_only`, `recoverable_only`, `pending_only`, `after`, `before`.

### VTXO Chain

```
GET /v1/indexer/vtxo/{txid}/{vout}/chain          # Ancestry from tree leaf to this VTXO
```

Each entry: txid, expiresAt, type (COMMITMENT/ARK/TREE/CHECKPOINT), spends (parent txids).

### Virtual Transactions

```
GET /v1/indexer/virtualTx/{txid}                  # Returns PSBT in base64
```

Feed directly to `noa psbt decode`.

### Assets

```
GET /v1/indexer/asset/{asset_id}                  # Asset info (supply, metadata)
```

### Key Response Types

`IndexerVtxo`: outpoint, createdAt, expiresAt, amount, script, isPreconfirmed, isSwept, isUnrolled, isSpent, spentBy, commitmentTxids, settledBy, arkTxid, assets

`IndexerChain`: txid, expiresAt, type (COMMITMENT|ARK|TREE|CHECKPOINT), spends

## Recipe: Investigate a VTXO from Outpoint

Given `{txid}:{vout}`:

**1. Get VTXO metadata**
```bash
curl -s "$INDEXER_URL/v1/indexer/vtxos?outpoints={txid}:{vout}" | jq
```
Note: amount, script, status flags, commitmentTxids.

**2. Get VTXO chain (ancestry)**
```bash
curl -s "$INDEXER_URL/v1/indexer/vtxo/{txid}/{vout}/chain" | jq
```
Identify the commitment txid (type=COMMITMENT).

**3. Inspect commitment round**
```bash
curl -s "$INDEXER_URL/v1/indexer/commitmentTx/{commitment_txid}" | jq
```

**4. Decode the VTXO tree tx**
```bash
VTXO_PSBT=$(curl -s "$INDEXER_URL/v1/indexer/virtualTx/{txid}" | jq -r '.txs[0]')
noa psbt decode "$VTXO_PSBT"
```

**5. Inspect connectors and forfeits**
```bash
curl -s "$INDEXER_URL/v1/indexer/commitmentTx/{commitment_txid}/connectors" | jq
curl -s "$INDEXER_URL/v1/indexer/commitmentTx/{commitment_txid}/forfeitTxs" | jq
```

Forfeit tx structure: input[0] = VTXO, input[1] = connector dust, single server sweep output.

**6. Decode scripts from PSBT outputs**
```bash
noa script <closure_script_hex>
```

## Other Debugging Workflows

- **Inspect a VTXO address**: `noa address <ark_addr>` to get tapkey and pkScript
- **Decode unknown closure**: `noa script <hex>` to identify closure type and keys
- **Verify a note**: `noa note fromTxid <txid>` and compare derived tapkey against on-chain output
- **Debug round PSBT**: `noa psbt decode <base64>` to inspect Ark PSBT fields
