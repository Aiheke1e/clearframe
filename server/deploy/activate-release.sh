#!/usr/bin/env bash
set -euo pipefail
server_dir=$(cd -- "$(dirname -- "$0")/.." && pwd)
case "$server_dir" in /lzzx/project/clearframe/releases/clearframe-*/server) ;; *) echo "Unexpected release path" >&2; exit 1 ;; esac
test -f "$server_dir/src/network.js"
test -d "$server_dir/node_modules/express"
shared_dir=/lzzx/project/clearframe/shared/usage
install -d -m 755 "$shared_dir"
if [ ! -f "$shared_dir/usage.json" ]; then
    cp "$server_dir/data/usage.json" "$shared_dir/usage.json"
fi
chown ubuntu:ubuntu "$shared_dir/usage.json" "$shared_dir"
override=/etc/systemd/system/clearframe.service.d/20-release.conf
backup_dir="/lzzx/project/clearframe/backups/activate-$(date +%Y%m%d-%H%M%S)"
install -d -m 700 "$backup_dir"
if [ -f "$override" ]; then cp -a "$override" "$backup_dir/20-release.conf"; fi
systemctl cat clearframe.service > "$backup_dir/service-before.txt"
install -d -m 755 /etc/systemd/system/clearframe.service.d
printf '[Service]\nWorkingDirectory=%s\nEnvironment=HOST=127.0.0.1\nEnvironment=CLEARFRAME_USAGE_FILE=%s/usage.json\n' "$server_dir" "$shared_dir" > "$override"
systemctl daemon-reload
systemctl restart clearframe.service
if ! curl --retry 8 --retry-delay 1 --retry-all-errors --fail --silent --show-error --max-time 3 http://127.0.0.1:8787/health; then
    if [ -f "$backup_dir/20-release.conf" ]; then
        cp -a "$backup_dir/20-release.conf" "$override"
    else
        rm -- "$override"
    fi
    systemctl daemon-reload
    systemctl restart clearframe.service
    echo "Release health check failed; restored previous service configuration" >&2
    exit 1
fi
echo
echo "ACTIVE_RELEASE=$server_dir"
echo "SERVICE_BACKUP=$backup_dir"
