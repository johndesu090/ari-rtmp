# Ari RTMP

A self-hosted, low-latency **HLS live-streaming platform** with Adaptive Bitrate
(ABR), strict stream-key enforcement, short-lived playback tokens that
**auto-refresh mid-stream**, embed-domain whitelisting, and dynamic
IP-linked watermarks.

- **Ingest:** OBS / any RTMP client → Nginx + `nginx-rtmp-module` (RTMP/RTMPS)
- **Transcode:** FFmpeg ABR ladder (1080p / 720p / 480p) → low-latency HLS
- **Backend:** Node.js (Express) + Prisma + PostgreSQL + Redis
- **Frontend:** Admin dashboard + setup wizard + embeddable `player.html`
- **SSL:** Automatic Let's Encrypt via Certbot (optional, chosen at install)
- **Install:** One interactive command — `sudo bash install.sh`

> Target OS: **Ubuntu 24.04 LTS** (x86_64).

---

## Quick start

```bash
git clone https://github.com/johndesu090/ari-rtmp.git ari-rtmp
cd ari-rtmp
sudo bash install.sh
```

The installer is interactive and will:

1. Install system dependencies (Node.js 20, PostgreSQL, Redis, FFmpeg, build tools).
2. Compile Nginx with `nginx-rtmp-module` into `/usr/local/nginx`.
3. Ask: **"Do you want to configure a domain name with SSL? (y/n)"**
   - **Yes** → prompts for the domain + email, requests a Let's Encrypt
     certificate with Certbot, configures HTTPS/WSS/RTMPS, and installs an
     auto-renewal timer.
   - **No** → falls back to plain HTTP / IP-based operation.
4. Create the PostgreSQL database, write `.env`, run Prisma migrations.
5. Install and start `systemd` services for the app, Nginx, and the transcoder.
6. Print a summary with the admin URL and next steps.

After install, open the site and complete the **setup wizard** to create the
first administrator account. Then log in to the dashboard.

---

## Docker deployment (fast path)

Prefer containers? Everything ships with Docker too — no compiling, no system
packages. Requirements: Docker with the Compose v2 plugin.

### Origin

```bash
git clone https://github.com/johndesu090/ari-rtmp.git ari-rtmp && cd ari-rtmp
./docker/deploy.sh
```

`deploy.sh` prompts for the public URL (and optional domain + SSL), writes a
`.env` with freshly generated secrets, then builds and starts the full stack:

| Service | Purpose | Ports |
|---|---|---|
| `db` | PostgreSQL 16 | internal |
| `redis` | Redis 7 | internal |
| `app` | Node API + dashboard + P2P tracker | internal `:3000` |
| `nginx` | RTMP/RTMPS ingest, ABR→HLS, edge proxy, TLS | `80`, `443`, `1935`, `1936` |

Non-interactive alternative:

```bash
cp .env.docker.example .env     # fill in PUBLIC_BASE_URL + secrets
docker compose up -d --build
```

### Edge / sub-server

```bash
./docker/deploy-edge.sh
```

Prompts for the origin URL, this edge's public URL, and the dashboard
registration token; the container self-registers and starts heartbeating.
Deploy as many edges as you like.

### SSL with Docker

The stack includes a `certbot` service (profile `ssl`):

```bash
# Origin
docker compose run --rm certbot certonly --webroot -w /var/www/certbot \
  -d stream.example.com --email you@example.com --agree-tos --non-interactive
docker compose restart nginx

# Renew (add to host cron)
docker compose run --rm certbot renew && docker compose restart nginx
```

Nginx auto-detects certificates for its `SERVER_NAME` and switches to
HTTPS/WSS/RTMPS on restart.

### Useful commands

```bash
docker compose ps
docker compose logs -f app nginx
docker compose up -d --build     # rebuild after a code change
docker compose down              # stop (volumes are kept)
```

Data lives in named volumes: `db_data`, `redis_data`, `hls`, `letsencrypt`.

---

## How it works

