# Operator runbook

Everything an operator needs on event day, plus the two procedures that are easy
to get wrong: attaching a CDN, and verifying the encoder.

## Go-live checklist

1. `systemctl status livecast livecast-mediamtx` — both `active (running)`.
2. Open `https://<domain>/admin` and log in.
3. Write the event title and choose **Video** or **Solo audio**; upload the poster
   if the event has one. Everything saves itself — there is no "Salva".
4. Press **● ONLINE** (or connect camera/screen first and press it after): the
   panel shows **Preparazione…** until the first segment reaches the player. An
   audio-only broadcast ignores any video a publisher sends, so the operator can
   leave the scene as it is.
5. Start the encoder (browser or external program). The panel flips to **In onda**
   within ~5 s, with the elapsed time and the number of connected viewers.
6. Open the `/live/<slug>` link on a phone over mobile data, press play, and
   confirm the **LIVE** badge. This is the only test that matters.
7. For a large event: attach the CDN **before** sharing the link (next section).
8. After the event: **■ STOP**. The public page says the broadcast is over;
   **Nuovo evento** opens the next one with a fresh link.

If the encoder never connects, the stream ends itself after `INGEST_WAIT_SECONDS` (10
minutes by default) rather than waiting forever — restart it from the panel.

## Redundancy drill (primary / backup encoder)

The system accepts two publishers: `/live` (primary) and `/backup`. The encoder
uses whichever is actually connected, preferring the primary, and the panel shows
a green LED per publisher plus "In uso: principale/backup".

To rehearse:

1. Start a broadcast; push from the primary encoder. Panel: primary LED green,
   "In uso: principale".
