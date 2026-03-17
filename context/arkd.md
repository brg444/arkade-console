# arkd (Arkade Protocol Server)

## Architecture

Hexagonal architecture with clear separation:
- **Domain**: Core business logic, VTXO model, round management
- **Application**: Use cases, orchestration
- **Interface**: gRPC and REST handlers
- **Infrastructure**: Database (PostgreSQL, SQLite, Badger), Redis, Bitcoin node integration

## API

gRPC primary, REST via grpc-gateway. Protobuf definitions in `api-spec/protobuf/`.

Key services:
- Round management (batch creation, signing, settlement)
- VTXO lifecycle (creation, spending, sweeping, recovery)
- Admin operations (wallet management, configuration)

## Transaction flow

1. Clients register for a round
2. Server constructs batch transaction with VTXOs
3. MuSig2 cooperative signing
4. Batch transaction broadcast
5. Checkpoint transactions for security

## Key concepts

- **Batch/Round**: Periodic on-chain settlement of off-chain state
- **VTXO**: Virtual Transaction Output, the core unit of value
- **Connector outputs**: Link VTXOs to their batch transaction
- **Forfeit transactions**: Penalty mechanism for double-spend attempts
- **Checkpoint transactions**: Security anchors between rounds
