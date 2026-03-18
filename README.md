# Local

```
cp $PWD/keys/moono.json $PWD/target/deploy/moono-keypair.json

solana-test-validator --reset

export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
export ANCHOR_WALLET=$PWD/keys/deployer.json

./scripts/test.sh ping
./scripts/test.sh initialize_protocol
./scripts/test.sh initialize_asset_pool
./scripts/test.sh set_asset_pool_flags
./scripts/test.sh mock_deposit_to_tick
./scripts/test.sh initialize_tick_page

```