```
 OBS ──RTMP──▶ Nginx (rtmp) ──exec──▶ ffmpeg (ABR ladder) ──▶ /var/www/hls/<key>/
                    │                                              │
              on_publish webhook                                   ▼
                    │                                   Nginx /hls/ (auth_request)
                    ▼                                              │
             Node API ──validates stream key──▶ Postgres/Redis      ▼
                    │                                       player.html (HLS.js)
                    └── token issue / refresh / watermark ─────────┘
```

### Security model

| Control | Where enforced |
|---|---|
| Stream-key validation on ingest | Nginx `on_publish` → `POST /api/rtmp/on_publish` → DB |
| Short-lived playback token | JWT, `TOKEN_TTL_SECONDS` (default 60s) |
| Token auto-refresh | `player.html` refreshes ~before expiry, silently |
| Segment/playlist gating | Nginx `auth_request` → `POST /api/playback/verify` |
| Embed-domain whitelist | Backend authoritative check + client `document.referrer` |
| Dynamic watermark (no IP shown) | Random string stored server-side, linked to IP |
| No fullscreen / inline playback | `player.html` intercepts Fullscreen API, `playsinline` |

The viewer's **real IP never reaches the player**. The player only ever sees a
random watermark token (e.g. `XF39A1`). The dashboard's **Viewer Activity Log**
shows the mapping between watermark ↔ IP.

---

## Peer-to-peer acceleration (SwarmCloud-style)

Ari RTMP includes a built-in **P2P-CDN**: viewers watching the same stream form
a WebRTC swarm and exchange HLS media segments directly, so the origin server
sends far fewer bytes as the audience grows.

- **Signaling tracker** — `src/p2p/tracker.js`, a WebSocket server mounted at
  `/p2p` on the same port as the API. It groups peers into per-stream swarms,
  matches segment holders, relays WebRTC offers/answers/ICE, and aggregates
  bandwidth telemetry.
- **Browser engine** — `public/p2p-engine.js` (`window.AriP2P`). Each viewer
  connects to a few neighbours, asks the swarm for a segment first, and only
  falls back to the server on a miss. Segments are shared over chunked WebRTC
  data channels (16 KiB frames, backpressure-aware).
- **Player integration** — `player.html` uses a custom hls.js loader: media
  segments (`context.type === 'fragment'`) go through the P2P engine; playlists
  always come from the server. The token auto-refresh loop also re-authenticates
  the P2P session (`reauth`).
- **Access control** — a peer must present a valid short-lived **playback
  token** to join a swarm, so P2P reuses the same security model as playback.
- **Dashboard** — the **P2P Tracker** tab shows live swarms, peers online, the
  P2P offload ratio, per-stream P2P vs server bytes, and 30-second snapshot
  history (persisted to the `P2PSnapshot` table).

### Configuration

| Env | Default | Meaning |
|---|---|---|
| `P2P_ENABLED` | `true` | Master on/off switch |
| `P2P_MAX_PEERS` | `5` | WebRTC neighbours per viewer |
| `P2P_MAX_SWARM_PEERS` | `200` | Max peers in one swarm |
| `P2P_SNAPSHOT_SECONDS` | `30` | Dashboard telemetry interval |
| `P2P_ICE_SERVERS` | Google/Twilio STUN | JSON array or comma-separated list |

> **NAT traversal:** the default STUN servers handle most home networks. For
> viewers behind symmetric NAT or corporate firewalls, add a **TURN** server via
> `P2P_ICE_SERVERS` (JSON form). Peers that cannot connect simply fall back to
> the origin server — playback is never interrupted.

The `/p2p` WebSocket is proxied by Nginx with `Upgrade`/`Connection` headers and
buffering disabled (see the Nginx templates).

---

## Edge / sub-servers (multi-origin delivery)

Scale horizontally with **edge relays**. Each edge caches HLS media segments
and serves them to nearby viewers, and the player **load-balances segment
downloads** across every healthy edge — a classic CDN tier on top of P2P.

