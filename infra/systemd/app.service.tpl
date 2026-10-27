[Unit]
Description=__APP_NAME__ — API and player
After=network-online.target __APP_NAME__-mediamtx.service
Wants=network-online.target

[Service]
Type=simple
User=__APP_USER__
Group=__APP_USER__
WorkingDirectory=__APP_DIR__/app
EnvironmentFile=__APP_DIR__/app/.env
ExecStart=__NODE__ apps/api/dist/main.js
# Never leave the panel and the player down after a crash or an OOM: the one
# thing worse than a stalled encoder is a web app that cannot be asked about it.
Restart=always
RestartSec=2
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
