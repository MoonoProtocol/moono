# Local

```
cp $PWD/keys/moono.json $PWD/target/deploy/moono-keypair.json

solana-test-validator --reset

export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
export ANCHOR_WALLET=$PWD/keys/deployer.json

./scripts/test.sh initialize_asset_pool_creates_vault
./scripts/test.sh set_protocol_paused
./scripts/test.sh set_asset_pool_flags
./scripts/test.sh initialize_tick_page
./scripts/test.sh deposit_to_tick_transfers_tokens_into_vault
./scripts/test.sh withdraw_from_tick_transfers_tokens_back_to_user
./scripts/test.sh deposit_to_tick_rejects_wrong_tick_page
./scripts/test.sh deposit_to_tick_fails_when_protocol_is_paused
./scripts/test.sh initialize_execution_strategy_config
./scripts/test.sh set_execution_strategy_config
./scripts/test.sh open_loan_transfers_quote_buffer_into_loan_vault

```