```
                         ┌──────────── edge1 (cache) ────────────┐
 viewer ── P2P swarm ──▶ │                                       │
        └── LB segments ─┤  nginx: /hls/ → proxy_cache + auth    ├─▶ origin /hls/
                         └──────────── edge2 (cache) ────────────┘
```

**How it works**

- An edge is a lightweight Nginx that reverse-proxies `/hls/` from the origin
  with `proxy_cache` (media segments cached; live playlists always proxied).
- **Every edge request is authorized**: the edge runs `auth_request` against the
  origin's `/api/playback/verify-edge`, so the short-lived playback token is
  validated before any byte is served — including cache hits.
- The origin tracks edges in the `EdgeServer` table with health (heartbeat),
  region, and weight. Edges self-register using a **registration token** from
  the dashboard and then send 30-second heartbeats.
- `/api/playback/authorize` returns a `segmentOrigins` list (origin + healthy
  edges). The player's hls.js loader picks a weighted-random origin per segment
  and **fails over** to the next on error; playlists still come from the origin.

### Adding an edge

1. Dashboard → **Edge Servers** → **Generate / rotate** the registration token.
2. On the new server, clone the repo and run:

   ```bash
   git clone https://github.com/johndesu090/ari-rtmp.git ari-rtmp
   cd ari-rtmp
   sudo bash install-edge.sh
   ```

   It asks for the origin URL, this edge's public URL, name/region, the
   registration token, and whether to enable SSL (Certbot) for the edge domain.
3. The edge appears in the dashboard within ~30s as **healthy** and starts
   receiving traffic. You can also add edges manually (host + weight).

> **Note:** native HLS (Safari/iOS) keeps using the origin for playlists and
> segments (cookie-based auth); multi-origin balancing applies to the hls.js
> path used by Chrome, Firefox, Edge, and Android.

---

## Repository layout

```
ari-rtmp/
├── install.sh                 # interactive one-click installer (origin)
├── install-edge.sh            # edge / sub-server installer
├── docker-compose.yml         # origin stack (db, redis, app, nginx, certbot)
├── docker-compose.edge.yml    # edge relay stack
├── docker/                    # Dockerfiles, entrypoints, deploy.sh, deploy-edge.sh
├── package.json
├── .env.example
├── prisma/schema.prisma       # Admin, Stream, WhitelistedDomain, ViewerSession, P2PSnapshot, EdgeServer, Setting
├── src/
│   ├── server.js              # Express app + P2P tracker attachment
│   ├── config.js
│   ├── lib/                   # prisma, redis, tokens, watermark, edges, settings
│   ├── p2p/tracker.js         # P2P signaling tracker + swarm telemetry
│   ├── middleware/auth.js     # admin JWT cookie auth
│   └── routes/                # setup, auth, streams, whitelist, viewers, rtmp, playback, p2p, edges
├── public/
│   ├── index.html             # landing → setup wizard / login redirect
│   ├── setup.html             # first-run admin creation
│   ├── login.html
│   ├── dashboard.html         # streams, whitelist, viewer log, P2P tracker, edge servers
│   ├── p2p-engine.js          # browser WebRTC swarm engine (window.AriP2P)
│   └── player.html            # HLS player + watermark + refresh + P2P + multi-origin LB
├── nginx/
│   ├── nginx.conf.template        # origin (http, IP fallback)
│   ├── nginx-ssl.conf.template    # origin (https/wss/rtmps)
│   ├── rtmp.conf                  # origin rtmp block + ABR exec
│   ├── edge-http.conf.template    # edge relay (http)
│   └── edge-ssl.conf.template     # edge relay (https)
├── bin/hls-transcode.sh       # ffmpeg ABR → low-latency HLS
├── scripts/
│   ├── certbot-renew.sh       # origin cert renewal
│   └── edge-heartbeat.sh      # edge → origin health reporting
├── systemd/
│   ├── ari-rtmp.service
│   ├── nginx.service
│   ├── ari-edge-heartbeat.service
│   └── ari-edge-heartbeat.timer
└── scripts/certbot-renew.sh
```

---

## Embedding the player

