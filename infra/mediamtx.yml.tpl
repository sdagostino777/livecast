# MediaMTX configuration for Livecast.
#
# Rendered from mediamtx.yml.tpl by provision.sh: the __PLACEHOLDERS__ are
# replaced with credentials generated once on the VPS.
#
# The shape of the design: MediaMTX is an ingest appliance only. It accepts the
# broadcaster's RTMP stream and nothing else — HLS is disabled because FFmpeg
# produces it, and RTSP/WebRTC/SRT are off because an unused listener is a
# liability, not a feature.

logLevel: info
logDestinations: [stdout]

# Internal auth: two users, no anonymous publishing.
#   publisher — the broadcaster, may push to the "live" path only.
#   reader    — only the FFmpeg process on this machine may read it.
authMethod: internal
authInternalUsers:
  - user: __PUBLISH_USER__
    pass: __PUBLISH_PASS__
    ips: []
    permissions:
      - action: publish
        path: live

  - user: __READER_USER__
    pass: __READER_PASS__
    ips: ["127.0.0.1", "::1"]
    permissions:
      - action: read
        path: live

  # The control API on loopback is how the panel knows whether OBS is connected.
  # Replacing the default "any" user above would otherwise leave /v3/paths/get
  # returning "authentication error" to our own app on 127.0.0.1.
  - user: any
    pass:
    ips: ["127.0.0.1", "::1"]
    permissions:
      - action: api
        path:

# Control API on loopback only: the Fastify app reads ingest status from it.
api: yes
apiAddress: 127.0.0.1:9997

# RTMP is the one protocol in use.
rtmp: yes
rtmpAddress: :1935
rtsp: no
hls: no
webrtc: no
srt: no
moq: no

# Metrics/pprof are off: the operator reads live state from the panel.
metrics: no
pprof: no

paths:
  live:
    source: publisher
    # Recording is FFmpeg's job (it already has the decoded stream); MediaMTX
    # writing segments too would double the disk writes for no benefit.
    record: no
