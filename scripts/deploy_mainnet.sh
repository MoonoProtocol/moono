#!/bin/bash

export ANCHOR_PROVIDER_URL=https://solana-mainnet.core.chainstack.com/d63da75940218c172de76e69e5a10431
export ANCHOR_WALLET=$PWD/keys/deployer.json

cp $PWD/keys/moono.json $PWD/target/deploy/moono-keypair.json

anchor build -p moono
anchor deploy -p moono --provider.cluster mainnet

anchor idl upgrade \
  --filepath target/idl/moono.json \
  --provider.cluster mainnet \
  --provider.wallet ./keys/deployer.json \
  moonoL26kRC8S49yPuuopKhbNhvgf2h4Dva91noD8rN
