#!/bin/bash
# One-off install of the Home Dashboard on the Pi (run as matt, uses sudo). Safe to run again.
#   1. Node (Debian package) and a read-only clone of the public GitHub repo in ~/solar-hub-site
#   2. home-dashboard.service (the site on 127.0.0.1:8100) and the 2-minute GitHub pull timer
#   3. Tailscale Funnel on port 10000 -> the site. The existing funnels (443 -> iZone bridge,
#      8443 -> bird call audio server) are left as they are.
# Keys go in ~/solar-hub-site.env via fill-env.sh, which Matt runs himself.
set -euo pipefail
command -v node >/dev/null || sudo apt-get install -y nodejs
node -e 'if (+process.versions.node.split(".")[0] < 18) { console.error("Node 18+ needed"); process.exit(1) }'
[ -d ~/solar-hub-site/.git ] || git clone -q https://github.com/mrmattsheumack/solar-hub.git ~/solar-hub-site
git -C ~/solar-hub-site pull -q --ff-only
[ -f ~/solar-hub-site.env ] || { printf "PORT='8100'\nBRIDGE_URL='http://127.0.0.1:8080'\n" > ~/solar-hub-site.env; chmod 600 ~/solar-hub-site.env; }
mkdir -p ~/solar-hub-site-data
D=~/solar-hub-site/pi/site-server
sudo cp "$D/home-dashboard.service" "$D/home-dashboard-update.service" "$D/home-dashboard-update.timer" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now home-dashboard.service home-dashboard-update.timer
sudo tailscale funnel --bg --https=10000 http://127.0.0.1:8100
sleep 2
curl -s -o /dev/null -w "local site: HTTP %{http_code}\n" http://127.0.0.1:8100/
sudo tailscale funnel status
