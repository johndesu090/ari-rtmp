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
git clone <your-repo-url> ari-rtmp
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

## Repository layout

```
ari-rtmp/
├── install.sh                 # interactive one-click installer
├── package.json
├── .env.example
├── prisma/schema.prisma       # Admin, Stream, WhitelistedDomain, ViewerSession, P2PSnapshot
├── src/
│   ├── server.js              # Express app + P2P tracker attachment
│   ├── config.js
│   ├── lib/                   # prisma, redis, tokens, watermark helpers
│   ├── p2p/tracker.js         # P2P signaling tracker + swarm telemetry
│   ├── middleware/auth.js     # admin JWT cookie auth
│   └── routes/                # setup, auth, streams, whitelist, viewers, rtmp, playback, p2p
├── public/
│   ├── index.html             # landing → setup wizard / login redirect
│   ├── setup.html             # first-run admin creation
│   ├── login.html
│   ├── dashboard.html         # streams, whitelist, viewer/watermark log, P2P tracker
│   ├── p2p-engine.js          # browser WebRTC swarm engine (window.AriP2P)
│   └── player.html            # embeddable HLS player + watermark + refresh + P2P
├── nginx/
│   ├── nginx.conf.template        # base (http, IP fallback)
│   ├── nginx-ssl.conf.template    # https/wss/rtmps
│   └── rtmp.conf                  # rtmp block + ABR exec
├── bin/hls-transcode.sh       # ffmpeg ABR → low-latency HLS
├── systemd/
│   ├── ari-rtmp.service
│   └── nginx.service
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

---

## License

MIT.
