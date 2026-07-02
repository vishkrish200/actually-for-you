#!/bin/sh
# Extension build. Cleans dist (stale bundles once masqueraded as the loaded code), then bakes the
# ingest write token (AFY_TOKEN in ../ingest/.env.local — the server reads the same file) into the
# service worker via esbuild --define, so the secret never lives in committed source.
set -e
cd "$(dirname "$0")"
TOKEN=$(grep -s '^AFY_TOKEN=' ../ingest/.env.local | head -1 | cut -d= -f2-)
rm -rf dist && mkdir -p dist
cp -r public/* dist/
npx esbuild src/background/index.ts --bundle --outfile=dist/background.js --format=esm --target=chrome120 --define:__AFY_TOKEN__=\"$TOKEN\"
npx esbuild src/content/index.ts --bundle --outfile=dist/content.js --format=iife --target=chrome120
npx esbuild src/injected/network-hook.ts --bundle --outfile=dist/injected.js --format=iife --target=chrome120
