# Operator runbook

Everything an operator needs on event day, plus the two procedures that are easy
to get wrong: attaching a CDN, and verifying the encoder.

## Go-live checklist

1. `systemctl status ndx-live ndx-live-mediamtx` — both `active (running)`.
2. Open `https://<domain>/admin` and log in.
3. Create the broadcast ("Crea e vai in onda"). Status becomes **In attesa di OBS**.
4. In OBS, start streaming. The panel flips to **In onda** within ~5 s.
5. Open the `/live/<slug>` link on a phone over mobile data, press play, and
   confirm the **LIVE** badge. This is the only test that matters.
6. For a large event: attach the CDN **before** sharing the link (next section).
7. After the event: **Termina**. The stream status becomes "Terminata"; the
   public page says so.

If OBS never connects, the stream ends itself after `INGEST_WAIT_SECONDS` (10
minutes by default) rather than waiting forever — restart it from the panel.

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
pipeline produces, without OBS or MediaMTX:

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

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Panel shows "OBS non collegato" | `journalctl -u ndx-live-mediamtx -n 50`; is 1935/tcp open (`ufw status`)? Is the RTMP URL in OBS the one the panel shows? |
| Panel shows "MediaMTX non raggiungibile" | `curl -s http://127.0.0.1:9997/v3/paths/get/live` — the media server process, not the broadcaster, is down. |
| Stream stays "Preparazione video…" | `journalctl -u ndx-live -f` — FFmpeg's stderr is logged there (last 600 chars also surface in the panel). |
| Player says "Segnale non disponibile" | The page retries by itself for ~1 minute. If the encoder log shows repeated restarts, the publisher is gone. |
| `watchdog: no new HLS segments` in the log | A hang was detected and the encoder restarted. If it repeats, check the publisher's network, not this system. |
| Login "works" but every request returns 401 | The page is being served over HTTP while `COOKIE_SECURE=true`. Use `https://`; the certificate belongs to the domain, not the IP. |
| Deploy: "certbot failed" | The DNS A record for the hostname does not exist or does not point at this VPS. Add it, re-run `bash infra/scripts/deploy.sh --provision`. |

## Operations

```bash
systemctl status ndx-live ndx-live-mediamtx
journalctl -u ndx-live -f              # app + FFmpeg stderr
journalctl -u ndx-live-mediamtx -f     # ingest
nginx -t && systemctl reload nginx

# publish key rotation (broadcaster credential)
vi /root/.ndx-live-credentials         # change PUBLISH_PASS
# update PUBLISH_PASS and MEDIAMTX_READ_* in /srv/ndx-live/app/.env
vi /srv/ndx-live/mediamtx.yml          # change __READER__/__PUBLISH__ pass lines
systemctl restart ndx-live-mediamtx ndx-live

# backup: everything is one directory
tar czf ndx-live-backup-$(date +%F).tgz -C /srv/ndx-live data/ .env

# restore
tar xzf ndx-live-backup-YYYY-MM-DD.tgz -C /srv/ndx-live
systemctl restart ndx-live
```

Admin password reset (e.g. forgotten password): run on the VPS
`cd /srv/ndx-live/app && node --env-file=.env apps/api/dist/cli.js reset-password --username admin`
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

## Data retention

- `DATA_DIR/ndx-live.db` — users, sessions, streams, settings, audit log.
- `DATA_DIR/hls/<slug>/` — live segments only; deleted when a stream stops.
- `DATA_DIR/recordings/` — one fragmented MP4 per recorded broadcast, kept until
  removed by hand.
