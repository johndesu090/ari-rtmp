# AGENTS.md

Guidance for AI agents (and humans) working in this repository.

## Commit & push policy

**Always commit and push every change to `origin/main`.** When a change is done:

1. Run the checks below.
2. `git add -A` and commit with a concise, descriptive message.
3. `git push origin main`.

If the push is rejected because the remote advanced, `git rebase origin/main`
(never force-push) and push again.

## Checks

Run these before committing (CI runs the same plus more):

```bash
npm run check          # static: JSON, inline HTML JS, template placeholders, nginx build flags
npm test               # API integration suite (needs a live PostgreSQL + Redis)
shellcheck -S warning install.sh install-edge.sh bin/*.sh scripts/*.sh docker/*/*.sh
bash -n install.sh bin/hls-transcode.sh scripts/*.sh   # shell syntax
```

Validate Compose files with `docker compose config` or a YAML parser.

CI:

- `.github/workflows/ci.yml` — static checks, API tests (Postgres + Redis
  service containers, Ubuntu 22.04/24.04 × Node 20/22), Docker image builds,
  and a full Compose smoke test.
- `.github/workflows/installers.yml` — runs the real `install.sh` and
  `install-edge.sh` on Ubuntu 22.04 and 24.04 and validates the SSL/RTMPS
  config with `nginx -t`.

## Conventions

- Do **not** add code comments unless asked.
- Match existing patterns: ESM, no build step, Tailwind via CDN, Express +
  Prisma + Redis, vanilla-JS frontend.
- Never commit `.env` or secrets (`.env` is gitignored; `*.example` files are
  templates).
- The bare-metal installers and the Docker entrypoints both render the same
  `nginx/*.template` files and `bin/hls-transcode.sh`; keep them in sync.
- Target OS: Ubuntu 24.04 LTS (22.04 also validated).

## Layout

```
install.sh / install-edge.sh   interactive installers (origin / edge)
docker/                        Dockerfiles, entrypoints, deploy scripts
docker-compose.yml             origin stack (db, redis, app, nginx, certbot)
docker-compose.edge.yml        edge relay stack
prisma/schema.prisma           Admin, Stream, WhitelistedDomain, ViewerSession, P2PSnapshot, EdgeServer, Setting
src/                           Express API (routes, lib, p2p tracker)
public/                        dashboard + player.html + p2p-engine.js
nginx/*.template               origin + edge config templates
bin/hls-transcode.sh           FFmpeg ABR → low-latency HLS
tests/api.test.mjs             API integration suite
.github/workflows/             CI + installer OS-compatibility
```
