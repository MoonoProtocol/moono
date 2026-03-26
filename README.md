# Local

```
mkdir -p $PWD/target/deploy
cp $PWD/keys/moono.json $PWD/target/deploy/moono-keypair.json
cp $PWD/keys/mock_pump_fun.json $PWD/target/deploy/mock_pump_fun-keypair.json

solana-test-validator --reset

export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
export ANCHOR_WALLET=$PWD/keys/deployer.json

# Protocol controls
./scripts/test.sh set_protocol_paused

# Asset pools
./scripts/test.sh initialize_asset_pool_creates_vault
./scripts/test.sh set_asset_pool_flags

# Tick pages
./scripts/test.sh initialize_tick_page

# LP deposits and withdrawals
./scripts/test.sh deposit_to_tick_transfers_tokens_into_vault
./scripts/test.sh deposit_to_tick_transfers_wsol_into_asset_pool_vault
./scripts/test.sh deposit_to_tick_rejects_wrong_tick_page
./scripts/test.sh deposit_to_tick_fails_when_protocol_is_paused
./scripts/test.sh withdraw_from_tick_transfers_tokens_back_to_user
./scripts/test.sh withdraw_from_tick_transfers_wsol_back_to_user

# Execution strategy config
./scripts/test.sh initialize_execution_strategy_config
./scripts/test.sh set_execution_strategy_config

# Loan opening and funding
./scripts/test.sh open_loan_creates_loan_vaults_and_collects_buffer_and_upfront_charges
./scripts/test.sh fund_loan_from_ticks_moves_principal_to_loan_quote_vault
./scripts/test.sh fund_loan_from_ticks_rejects_slice_count_mismatch
./scripts/test.sh fund_loan_from_ticks_rejects_principal_mismatch
./scripts/test.sh fund_loan_from_ticks_rejects_protocol_fee_mismatch
./scripts/test.sh fund_loan_from_ticks_rejects_upfront_interest_mismatch

# Pump.fun execution
./scripts/test.sh execute_launch_pump_fun_moves_quote_and_splits_base_output
./scripts/test.sh open_fund_execute_launch_pump_fun_is_atomic
./scripts/test.sh open_fund_execute_launch_pump_fun_is_atomic_without_extra_buy
./scripts/test.sh execute_launch_pump_fun_delivers_base_to_user_for_extra_buy
./scripts/test.sh execute_launch_pump_fun_rejects_non_wsol_quote_pool
./scripts/test.sh execute_launch_pump_fun_rejects_slippage_exceeded

```
