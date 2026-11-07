#!/bin/bash
# Pulls the latest main from GitHub into the Pi's copy of the site (the repo is public, no login needed).
# Pages update straight away (files are read on every request); if any function code changed the
# site server is restarted so it loads the new code. Run every 2 minutes by home-dashboard-update.timer.
set -euo pipefail
REPO=/home/matt/solar-hub-site
cd "$REPO"
before=$(runuser -u matt -- git rev-parse HEAD)
runuser -u matt -- git fetch -q origin main
after=$(runuser -u matt -- git rev-parse origin/main)
[ "$before" = "$after" ] && exit 0
runuser -u matt -- git merge -q --ff-only origin/main
echo "updated ${before:0:7} -> ${after:0:7}"
if ! git diff --quiet "$before" "$after" -- solar-hub/netlify pi/site-server/server.mjs; then
  systemctl restart home-dashboard
  echo "functions changed: restarted home-dashboard"
fi
