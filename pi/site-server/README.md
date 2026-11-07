# Home Dashboard on the Pi

Since 7 Nov 2026 the dashboard is served from eaglecam instead of Netlify. Netlify's free plan
(300 credits a month) was being used up by function time (the dashboard polls about 10,000 function
calls a day, each waiting 1 to 2 s on the Pi, SEMS or Ecowitt) and by every push (15 credits each),
so Netlify paused the site.

Address: **https://eaglecam.taile03fa1.ts.net:10000** (Tailscale Funnel, public HTTPS, like the bridge).

## How it works

- `server.mjs` (Node, no packages) serves `solar-hub/public` and runs the unchanged functions in
  `solar-hub/netlify/functions` at the same `/.netlify/functions/<name>` paths, so the pages didn't change.
- Responses marked `public, max-age=N` are cached for N seconds and identical requests in flight share
  one call, as Netlify's CDN did.
- `climate-control` runs every 5 minutes, as its schedule says.
- The climate settings, state and log are files in `~/solar-hub-site-data/climate/` (see `netlify/blobs.mjs`).
- Functions reach the bridge on `http://127.0.0.1:8080` directly instead of going out and back through the funnel.

## Updating

Push to `main` on GitHub as before. `home-dashboard-update.timer` pulls every 2 minutes. Pages change
straight away; if anything under `solar-hub/netlify` changed, the server restarts.

## Keys

`~/solar-hub-site.env` (mode 600), filled by `fill-env.sh`, which Matt runs on the Pi:
`bash ~/solar-hub-site/pi/site-server/fill-env.sh`. Same names as the Netlify environment variables.
`BRIDGE_TOKEN` is copied from the iZone bridge service. Paste `GOOGLE_SA_KEY` as one line, or use
`GOOGLE_SA_EMAIL` + `GOOGLE_SA_PRIVATE_KEY` (with `\n` for line breaks).

## Commands

    systemctl status home-dashboard            # running?
    journalctl -u home-dashboard -n 50         # recent log (slow or failed functions are logged)
    sudo systemctl restart home-dashboard
    systemctl list-timers home-dashboard-update.timer
    sudo journalctl -u home-dashboard-update -n 20
    sudo tailscale funnel status               # 443 bridge, 8443 bird audio, 10000 dashboard

## Undo

    sudo systemctl disable --now home-dashboard home-dashboard-update.timer
    sudo tailscale funnel --https=10000 off
