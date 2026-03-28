# Solar Hub 🌞

Real-time solar monitoring dashboard combining GoodWe SEMS+, Ecowitt weather station, and Open-Meteo solar forecast — with browser push notifications for excess generation and unexpected grid import.

## What it does

- **Live power flows** — PV generation, grid export/import, home consumption, battery SOC
- **Daily totals** — kWh generated, exported, imported, consumed
- **Ecowitt weather** — temperature, humidity, wind, rain, solar irradiance
- **Hourly solar forecast** — GHI chart + 7-day outlook from Open-Meteo
- **Smart alerts**:
  - ☀️ Exporting >3kW to grid for 10+ min → push notification (plug in EV / run appliances)
  - 🔴 Importing >3kW from grid for 10+ min during daylight → push notification
- **Auto-refresh** every 60 seconds

## Setup

### 1. Clone and deploy to Netlify

```bash
git init
git add .
git commit -m "Initial Solar Hub"
# Create a new site on Netlify, connect this repo
```

Or drag-and-drop the folder into Netlify's UI.

### 2. Set environment variables in Netlify

Go to **Site Settings → Environment Variables** and add:

| Variable | Value |
|---|---|
| `SEMS_EMAIL` | jasminka.sterjovski@gmail.com |
| `SEMS_PASSWORD` | *(your semsplus.goodwe.com password)* |
| `ECOWITT_API_KEY` | *(your Ecowitt API key from api.ecowitt.net — the user key, not the application key)* |

> ⚠️ The `APPLICATION_KEY` (d4d54185...) and `MAC` are already baked into the ecowitt.js function. The `ECOWITT_API_KEY` is your personal user API key — different from the application key. Get it from api.ecowitt.net → My Profile → API Key.

### 3. Redeploy

After setting env vars, trigger a redeploy. The Netlify functions will pick them up automatically.

### 4. Enable push notifications

Open the deployed site → Alerts tab → click **Enable Notifications** → Allow.

## Architecture

```
Browser (index.html)
  ├── /.netlify/functions/sems      → GoodWe SEMS+ API (authenticated)
  ├── /.netlify/functions/ecowitt   → Ecowitt cloud API v3
  └── /.netlify/functions/forecast  → Open-Meteo (no key needed)
```

All three functions run as Netlify serverless functions, keeping credentials server-side.

## Hardcoded config

- **Station ID**: `f04ed04f-8f02-4eda-9fc9-03c68fab7ad2`
- **Ecowitt MAC**: `8C:4F:00:4F:FC:E2`
- **Location**: Dromana / Mornington Peninsula (-38.33, 144.97)
- **Alert threshold**: 3kW for 10 minutes
- **Alert cooldown**: 30 minutes between repeated alerts
- **Import alert window**: sunrise+1h → sunset-1h only

## Upgrading to EV charging automation

When you replace the EVSE4280 with an OCPP-capable charger (Zappi, EVNEX E2, etc.):
- Add a `/.netlify/functions/charger` proxy
- Wire the export alert to call it automatically
- The alert logic in `checkAlerts()` is already the right place to hook this in

## Local dev

```bash
npm install
netlify dev
```

Requires Netlify CLI and environment variables set locally in `.env`:
```
SEMS_EMAIL=jasminka.sterjovski@gmail.com
SEMS_PASSWORD=yourpassword
ECOWITT_API_KEY=youruserkey
```