1. In the dashboard, add the domains allowed to embed (e.g. `example.com`).
2. Create a stream and copy its **Stream Key**.
3. Embed:

```html
<iframe
  src="https://stream.example.com/player.html?key=YOUR_STREAM_KEY"
  width="960" height="540"
  frameborder="0"
  allow="autoplay; encrypted-media; picture-in-picture"
  referrerpolicy="strict-origin-when-cross-origin">
</iframe>
```

Playback is refused unless the embedding origin is whitelisted.

---

## Managing the service

```bash
# App (Node API)
sudo systemctl status ari-rtmp
sudo systemctl restart ari-rtmp
sudo journalctl -u ari-rtmp -f

# Nginx (RTMP + HLS + reverse proxy)
sudo systemctl status nginx
sudo /usr/local/nginx/sbin/nginx -t
sudo systemctl reload nginx

# PostgreSQL / Redis
sudo systemctl status postgresql redis-server

# SSL renewal (if domain configured)
sudo systemctl status certbot-renew.timer
sudo certbot renew --dry-run
```

### RTMP ingest

- **Server:** `rtmp://<your-domain-or-ip>/live`
- **Stream key:** the key generated in the dashboard.
- For RTMPS (if SSL configured) use `rtmps://<your-domain>:1936/live`.

### Watching the ABR output

HLS is written to `${HLS_ROOT}/<stream-key>/index.m3u8` (master playlist).
Variants live in `0/`, `1/`, `2/`. Segments are 2s with a 5-segment window for
low latency.

---

## Configuration reference

All runtime configuration lives in `.env` (see `.env.example`):

| Key | Meaning |
|---|---|
| `PUBLIC_BASE_URL` | Public URL, used for building player/HLS URLs |
| `JWT_SECRET` / `SESSION_SECRET` | Signing secrets (generated by installer) |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `TOKEN_TTL_SECONDS` | Playback token lifetime (short) |
| `ADMIN_SESSION_HOURS` | Dashboard session lifetime |
| `HLS_ROOT` | HLS output directory (shared with Nginx) |
| `RTMP_INGEST_URL` | Internal RTMP origin for the transcoder |

---

## API summary

**Public / player**

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/setup/status` | Is an admin configured? |
| `POST` | `/api/setup` | Create first admin (only when unconfigured) |
| `POST` | `/api/auth/login` | Admin login (sets cookie) |
| `POST` | `/api/playback/authorize` | Whitelist + IP check → issue token + watermark |
| `POST` | `/api/playback/refresh` | Rotate token before expiry (keeps watermark) |

**Nginx-internal**

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/rtmp/on_publish` | Stream-key validation on ingest |
| `POST` | `/api/rtmp/on_publish_done` | Mark stream offline |
| `POST` | `/api/playback/verify` | `auth_request` gate for `/hls/` |

**Admin (cookie auth)**

| Method | Path | Purpose |
|---|---|---|
| `GET/POST/PATCH/DELETE` | `/api/streams` | Manage streams & keys |
| `GET/POST/DELETE` | `/api/whitelist` | Manage embed domains |
| `GET` | `/api/viewers` | Watermark ↔ IP activity log |
| `GET` | `/api/p2p/stats` | Live P2P swarm telemetry |
| `GET` | `/api/p2p/history` | Recent P2P snapshot windows |
| `GET` | `/api/p2p/summary` | All-time P2P offload totals |

**P2P (public)**

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/p2p/config` | Whether P2P is enabled + ICE servers |
| `WS`  | `/p2p` | Signaling tracker (join with a playback token) |

**Edges**

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET/POST/PATCH/DELETE` | `/api/edges` | admin | Manage edge servers |
| `GET/POST` | `/api/edges/registration-token` | admin | View / rotate registration token |
| `POST` | `/api/edges/register` | token | Edge self-registration |
| `POST` | `/api/edges/heartbeat` | edge secret | Edge health/load reporting |
| `POST` | `/api/playback/verify-edge` | playback token | Token gate used by edges |

---

## License

MIT.