2. Stop the primary encoder (push a second RTMP stream to the **backup** URL
   from the panel's revealed credentials instead). Within ~3 s the panel shows
   "In uso: backup" and the player keeps playing — a few seconds of freeze while
   FFmpeg relaunches, nothing more.
3. Restart the primary: the next relaunch (or the next dropout) returns to it.

The backup encoder can be a second the encoder on another machine, a phone, or a spare
laptop on a different network. Two encoders on the same Wi-Fi protect against
the the encoder crashing, not against the network dying.

## Managing people

- **Utenti** (admin only): create an operator with a username and a 12+ character
  password; they can log in and run broadcasts immediately. The same section
  resets a password (all their sessions end) or removes the account.
- The **admin** account is protected by construction: user management refuses to
  reset or delete it, and it is the only account that can manage users at all.
  An admin changes their own password in **Sicurezza**.
- Audit trail: `GET /api/admin/audit` (also visible in the panel via the API) —
  logins, broadcasts, settings changes, user creation/reset/deletion.

## Attaching a CDN from the panel ("a few clicks")

The CDN is a pull zone over the origin; the app never pushes to it. The full
procedure, including the CORS requirement and the cache policy the origin
already sends, is [`docs/CDN.md`](CDN.md).

1. In the CDN provider (Bunny, Cloudflare, Fastly), create a **pull zone** whose
   origin is `https://<domain>` (the live VPS). Enable caching for `/hls/*`.
2. In the panel → **Configurazione** → **CDN (opzionale)**: enter the CDN hostname
   (e.g. `https://live-cdn.example.com`) and **Salva**.
3. Press **Verifica CDN**. While a stream is live it fetches
   `<cdn>/hls/<slug>/master.m3u8` and reports the HTTP status plus the cache
   header (`x-cache`, `cf-cache-status`, …). A `MISS` first, then `HIT` on the
   next try, is the expected pattern.
4. Nothing else changes: the public API's `hlsUrl` now points at the CDN, so new
   viewers load segments from the edge. The panel itself stays on the origin.

Cache policy the app already sets (do not override at the CDN):

| Path | `Cache-Control` | Rule |
| --- | --- | --- |
| `/hls/<slug>/*.m3u8` | `no-store` | must always hit the origin |
| `/hls/<slug>/*.ts` | `public, max-age=31536000, immutable` | cache forever |
| `/api/*`, `/` | — | proxy, do not cache |

To go back to origin delivery: clear the CDN field and save.

## Verifying the encoder without a broadcaster

Run this on the VPS (or anywhere with FFmpeg) to produce the exact ladder the
pipeline produces, without the encoder or MediaMTX:

```bash
ffmpeg -hide_banner \
  -t 10 -f lavfi -i testsrc2=size=1280x720:rate=25,format=yuv420p \
  -t 10 -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -filter_complex '[0:v]split=3[v0][v1][v2];[v0]scale=-2:720[vout0];[v1]scale=-2:480[vout1];[v2]scale=-2:360[vout2]' \
  -map '[vout0]' -map 1:a:0 -map '[vout1]' -map 1:a:0 -map '[vout2]' -map 1:a:0 \
  -c:v:0 libx264 -b:v:0 2800k -c:v:1 libx264 -b:v:1 1400k -c:v:2 libx264 -b:v:2 800k \
  -c:a:0 aac -b:a:0 128k -c:a:1 aac -b:a:1 96k -c:a:2 aac -b:a:2 64k \
  -pix_fmt yuv420p -g 96 -keyint_min 96 -sc_threshold 0 \
  -force_key_frames 'expr:gte(t,n_forced*2)' \
  -f hls -hls_time 2 -hls_list_size 6 \
  -hls_flags delete_segments+independent_segments+program_date_time \
  -hls_segment_filename '/tmp/hls/%v/seg_%06d.ts' -master_pl_name master.m3u8 \
  -var_stream_map 'v:0,a:0,name:720 v:1,a:1,name:480 v:2,a:2,name:360' \
  /tmp/hls/%v/index.m3u8
```

Expect `master.m3u8` with three `#EXT-X-STREAM-INF` entries and at least two
segments per variant. `pnpm test` asserts the same argument list.

For a real end-to-end test, push RTMP from the VPS itself:

```bash
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=25 -f lavfi -i sine=frequency=440 \
  -c:v libx264 -preset veryfast -b:v 2500k -c:a aac -b:a 128k -f flv \
  "rtmp://127.0.0.1:1935/live?user=<PUBLISH_USER>&pass=<PUBLISH_PASS>"
```

then create a stream from the panel (or `POST /api/admin/streams` +
`POST /api/admin/streams/<id>/start`) and watch `/hls/<slug>/master.m3u8`
appear in `DATA_DIR/hls/<slug>/`.

## Pre-flight TLS check (before the certificate exists)

The production TLS site can be validated on the VPS with a self-signed cert,
without touching the live nginx. This is how the nested variant paths were
caught before activation day:

```bash
T=/tmp/nginx-live-test
rm -rf "$T" && mkdir -p "$T/conf" "$T/logs" "$T/ssl"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=live.example.com" \
  -keyout "$T/ssl/privkey.pem" -out "$T/ssl/fullchain.pem"
python3 - <<'PY'
src = open('/srv/livecast/app/infra/nginx/live.conf').read()
site = src[src.index('server {\n    listen 443'):]
site = site.replace('listen 443 ssl;', 'listen 8443 ssl;') \
           .replace('/etc/letsencrypt/live/__DOMAIN__/fullchain.pem', '/tmp/nginx-live-test/ssl/fullchain.pem') \
           .replace('/etc/letsencrypt/live/__DOMAIN__/privkey.pem', '/tmp/nginx-live-test/ssl/privkey.pem')
open('/tmp/nginx-live-test/conf/site.conf', 'w').write(site)
PY
printf 'worker_processes 1;\npid %s/nginx.pid;\nhttp { include mime.types; include %s/conf/site.conf; }\n' "$T" "$T" > "$T/nginx.conf"
nginx -p "$T" -c "$T/nginx.conf" -t && nginx -p "$T" -c "$T/nginx.conf"
curl -sk -o /dev/null -w 'health=%{http_code}\n' https://127.0.0.1:8443/api/health
# with a live broadcast: check headers on a segment
curl -skI https://127.0.0.1:8443/hls/<slug>/720/seg_000000.ts | grep -i cache-control
```

Expect `Cache-Control: public, max-age=31536000, immutable` on segments and
`no-store` on every `.m3u8`, both through the CDN host and through the origin.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Panel shows "the encoder non collegato" | `journalctl -u livecast-mediamtx -n 50`; is 1935/tcp open (`ufw status`)? Is the RTMP URL in the encoder the one the panel shows? |
| Panel shows "MediaMTX non raggiungibile" | `curl -s http://127.0.0.1:9997/v3/paths/get/live` — the media server process, not the broadcaster, is down. |
| Stream stays "Preparazione video…" | `journalctl -u livecast -f` — FFmpeg's stderr is logged there (last 600 chars also surface in the panel). |
| Player says "Segnale non disponibile" | The page retries by itself for ~1 minute. If the encoder log shows repeated restarts, the publisher is gone. |
| `watchdog: no new HLS segments` in the log | A hang was detected and the encoder restarted. If it repeats, check the publisher's network, not this system. |
| Login "works" but every request returns 401 | The page is being served over HTTP while `COOKIE_SECURE=true`. Use `https://`; the certificate belongs to the domain, not the IP. |
| Deploy: "certbot failed" | The DNS A record for the hostname does not exist or does not point at this VPS. Add it, re-run `bash infra/scripts/deploy.sh --provision`. |

## Operations

```bash
systemctl status livecast livecast-mediamtx
journalctl -u livecast -f              # app + FFmpeg stderr
journalctl -u livecast-mediamtx -f     # ingest
nginx -t && systemctl reload nginx

# publish key rotation (broadcaster credential)
vi /root/.livecast-credentials         # change PUBLISH_PASS
# update PUBLISH_PASS and MEDIAMTX_READ_* in /srv/livecast/app/.env
vi /srv/livecast/mediamtx.yml          # change __READER__/__PUBLISH__ pass lines
systemctl restart livecast-mediamtx livecast

# backup: everything is one directory
tar czf livecast-backup-$(date +%F).tgz -C /srv/livecast data/ .env

# restore
tar xzf livecast-backup-YYYY-MM-DD.tgz -C /srv/livecast
systemctl restart livecast
```

Admin password reset (e.g. forgotten password): run on the VPS
`cd /srv/livecast/app && node --env-file=.env apps/api/dist/cli.js reset-password --username admin`
— it prints a new password and invalidates all sessions.

## Moving to another VPS or domain

Everything that describes *this* install (public URL, CDN, ingest host) is in
the panel, but the two things that describe *the machine* are deploy-time
parameters:

```bash
# provision a second VPS with the same code
SSH_HOST=root@203.0.113.10 SSH_KEY=~/.ssh/other_vps \
  bash infra/scripts/deploy.sh --provision

# or keep the SSH config and only change the domain
APP_DOMAIN=live.example.com bash infra/scripts/deploy.sh --provision
```

After the first deploy: in **Configurazione** set the new public URL, the CDN (if
any) and the ingest host, then create the broadcast. No code changes, no data
migration for a fresh event — the SQLite file under `DATA_DIR` is the only state,
and copying `DATA_DIR` moves it.

## If the VPS is down

The event is down too: the encoder lives on that machine. Recovery:

1. On a standby VPS (provisioned with the same `APP_NAME`), restore the last
   `DATA_DIR` backup (it contains the database and the recordings) and the
   `.env` from `/srv/<app>/app/.env`.
2. Point the DNS record at the standby IP (TTL 300 → ~5 min).
3. Start the encoder and the publishers again.

Keep the DNS TTL low (300 s) for event days. The CDN, if configured, keeps
serving cached segments for a few seconds and then fails over with the origin.

## Data retention

- `DATA_DIR/database.sqlite` — users, sessions, streams, settings, audit log.
- `DATA_DIR/hls/<slug>/` — live segments only; deleted when a stream stops.
- `DATA_DIR/recordings/` — one fragmented MP4 per recorded broadcast, kept until
  removed by hand.
