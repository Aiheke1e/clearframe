#!/usr/bin/env bash
set -euo pipefail
deploy_dir=$(cd -- "$(dirname -- "$0")" && pwd)
backup_dir="/lzzx/project/clearframe/backups/clearframe-$(date +%Y%m%d-%H%M%S)"
install -d -m 700 "$backup_dir"
tar --exclude=node_modules --exclude=releases --exclude=backups --exclude=shared -czf "$backup_dir/server-before.tar.gz" -C /lzzx/project/clearframe .
cp -a /etc/systemd/system/clearframe.service "$backup_dir/clearframe.service"
if [ -f /etc/systemd/system/clearframe-port80.service ]; then
    cp -a /etc/systemd/system/clearframe-port80.service "$backup_dir/clearframe-port80.service"
    systemctl disable --now clearframe-port80.service
fi
iptables-save > "$backup_dir/iptables-before.rules"
if [ -f /etc/iptables/rules.v4 ]; then cp -a /etc/iptables/rules.v4 "$backup_dir/rules.v4"; fi
cp -a /etc/nginx "$backup_dir/nginx-before"
install -d -m 755 /lzzx/project/clearframe/shared/acme/.well-known/acme-challenge
install -d -m 755 /lzzx/erv/nginx/conf.d
install -m 644 "$deploy_dir/nginx-http.conf" /lzzx/erv/nginx/conf.d/clearframe.conf
ln -sfn /lzzx/erv/nginx/conf.d/clearframe.conf /etc/nginx/sites-available/clearframe
ln -sfn /etc/nginx/sites-available/clearframe /etc/nginx/sites-enabled/clearframe
nginx -t
systemctl enable --now nginx
systemctl reload nginx
if iptables -t nat -C PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports 8787 2>/dev/null; then
    iptables -t nat -D PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports 8787
fi
if [ -f /etc/iptables/rules.v4 ]; then
    sed -i '/^-A PREROUTING -p tcp -m tcp --dport 80 -j REDIRECT --to-ports 8787$/d' /etc/iptables/rules.v4
fi
curl --retry 5 --retry-delay 1 --retry-all-errors --fail --silent --show-error --max-time 5 -H 'Host: aihekele.xyz' http://127.0.0.1/health
echo
echo "BACKUP_DIR=$backup_dir"
