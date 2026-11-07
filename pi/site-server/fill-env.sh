#!/bin/bash
# Run this yourself on the Pi:   bash ~/solar-hub-site/pi/site-server/fill-env.sh
# It asks for each key the dashboard used on Netlify (copy them from Netlify: Project configuration >
# Environment variables) and writes ~/solar-hub-site.env, readable only by you. Press Enter to skip one
# (or to keep what's already there). BRIDGE_TOKEN is copied from the iZone bridge service, so it
# isn't asked for.
set -euo pipefail
F=/home/matt/solar-hub-site.env
touch "$F"; chmod 600 "$F"
get() { grep -E "^$1=" "$F" | head -1 | cut -d= -f2- || true; }
put() {  # key value: replace or add, value written in single quotes
  local k=$1 v=$2 tmp; tmp=$(mktemp); grep -vE "^$k=" "$F" > "$tmp" || true
  printf "%s='%s'\n" "$k" "$v" >> "$tmp"; cat "$tmp" > "$F"; rm -f "$tmp"
}
[ -z "$(get PORT)" ] && put PORT 8100
put BRIDGE_URL http://127.0.0.1:8080
tok=$(sudo systemctl show izone-bridge -p Environment --value | tr ' ' '\n' | sed -n 's/^BEARER_TOKEN=//p')
if [ -z "$tok" ]; then
  envfile=$(sudo systemctl show izone-bridge -p EnvironmentFiles --value | awk '{print $1}')
  [ -n "$envfile" ] && tok=$(sudo sed -n "s/^BEARER_TOKEN=//p" "$envfile" | tr -d "\"'")
fi
if [ -n "$tok" ]; then put BRIDGE_TOKEN "$tok"; echo "BRIDGE_TOKEN copied from the iZone bridge."; else echo "Couldn't find the bridge token; you'll be asked for it."; fi
keys=(SEMS_EMAIL SEMS_PASSWORD ECOWITT_API_KEY HUB_TOKEN FAMILY_CAL_ID GOOGLE_SA_EMAIL GOOGLE_SA_PRIVATE_KEY GOOGLE_SA_KEY)
[ -z "$tok" ] && keys=(BRIDGE_TOKEN "${keys[@]}")
echo "Paste each value and press Enter (input is hidden). Enter on its own skips."
for k in "${keys[@]}"; do
  have=""; [ -n "$(get $k)" ] && have=" (set already, Enter keeps it)"
  read -r -s -p "$k$have: " v; echo
  if [[ "$v" == *"'"* ]]; then echo "  That one has a ' in it, which the file can't hold. Skipped."; continue; fi
  [ -n "$v" ] && put "$k" "$v"
done
echo "Saved to $F. Restarting the dashboard..."
sudo systemctl restart home-dashboard && sleep 2 && systemctl --no-pager -l status home-dashboard | head -5
