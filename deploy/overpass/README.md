# Self-hosted Overpass API (Texas extract)

Runs `wiktorn/overpass-api` behind Caddy (automatic HTTPS) on a single
Digital Ocean droplet, seeded from the Geofabrik Texas extract and kept
up to date via Geofabrik's diff feed.

## 1. Create the droplet

- Image: "Docker on Ubuntu" from the DO Marketplace (Docker preinstalled),
  or plain Ubuntu 22.04/24.04 + install Docker yourself.
- Size: 2 vCPU / 4GB RAM, 80GB disk is comfortable headroom for Texas
  (the extract itself is a few hundred MB; the imported DB will be a
  handful of GB).
- Region: pick one close to your users (e.g. a US region).

## 2. Point DNS at it

Create an A record, e.g. `overpass.yourdomain.com` -> droplet IP.
Caddy needs this to exist *before* it starts, so it can issue a
Let's Encrypt cert automatically.

## 3. Copy these files to the droplet

```
scp docker-compose.yml Caddyfile root@<droplet-ip>:/opt/overpass/
```

Edit `Caddyfile` on the droplet to use your real domain before starting.

## 4. Start it

```
ssh root@<droplet-ip>
cd /opt/overpass
docker compose up -d
```

First start does a full import (`OVERPASS_MODE=init`) of the Texas
extract — for a state-sized region this should take on the order of
tens of minutes, not hours. Watch it with:

```
docker compose logs -f overpass
```

Once the import finishes, the container automatically switches to
serving queries and polls `OVERPASS_DIFF_URL` on the interval set by
`OVERPASS_UPDATE_SLEEP` (900s = 15 min here) to stay current.

## 5. Verify

```
curl "https://overpass.yourdomain.com/api/interpreter?data=[out:json];node[shop](around:150,32.8167,-96.8329);out;"
```

You should get back a JSON `elements` array (empty or populated,
either is fine — it just needs to respond, not error).

## 6. Wire it into the app

Add the new endpoint to `OVERPASS_ENDPOINTS` in
`src/PriceScanner.tsx`, first in the list so it's tried before the
public mirrors:

```ts
const OVERPASS_ENDPOINTS = [
  'https://overpass.yourdomain.com/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];
```

Keeping the public mirrors as fallback means a droplet outage degrades
gracefully instead of breaking store lookup entirely.

## Notes / gotchas

- **Disk growth**: diffs accumulate over time; if disk usage creeps up
  over months, a periodic fresh `OVERPASS_MODE=init` re-import from a
  current extract is the simplest reset.
- **Backups**: the `overpass_db` volume is just derived OSM data, not
  irreplaceable — a re-import from Geofabrik is the recovery path, so
  a snapshot/backup schedule is optional, not critical.
- **Firewall**: only 80/443 need to be open (DO's default firewall or
  `ufw`); don't expose the Overpass container's port directly.
