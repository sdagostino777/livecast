# Attaching a CDN

The player, the panel and the media encoder are all fine as they are; what a
CDN changes is **who serves the segments**. This document is the five-minute
procedure, plus what to check when it does not work on the first try.

## What the app already does for you

| Path | `Cache-Control` | Why |
| --- | --- | --- |
| `/hls/<slug>/*.m3u8` | `no-store` | a playlist written two seconds ago must never be served stale |
| `/hls/<slug>/*.ts` | `public, max-age=31536000, immutable` | a segment, once written, never changes |
| `/api/*`, `/` | none | the panel and JSON must always reach the origin |

Origin responses also carry `Access-Control-Allow-Origin: *` on `/hls/*`. That
is not decoration: with a CDN configured, the player on `https://<domain>` fetches
manifests from `https://<cdn>` — a **cross-origin** fetch that browsers block
unless the edge allows it. Setting the header at the origin means any CDN that
passes headers through works even with its CORS switch off.

## Bunny CDN — the five-minute version

1. **Create a Pull Zone** in the Bunny dashboard: *CDN → Add Pull Zone*.
   - **Origin URL**: `https://<your-domain>` (for NDX Live: `https://live.ndx-llc.com`)
   - **Name**: something like `live-cdn`
   - Leave "Cache static files" behaviour at its default: Bunny honours the
     origin's `Cache-Control`, which is exactly the policy above.
2. **Custom hostname + TLS**: Pull Zone → *Hostnames → Add Custom Hostname* →
   `<something>.b-cdn.net` is assigned already; add your own (e.g.
   `cdn.ndx-llc.com` as a CNAME) and enable **Free SSL** so the player fetches
   over HTTPS. A CDN hostname on plain HTTP next to an HTTPS page triggers mixed
   content and the player will refuse.
3. **Tell the app**: open the panel → **Configurazione** → **CDN (opzionale)** →
   `https://<cdn-hostname>` → **Salva**.
4. **Verify**: press **Verifica CDN**. While a broadcast is live it requests
   `<cdn>/hls/<slug>/master.m3u8` through the edge and shows the HTTP status plus
   the cache header (`x-cache`, `cf-cache-status`, `cdn-cache`).
   Expect **MISS** on the first probe (the edge fetches from origin) and **HIT**
   on the next. A 200 with `no-store` on the playlist is correct; a `HIT` on the
   playlist is not — check that the CDN is honouring `Cache-Control` and not
   forcing "cache everything" on `*.m3u8`.

That is the whole change. New viewers load segments from the edge; the panel
keeps talking to the origin; rolling back is clearing the field and saving.

## What the CDN must and must not do

| Must | Must not |
| --- | --- |
| Send `Host: <your-domain>` to the origin (Bunny does this from the Origin URL) | Buffer entire segments and serve them late |
| Revalidate playlists every request | Cache `*.m3u8` |
| Serve segments from any edge with the origin's `Cache-Control` intact | Strip `Access-Control-Allow-Origin` |
| Terminate TLS with a valid certificate for the CDN hostname | Rewrite `#EXT-X-STREAM-INF` or segment URIs (relative URIs are resolved against the CDN base) |

## Alternatives

- **Cloudflare (proxied pull)**: works technically, but the free/Pro plans'
  terms restrict large video streaming; use it for the *panel* only if you like,
  not for 4,000 viewers. Cloudflare Stream is the managed answer — about
  $1 per 1,000 delivered minutes, i.e. ≈ $240 per event-hour at 4,000 viewers.
- **Managed live platforms** (Mux, LiveKit Cloud): simplest operationally, 5–10×
  the cost of a pull zone at this audience size.
- **Another CDN** (Fastly, CDN77, KeyCDN): same model — a pull zone over
  `https://<your-domain>`, honouring the cache headers above.

## Cost sanity check for the June 2027 event

4,000 viewers × 1 h at an average ~1.8 Mbps ≈ **3.2 TB** delivered per event
hour. At Bunny's $0.01/GB that is **≈ $30 per event hour** (plus $0 typical
origin egress: each segment crosses the origin once per edge, not once per
viewer). Compare with Cloudflare Stream's ≈ $240/hour for the same event.

## When it goes wrong

| Symptom | Likely cause |
| --- | --- |
| Playlist request returns HTML / the page | CDN path mapping wrong: the origin URL must include the scheme and host, and `/hls/<slug>/...` must be reachable on it |
| Player stalls only when the CDN is on | Missing CORS at the edge — check that `Access-Control-Allow-Origin: *` is present on the segment response |
| `Verifica CDN` returns 404 | The CDN hostname points at the wrong origin, or no broadcast is live (the probe falls back to `/hls/` and a 404 there is honest) |
| Playlists cached | Turn off "cache everything" for `*.m3u8`; the origin already says `no-store` |
| Segments 403/401 | The CDN is being blocked by origin firewall/hotlink protection; whitelist Bunny's edge IPs or disable hotlink protection |
