#!/bin/bash

export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
export ANCHOR_WALLET=$PWD/keys/deployer.json

anchor build
anchor deploy
yarn ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts
