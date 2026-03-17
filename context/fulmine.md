# Fulmine

Lightning-Arkade swap daemon. Manages VHTLCs, Boltz swaps, delegate tasks, and wallet operations. Enables trustless Lightning payments from Arkade wallets via submarine and reverse swaps.

Source: `ArkLabsHQ/fulmine` | Language: Go | Architecture: hexagonal (same pattern as arkd)

## What Fulmine Does

Fulmine sits between an Arkade wallet and the Lightning Network. It:
- Creates VHTLCs (Virtual Hash Time-Locked Contracts) for atomic swaps
- Manages submarine swaps (Arkade to Lightning) and reverse swaps (Lightning to Arkade)
- Handles delegate tasks for automated VTXO management
- Runs as a daemon with gRPC/REST interface

## Key Packages

| Package | Purpose |
|---------|---------|
| `pkg/vhtlc/` | VHTLC script construction, spending paths, validation |
| `pkg/swap/` | SwapHandler: ClaimVHTLC, RefundSwap, SettleVHTLC |
| `pkg/boltz/` | Boltz backend client for swap coordination |
| `internal/core/` | Domain logic, application services |
| `internal/infrastructure/` | DB adapters, wallet, external services |
| `internal/interface/` | gRPC/REST handlers |

## Database Schema

Fulmine uses two SQLite databases in its datadir.

### fulmine.db (Application DB)

**swap** - Swap records
| Column | Type | Notes |
|--------|------|-------|
| id | PK | |
| amount | int | Sats |
| timestamp | int | Unix |
| to_currency, from_currency | text | |
| status | int | 0=pending, 1=completed, 2=failed |
| invoice | text | Lightning invoice |
| funding_tx_id, redeem_tx_id | text | |
| vhtlc_id | FK | References vhtlc table |
| swap_type | int | 0=submarine, 1=reverse |

**vhtlc** - Virtual HTLC records
| Column | Type | Notes |
|--------|------|-------|
| id | PK | |
| preimage_hash | blob | 20 bytes (hash160) |
| sender, receiver, server | blob | Pubkeys |
| refund_locktime | int | CLTV |
| unilateral_*_delay_type/value | int | CSV delays per path |

**delegate_task** - Scheduled delegation tasks
| Column | Type | Notes |
|--------|------|-------|
| id | PK | |
| intent_txid, intent_message, intent_proof | text | |
| fee | int | |
| delegator_public_key | text | |
| scheduled_at | int | Unix |
| status | int | 0=pending, 1=processing, 2=completed, 3=failed |
| fail_reason | text | |
| commitment_txid | text | |

**delegate_task_input** - Inputs for delegate tasks
| Column | Notes |
|--------|-------|
| task_id | FK to delegate_task |
| outpoint | txid:vout |
| forfeit_tx | Signed forfeit |

**settings** - App config (single row)

Columns: api_root, server_url, esplora_url, currency, event_server, ln_url, ln_type (0=none, 1=lnd, 2=cln)

### sqlite.db (Wallet/SDK DB)

**vtxo** - Wallet VTXOs
| Column | Type | Notes |
|--------|------|-------|
| txid + vout | PK | |
| script | text | pkScript hex |
| amount | int | Sats |
| commitment_txids | text | JSON array |
| spent | bool | |
| expires_at | int | Unix |
| preconfirmed, swept, unrolled | bool | |
| spent_by, settled_by, ark_txid | text | |

**tx** - Transaction history
| Column | Notes |
|--------|-------|
| txid | PK |
| type | "boarding", "send", "receive", "settle" |
| amount | Sats |
| settled | bool |

**utxo** - On-chain UTXOs
| Column | Notes |
|--------|-------|
| txid + vout | PK |
| amount | Sats |
| spendable_at | Unix timestamp |
| delay_value, delay_type | CSV params |

## Diagnostic Queries

```sql
-- Failed swaps
SELECT id, amount, datetime(timestamp,'unixepoch') as ts, status, invoice
FROM swap WHERE status=2 ORDER BY timestamp DESC LIMIT 20;

-- Stuck pending swaps
SELECT id, amount, datetime(timestamp,'unixepoch') as ts, invoice
FROM swap WHERE status=0 ORDER BY timestamp DESC;

-- Failed delegate tasks with reason
SELECT id, intent_txid, fail_reason, datetime(scheduled_at,'unixepoch')
FROM delegate_task WHERE status=3 ORDER BY scheduled_at DESC LIMIT 20;

-- Wallet balance (unspent VTXOs)
SELECT COUNT(*) as count, SUM(amount) as total_sats
FROM vtxo WHERE spent=0 AND swept=0;

-- Expired unswept VTXOs (need attention)
SELECT txid, vout, amount, datetime(expires_at,'unixepoch') as expires
FROM vtxo WHERE expires_at < strftime('%s','now') AND spent=0 AND swept=0;

-- Recent transactions
SELECT txid, type, amount, settled, datetime(created_at,'unixepoch')
FROM tx ORDER BY created_at DESC LIMIT 20;

-- On-chain UTXOs
SELECT txid, vout, amount, datetime(spendable_at,'unixepoch') as spendable
FROM utxo WHERE spent=0 ORDER BY amount DESC;
```

## Debugging Workflow

1. Check logs for errors (grep for swap IDs, outpoints, or "error"/"panic")
2. Query the relevant DB table filtered by time or ID from logs
3. If an outpoint/txid is mentioned, use `noa` CLI + Ark Indexer to inspect protocol state (see noa-cli context doc)
4. Check on-chain confirmation status via block explorer API
5. Cross-reference delegate_task.fail_reason with log errors for delegate failures
