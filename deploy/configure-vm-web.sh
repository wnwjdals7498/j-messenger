#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 && $(hostname) == j-messenger-lab ]] || exit 10
source_file=${1:?nginx configuration required}
[[ $source_file == /home/jjm/.local/share/j-messenger-lab/nginx-lab.conf && -f $source_file ]] || exit 11
umask 077
snapshot="/root/j-messenger-lab-deploy-backups/web-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$snapshot"
cp -p /etc/nginx/nginx.conf "$snapshot/nginx.conf"
getsebool httpd_can_network_relay > "$snapshot/selinux-relay"
firewall-cmd --zone=jm-clients --query-port=443/tcp > "$snapshot/https-rule" || true
install -d -m 700 /etc/nginx/j-messenger-lab
install -m 644 /home/jmsg/.config/j-messenger/tls/service.crt /etc/nginx/j-messenger-lab/service.crt
install -m 600 /home/jmsg/.config/j-messenger/tls/service.key /etc/nginx/j-messenger-lab/service.key
install -m 644 /home/jmsg/.config/j-messenger/tls/ca.crt /etc/nginx/j-messenger-lab/ca.crt
install -m 644 "$source_file" /etc/nginx/nginx.conf
restorecon -RF /etc/nginx
if ! semanage port -l | grep '^http_port_t ' | grep -qw 3443; then
  semanage port -a -t http_port_t -p tcp 3443
fi
# Permit the confined web server to relay only to approved HTTP-labelled ports.
setsebool -P httpd_can_network_relay on
nginx -t
firewall-cmd --zone=jm-clients --add-port=443/tcp
firewall-cmd --permanent --zone=jm-clients --add-port=443/tcp
systemctl enable --now nginx
systemctl reload nginx
printf 'vm.web.configured\n'
