#!/bin/bash

export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ANCHOR_WALLET=$PWD/keys/deployer.json

cp $PWD/keys/moono.json $PWD/target/deploy/moono-keypair.json

anchor build -p moono
anchor deploy -p moono --provider.cluster devnet

anchor idl upgrade \
  --filepath target/idl/moono.json \
  --provider.cluster devnet \
  --provider.wallet ./keys/deployer.json \
  moonoL26kRC8S49yPuuopKhbNhvgf2h4Dva91noD8rN
