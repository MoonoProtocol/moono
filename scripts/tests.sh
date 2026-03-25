#!/bin/bash

export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
export ANCHOR_WALLET=$PWD/keys/deployer.json
mkdir -p $PWD/target/deploy
cp $PWD/keys/moono.json $PWD/target/deploy/moono-keypair.json
cp $PWD/keys/mock_pump_fun.json $PWD/target/deploy/mock_pump_fun-keypair.json

anchor build
anchor deploy
yarn ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts
