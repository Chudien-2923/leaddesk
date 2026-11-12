#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ ! -f package.json ] || [ ! -d node_modules ]; then
  printf '%s\n' 'Missing prerequisites: package.json and installed Node dependencies are required.' >&2
  exit 1
fi
# A clean clone has no generated Next.js route declarations yet.
npm run typegen
npm run typecheck
npm run lint
npm test
npm run build
