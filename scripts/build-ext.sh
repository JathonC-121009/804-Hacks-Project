#!/usr/bin/env bash
# Builds the extension: compile TypeScript, then copy the config it reads at runtime.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf extension/dist extension/config
npx tsc -p tsconfig.ext.json
mkdir -p extension/config
cp config/sources.json config/models.json extension/config/
echo
echo "Built extension/"
echo "Load it: Chrome > chrome://extensions > Developer mode > Load unpacked > select the extension/ folder"
