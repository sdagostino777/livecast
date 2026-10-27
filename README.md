# Livecast

<p>
  <a href="https://github.com/sdagostino777/livecast/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/sdagostino777/livecast/actions/workflows/ci.yml/badge.svg?branch=main" /></a>
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2a6cb6" />
  <img alt="Node 22" src="https://img.shields.io/badge/node-22-2a6cb6" />
  <img alt="HLS + audio-only" src="https://img.shields.io/badge/HLS%20%2B%20audio--only-self--hosted-1d7a8c" />
  <img alt="No external services required" src="https://img.shields.io/badge/dependencies-none%20required-4ec3a7" />
</p>

![Livecast — adaptive HLS live audio and video, self-hosted: the panel and the link a viewer opens](docs/screenshots/hero.png)

**Self-hostable live audio/video streaming.** A small team broadcasts from the browser or an external encoder;
the audience gets a shareable link and a player with play and pause. Adaptive
HLS for video, a clean audio-only mode, and a control plane small enough to read
in an afternoon — running on a €8 VPS until the audience justifies a CDN.

Fork it, rename it, set your own name in the panel: nothing here is tied to a
vendor, a domain or an organisation.

Built as the streaming layer for the maintainers events. The driving constraint was not
features: it was *"the transmission must not fall during the event"* — so the
code is organised around failure, not around convenience. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#redundancy-what-holds-when-things-break).

*Every screenshot in this repository is a capture of a real broadcast, taken by
Playwright through a real Chrome instance — no mock-ups.*

<sub>Sharing this repository? The link preview (WhatsApp, LinkedIn, Slack) uses
GitHub's **social preview**: `Settings → General → Social preview` → upload
[`docs/screenshots/social-preview.png`](docs/screenshots/social-preview.png)
(1280×640, under 1 MB). The README banner above is never used by link previews —
those read the page metadata, not the markdown.</sub>

```
 encoder ──RTMP:1935──▶ MediaMTX (ingest, loopback-only readers)
                         │
                         ▼
                    FFmpeg ──▶ 720p / 480p / 360p HLS ──▶ nginx ──▶ Bunny/Cloudflare CDN (optional)
                         │                          │
                    watchdog                        └──▶ player  /live/<slug>
                         │
                Fastify + SQLite (panel, sessions, settings)
```

## Why this and not a managed player

| Decision | Why |
| --- | --- |
| **HLS, not WebRTC** | 4,000 concurrent viewers at 2 Mbps is 8 Gbps; no SFU fits that on one VPS. HLS behind a CDN does, cheaply. "Light delay" (~8–12 s) was the accepted trade. |
| **MediaMTX for ingest only** | It accepts RTMP and enforces the stream key. The video itself is encoded by FFmpeg into a plain directory of files — the easiest thing to inspect, restart, and put behind a CDN. |
| **Play/pause only, on purpose** | A live stream has no timeline to seek. Every extra control is another thing that can be wrong on a phone in a crowd. |
| **No PIN on the link** | By decision: an open transmission. The slug is random and unindexed, which keeps it out of search results without pretending it is access control. |
| **Two kinds of broadcast** | Video (720/480/360 ladder) and audio-only (128 kbps AAC) share the same pipeline; the audio mode drops any video the publisher sends instead of paying for an encoder chain nobody watches. |
| **Users, not just an account** | One admin manages accounts; operators can run broadcasts. The admin account itself cannot be deleted or have its password reset by anyone else. |
| **Event poster** | Each broadcast carries a 16:9 poster — what viewers see before pressing play — uploaded from the panel, with an optional title drawn over it, or generated automatically from the title on a gradient. The install's own logo lives in **Configurazione**, not on the event. |
| **Light / dark / system** | The panel follows a theme preference; the player stays dark on purpose. |
| **Publishing without an encoder** | Camera or screen share straight from the panel over WebRTC (WHIP); an external encoder stays supported for long events. |
| **First-run safety** | The default `admin / admin` account must change its password before the panel does anything else. |
| **SQLite** | One operator, a handful of streams. A database server would be a process to keep alive for no benefit. |

