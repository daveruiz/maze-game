#!/usr/bin/env bash
set -e

echo "Building Dad's Nightmare..."

npm install --silent 2>/dev/null
npm run build 2>&1

echo "✅ Build complete! Output in dist/"
