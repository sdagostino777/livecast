# Architecture

## Shape of the system

```
                ┌────────────────────────────────────────────────────┐
  OBS (operator)│  RTMP :1935  ──▶  MediaMTX                          │
                │                     │ auth: publish to "live" only   │
                │                     ▼                               │
                │  FFmpeg (spawned by the API)                       │
                │    reads rtmp://127.0.0.1/live (reader user, loopback)
                │    writes 720p/480p/360p HLS into DATA_DIR/hls/<slug>/
                │                     │                               │
                │                     ▼                               │
                │  nginx ── /hls/* (disk, cache headers)              │
                │        └── /      ──▶ Fastify :4100 (SPA + JSON API)│
                │                     │                               │
                │        SQLite ◀─────┘ sessions, streams, settings   │
                └──────────┬──────────────────────────────────────────┘
                           │ optional: pull zone
                        CDN ──▶ 4,000 viewers ▶ begehrt /live/<slug>
```

The API never touches video bytes. That is the central decision: playback is a
directory of files with cache headers, and everything that could make the web app
slow on a phone stays out of the media path.

## The encoder pipeline

One FFmpeg process per broadcast, always run from the API so the panel owns the
lifecycle:

- **Input**: `rtmp://<reader>:<pass>@127.0.0.1:1935/live` — the MediaMTX loopback
  reader. The reader user is restricted by IP to loopback, so the encoder
  credential never has to be a public secret.
- **Ladder**: 1280×720 @ 2.8 Mbps, 854×480 @ 1.4 Mbps, 640×360 @ 0.8 Mbps, AAC
  128/96/64 kbps, keyframe forced every 2 s (`expr:gte(t,n_forced*2)`) so every
  segment starts on an IDR frame.
- **Output**: standard HLS, 2 s segments, 6 kept per variant (~12 s window).
  Standard HLS rather than LL-HLS: partial segments complicate CDN caching for a
  latency gain a passive audience will not notice.
- **Recording** (optional per broadcast): fragmented MP4 of the 720p rendition,
  written as a second FFmpeg output.

### Supervisor state machine

```
idle ──start()──▶ starting ──first segment──▶ live ──stop()──▶ ended
                    │                          │
                    │ no publisher in          │ watchdog: 60 ticks
                    │ INGEST_WAIT_SECONDS      │ with no new segment
                    ▼                          ▼
                 ended(ingest_timeout)      SIGKILL + relaunch (still live)
```

FFmpeg exits whenever the RTMP socket closes — a Wi-Fi blip, a laptop lid, an
OBS restart. The exit handler relaunches after 2.5 s with no user action. The
watchdog catches the other case: an encoder still running but producing nothing
(hung x264, a publisher that stopped sending frames without closing the socket).
It counts monitor ticks over the segment list rather than comparing wall-clock
times, which keeps the behaviour deterministic under tests.

## Redundancy: what holds when things break

| Failure | Detection | Recovery |
| --- | --- | --- |
| OBS disconnects mid-stream | FFmpeg input EOF, exit handler | relaunch in ≤ 2.5 s; resumes on OBS reconnect |
| Encoder hung, socket alive | segment list unchanged for 120 s | SIGKILL, then the same relaunch path |
| MediaMTX crashes | systemd `Restart=always` (2 s) | OBS reconnects; encoder relaunches when the ingest path is ready |
| Fastify crashes | systemd `Restart=always` (2 s) | sessions and stream state live in SQLite, not memory |
| VPS reboots | systemd `WantedBy=multi-user.target` | both units start; a stream that was live resumes when OBS reconnects |
| Operator never publishes | `INGEST_WAIT_SECONDS` timer | stream ends itself and says so; the page shows "not started yet" |

The honest limits:

- **One ingest path.** A second broadcaster cannot publish concurrently —
  MediaMTX has one publish slot per path. Redundant ingest would be a second
  MediaMTX instance on another host and a DNS trick; that is a deployment
  exercise, not a code one.
- **HLS is not synchronous.** After a publisher dropout the last ~12 s of
  segments remain playable, then players stall rather than show a spinner
  permanently. Viewers with hls.js auto-retry; the page polls status.
- **RTMP is plaintext.** The stream key crosses an unencrypted connection. The
  video is public anyway; moving the publisher to SRT-with-passphrase or RTMPS
  is a future hardening step, documented rather than pretended.

## Security model

- Passwords: argon2id, OWASP parameters (19 MiB, t=2, p=1).
- Sessions: opaque 32-byte tokens, SHA-256 stored, 12 h expiry, `httpOnly`,
  `SameSite=Lax`, `Secure` in production. Re-resolved from the database on every
  request so revocation is immediate.
- CSRF: `SameSite=Lax` plus an Origin check on every mutating request against
  the configured public origin (read from the settings table, so it follows a
  base-URL change).
- Login: 10 attempts / 15 min / IP, generic error for both wrong password and
  wrong TOTP — the login form must not be a username oracle.
- TOTP: RFC 6238 implemented on `node:crypto` (±1 step drift), ~40 lines, tested
  against the RFC 6238 vectors.
- Ingest: publish restricted to the `live` path with a generated 32-character
  key, checked by MediaMTX; readers restricted to loopback.
- The panel reveals the OBS credential only on an authenticated request, and
  writes `ingest_key_revealed` to the audit log.

## Scaling to the 4,000-viewer event

Origin capacity is not the problem, egress is: 4,000 × ~2 Mbps ≈ 8 Gbps at the
origin, which no single VPS port provides. The design answer:

1. **Segments are immutable** — `Cache-Control: public, max-age=31536000,
   immutable` on `.ts`, `no-store` on playlists. A CDN caches each segment once
   per edge and serves it to thousands.
2. **The CDN is configuration, not code** — set the CDN base URL in the panel;
   `hlsUrl` in the public API switches to it immediately. The "Verifica CDN"
   button fetches the live manifest through the edge and reports the cache
   header.
3. **Rough numbers for June 2027**: 4,000 viewers × 1 h at ~1.8 Mbps average is
   ~3.2 TB/hour; at Bunny CDN's $0.01/GB that is ≈ $30 per event hour. The
   origin serves each segment once per edge (tens of GB), not to every viewer.

## Runtime settings and why they are in SQLite

Deployment facts that change without a code deployment — the CDN hostname, the
public origin, what OBS connects to — live in a `settings` table seeded from the
environment on first boot and editable from the panel. The `SettingsStore`
validates each value (URL shape, port range, CDN ≠ origin) before persisting.

## Non-goals, stated

- No chat, reactions, or analytics — every added pixel is a mobile failure mode.
- No multi-tenant: one operator account, one broadcast at a time.
- No PIN: the link is the access control (a deliberate product decision for
  open transmissions). The schema and routes would allow adding one behind a
  flag; nothing else in the design assumes the page is unprotected.