## Quick start (local)

```bash
pnpm install
cp infra/env.example .env          # edit PUBLISH_PASS + MEDIAMTX_READ_* if you run a media server
pnpm dev:api                        # Fastify on :4100, serves the built player if present
pnpm dev:web                        # Vite on :5173, proxying /api and /hls to :4100
```

Create the admin account:

```bash
pnpm cli create-admin --username admin
# prints ADMIN_PASSWORD=... once
```

A full local broadcast also needs a local MediaMTX (ingest) — or simply run the
provisioning below on a VPS. The FFmpeg ladder itself is covered by a smoke
script in [`docs/RUNBOOK.md`](docs/RUNBOOK.md#verifying-the-encoder).

## Install in one command

On an Ubuntu server, as root, from the downloaded ZIP (or `git clone`):

```bash
bash install.sh live.yourdomain.com
```

That is the whole installation: dependencies, media server, encoder, the systemd
units that restart themselves, nginx, free HTTPS, the firewall and the admin
account. Then open `https://live.yourdomain.com/admin`, sign in as
**admin / admin** — the panel forces a new password immediately.

No external encoder is required: the panel can publish from the camera or a shared screen
(WebRTC over WHIP). The page must stay open while publishing; for long events
an external encoder remains the sturdier option and the panel shows its URL.

## Deploy on a VPS

Requirements: Ubuntu LTS, Node.js ≥ 22, nginx + certbot, a DNS **A record** for
the chosen hostname already pointing at the VPS, and SSH key access as root.

```bash
# first install: syncs the source, provisions MediaMTX + systemd + nginx + TLS
bash infra/scripts/deploy.sh --provision

# every release afterwards
bash infra/scripts/deploy.sh
```

Both scripts are idempotent. The deploy prints the generated admin password once
and stores it in `/root/.livecast-credentials` on the server.

Then: open `https://<domain>/admin`, log in, and copy the RTMP URL the panel
shows into **an external encoder → Settings → Stream → Server** (stream key left empty). Create
a broadcast from the panel and press play on `/live/<slug>`.

## The panel in one screen

![The panel while live — green LEDs per publisher, capacity banner, settings](docs/screenshots/admin.png)

- **Diretta** — the only broadcast this install has. The title, the kind (video
  or audio-only) and the poster save themselves: there is no "Salva", the preview
  follows as you type. **● ONLINE** starts it, **■ STOP** ends it, and
  **Nuovo evento** opens the next one with a new link. While on air the panel
  shows the time elapsed and how many player pages are connected right now.
- **Link della diretta** — copyable from the first moment: whoever opens it sees
  the event name and artwork before pressing play, and messaging apps show the
  same preview thanks to the Open Graph tags the server renders for `/live/<slug>`.

![What the viewer gets — the event poster, one play button, nothing else](docs/screenshots/player.png)
- **Tema** — three small icons in the header (light, dark, system), one tap each.
  The player stays dark: video on a bright page is tiring to watch.
- **Impostazioni** (account menu) — **Configurazione** (service name, logo — which
  also becomes the browser tab icon —, public URL, CDN, ingest host/port),
  **Sicurezza** (password, recovery codes), **Utenti** (admin only) and
  **Manutenzione** (kill a stuck broadcast, read the logs).
- **Utenti** (admin only) — create operators, reset their passwords, delete them.
  The admin account row shows "account protetto" and has no actions.
- **CDN** — switching delivery to an edge is a URL and a click inside
  **Configurazione**, no redeploy. "Verifica CDN" probes the live manifest through
  the CDN and reports the cache header it saw. The step-by-step attach procedure
  is [`docs/CDN.md`](docs/CDN.md).

## Make it yours

The name and the logo are configuration, not code: **Configurazione** in the
settings page renames the service everywhere (panel, player, page title, link
previews) and uploads your own square logo, which replaces the generated play
symbol and becomes the browser tab icon. Nothing in the UI says "Livecast" until
you leave it that way.

- **Name** — Configurazione → *Nome del servizio*. It appears in the panel, the
  player and the page title; no rebuild needed.
- **Colours** — the palette lives in `apps/web/src/styles.css` (`:root` tokens).
  The light theme and the dark player are two gradients and a handful of
  variables, not a framework.
- **Install name** — `APP_NAME=yourname bash infra/scripts/deploy.sh --provision`
  sets the service user, directory and systemd units for a fresh server.
- **Repo** — rename it freely; the only files that mention "livecast" are the
  package names, the default `APP_NAME`, and the fallback brand string.

## Password recovery

There is no email dependency and no external identity provider: the install
issues **eight one-time recovery codes** whenever a password is set or reset
(including the first forced change). They are displayed exactly once and stored
only as SHA-256 hashes, so nobody — not even the server administrator — can read
a code back from the database.

- **Lost the password?** Login page → *Password dimenticata?* → username, one
  code, new password. Every session is closed; the code is spent.
- **Remaining codes / new set:** Settings → Sicurezza shows how many are left
  and regenerates them (current password required; the old set stops working).
- **Lost the codes too?** On the server, as the last resort:

  ```bash
  cd /srv/livecast/app
  node --env-file=.env apps/api/dist/cli.js reset-password --username admin --password admin
  ```

  It resets to `admin / admin` (forced change on next login) and prints eight
  fresh codes.

| Layer | What protects it |
| --- | --- |
| Recovery codes | 8 codes × ~50 bits, single use, hashed at rest, regeneration invalidates the previous set |
| Server shell | The true root of trust: whoever holds the VPS can always reset the account, and that is deliberate — a recovery path that does not need the server would be a weaker one |
| Email | Not used. An inbox is an additional attack surface, not a stronger factor |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `4100` / `127.0.0.1` | Fastify listener behind nginx. |
| `DATA_DIR` | `./data` | SQLite database, HLS output, recordings. |
| `PUBLIC_URL` | `http://localhost:4100` | Canonical origin: page links and the Origin check. |
| `INGEST_HOST` / `INGEST_PORT` | host from `PUBLIC_URL` / `1935` | What the encoder connects to (editable at runtime in the panel). |
| `PUBLISH_USER` / `PUBLISH_PASS` | `publisher` / — | Broadcaster credentials shown in the panel, enforced by MediaMTX. |
| `MEDIAMTX_READ_USER` / `_PASS` | — | Loopback credentials FFmpeg uses to read the stream. |
| `COOKIE_SECURE` | `false` in dev, `true` in production | Session cookies over TLS only. |
| `INGEST_WAIT_SECONDS` | `600` | How long a stream waits for a publisher before ending itself. |
| `BRAND_NAME` | `Livecast` | Display name until one is saved in the panel. |

Runtime settings (public URL, CDN, ingest host/port) live in the database,
seeded from `PUBLIC_URL`/`INGEST_*` on first boot and editable from the panel.

## Capacity: when the VPS is enough, and when it is not

| Audience | What you need |
| --- | --- |
| **up to ~500 viewers** | The VPS alone. 500 × ~2 Mbps ≈ 1 Gbps is already the practical limit of one machine's port, so stay comfortably under it. |
| **500 – 50,000** | A CDN pull zone in front of `/hls/*`. The origin then serves each segment once per edge, not once per viewer. Set the CDN URL in the panel and watch the LED turn green. |
| **thousands, one event** | The panel warns when no CDN is configured: it is the one setting that decides whether an event survives its own audience. |

The number is not a promise about one specific VPS: it is the arithmetic
(viewers × bitrate versus the server's network port). The panel shows the live
capacity hint and the CDN state, so the operator never has to remember it.

## What holds when things break

The event-day guarantees are documented as a table in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#redundancy-what-holds-when-things-break),
and the operator runbook (go-live checklist, CDN attach, troubleshooting) is
[`docs/RUNBOOK.md`](docs/RUNBOOK.md). Short version:

| Failure | What recovers it |
| --- | --- |
| The encoder disconnects / laptop sleeps | FFmpeg exits, the supervisor relaunches it in < 3 s, the publisher reconnects when it can |
| Encoder hangs with an open socket | Watchdog: 2 minutes of unchanged segments ⇒ SIGKILL + relaunch, stream stays live |
| Media server crashes | systemd restarts it in 2 s; the broadcast resumes when the encoder reconnects |
| API crashes | systemd restarts it; the player keeps its last segments and the page polls |
| Event-size audience | CDN base URL in the panel — segments are immutable and cache for a year |

## If the server itself dies

No process supervision saves a machine. Losing the VPS means losing the encoder
and the origin at once — the CDN can keep serving the last cached segments for a
few seconds, and then everyone sees "signal unavailable". That is the honest
limit of a single-box install, and it needs a plan, not a promise:

1. **Standby VPS, same code** — provision a second server with the same
   `APP_NAME` and `APP_DOMAIN`, copy `DATA_DIR` (it is one directory) and the
   `.env`, and keep the DNS record at a low TTL (300 s). Re-pointing DNS is the
   whole failover: the same database, credentials and settings come back.
2. **CDN origin failover** — a CDN that supports multiple origins/fallback
   zones can switch to the standby origin without DNS changes.
3. **Publisher-side redundancy** — the primary/backup publish paths cover the
   other half of the equation: if the *encoder* fails, the show continues; if
   the *server* fails, no software on it can. The two failures are independent.

A failover works the same way it always did — the primary publisher disappears,
the backup one is already connected, and the encoder restarts from it in about
three seconds — but the panel no longer shows a separate "backup in use" screen:
the single Diretta card is the whole story.


## Guides

Two illustrated quick-start guides — install once, create a broadcast, go live
from the browser or an encoder, attach a CDN, survive the unexpected. Same content, two languages:

| | |
| --- | --- |
| 🇮🇹 [Guida rapida — Italiano (PDF)](docs/guides/guide-it.pdf) | [HTML source](docs/guides/guide-it.html) |
| 🇬🇧 [Quick guide — English (PDF)](docs/guides/guide-en.pdf) | [HTML source](docs/guides/guide-en.html) |

The PDFs are generated from the HTML with headless Chrome (`page.pdf`), so the
guides can be edited as plain HTML and re-printed without a design tool.

## Tests

```bash
pnpm typecheck        # tsc, both packages
pnpm test             # 48 tests: FFmpeg args (video + audio), supervisor, watchdog, auth, users, routes, link previews
pnpm build            # api → dist, web → dist
```

The FFmpeg argument list is asserted in tests and exercised end-to-end by a real
encoder smoke script, because the flags are the part of this system most likely
to rot silently.

The player itself was verified in Chromium through Playwright against a real
MediaMTX → FFmpeg → HLS chain: the LIVE badge renders, pressing play moves
`video.currentTime` forward with no console errors, the single control toggles
pause and resume, and the same flow was captured on a 390 px mobile viewport
([`docs/screenshots/player-mobile.png`](docs/screenshots/player-mobile.png)).

## Layout

```
apps/api     Fastify + better-sqlite3: auth, streams, encoder supervisor, settings
apps/web     React + Vite: landing, login, panel, player (hls.js loaded on demand)
infra        MediaMTX config template, systemd units, nginx sites, provision/deploy scripts
docs         Architecture decisions, operator runbook
```

## License

MIT — see [`LICENSE`](LICENSE).

---

*Built by [Simone D'Agostino](https://github.com/sdagostino777).*
