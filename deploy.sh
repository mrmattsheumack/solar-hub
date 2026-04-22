#!/usr/bin/env bash
# Deploy the Solar Hub site by pushing to GitHub.
# Netlify is connected to mrmattsheumack/solar-hub and auto-builds on push to main.
#
# Usage:   ./deploy.sh            # uses default commit message
#          ./deploy.sh "my msg"   # uses provided commit message
set -euo pipefail

cd "$(dirname "$0")"

if [[ -n "$(git status --porcelain)" ]]; then
  git add -A
  msg="${1:-Deploy $(date '+%Y-%m-%d %H:%M')}"
  git commit -m "$msg"
else
  echo "No local changes to commit."
fi

git push origin HEAD

echo ""
echo "Pushed. Netlify build: https://app.netlify.com/sites/solarhubdromana/deploys"
echo "Live site:            https://solarhubdromana.netlify.app"
