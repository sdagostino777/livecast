[Unit]
Description=__APP_NAME__ — MediaMTX RTMP ingest
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=__APP_USER__
Group=__APP_USER__
ExecStart=__APP_DIR__/bin/mediamtx __APP_DIR__/mediamtx.yml
Restart=always
RestartSec=2
# A broadcaster reconnect burst opens many short-lived connections; the default
# fd limit is generous enough but explicit is easier to reason about in an
# incident.
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
