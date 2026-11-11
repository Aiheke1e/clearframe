#!/usr/bin/env bash
set -euo pipefail
server_dir=$(cd -- "$(dirname -- "$0")/.." && pwd)
case "$server_dir" in /lzzx/project/clearframe/releases/clearframe-*/server) ;; *) exit 1 ;; esac
test -f /lzzx/erv/mihomo/config.yaml
systemctl start shared-proxy.service
systemctl is-active --quiet shared-proxy.service
backup_dir="/lzzx/project/clearframe/backups/proxy-$(date +%Y%m%d-%H%M%S)"
install -d -m 700 "$backup_dir"
override_dir=/etc/systemd/system/clearframe.service.d
for name in 20-release.conf 30-x-proxy.conf; do
    if [ -f "$override_dir/$name" ]; then cp -a "$override_dir/$name" "$backup_dir/$name"; fi
done
install -m 644 "$server_dir/deploy/30-x-proxy.conf.example" "$override_dir/30-x-proxy.conf"
if bash "$server_dir/deploy/activate-release.sh" && \
   curl --fail --silent --max-time 5 http://127.0.0.1:8787/health | /lzzx/erv/node/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s).enable.x?0:1))'; then
    systemctl enable shared-proxy.service
    echo "X_PROXY_ACTIVE; BACKUP=$backup_dir"
else
    for name in 20-release.conf 30-x-proxy.conf; do
        if [ -f "$backup_dir/$name" ]; then cp -a "$backup_dir/$name" "$override_dir/$name";
        else rm -f -- "$override_dir/$name"; fi
    done
    systemctl daemon-reload
    systemctl restart clearframe.service
    echo "Proxy activation failed; restored previous application configuration" >&2
    exit 1
fi
