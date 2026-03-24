#!/bin/bash

export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
export ANCHOR_WALLET=$PWD/keys/deployer.json

anchor build
anchor deploy
res=$(yarn ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts --grep $1)
echo "$res"
solana confirm -v $(echo "$res" | grep tx: | cut -d ' ' -f2) --url http://127.0.0.1:8899
