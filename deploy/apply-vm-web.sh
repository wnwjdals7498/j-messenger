#!/usr/bin/env bash
# Owns nginx.conf on a dedicated messenger VM. Review plan.json before invoking.
set -euo pipefail
[[ $(id -u) == 0 ]] || exit 10
profile=${1:?profile.json required}
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/vm-profile.sh"
load_vm_profile "$profile"
[[ $(hostname) == "$JM_HOSTNAME" ]] || { printf 'Target hostname mismatch.\n' >&2; exit 11; }
ip -4 address show | grep -Fq "inet $JM_VM_IP/" || { printf 'Target IP is not assigned.\n' >&2; exit 12; }
[[ $(getent passwd "$JM_APP_USER" | cut -d: -f6) == "$JM_APP_HOME" ]] || exit 13
env_file="$JM_APP_HOME/.config/j-messenger/server.env"
[[ -f $env_file && -f "$JM_APP_HOME/app/current/apps/server/dist/main.js" ]] || exit 14
node "$script_dir/vm-profile.mjs" check-env "$profile" "$env_file"
for tool in nginx firewall-cmd semanage getsebool setsebool openssl curl runuser; do command -v "$tool" >/dev/null; done
user_id=$(id -u "$JM_APP_USER")
app_systemctl() { runuser -u "$JM_APP_USER" -- env XDG_RUNTIME_DIR="/run/user/$user_id" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$user_id/bus" systemctl --user "$@"; }
app_systemctl cat j-messenger >/dev/null
umask 077
snapshot="/root/j-messenger-vm-backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
install -d -m 700 "$snapshot"
cp -p /etc/nginx/nginx.conf "$snapshot/nginx.conf"
cp -p "$env_file" "$snapshot/server.env"
app_systemctl is-active j-messenger > "$snapshot/app-active" || true
systemctl is-active nginx > "$snapshot/nginx-active" || true
systemctl is-enabled nginx > "$snapshot/nginx-enabled" || true
getsebool httpd_can_network_relay > "$snapshot/selinux-relay"
firewall-cmd --zone="$JM_ZONE" --list-all > "$snapshot/firewall-runtime" 2>/dev/null || true
firewall-cmd --permanent --zone="$JM_ZONE" --list-all > "$snapshot/firewall-permanent" 2>/dev/null || true
tls_source="$JM_APP_HOME/.config/j-messenger/tls"
tls_target="/etc/nginx/j-messenger/$JM_HOSTNAME"
if [[ $JM_PROTOCOL == https || $JM_BACKEND_PROTOCOL == https ]]; then
  openssl verify -CAfile "$tls_source/ca.crt" -verify_ip "$JM_VM_IP" "$tls_source/service.crt" >/dev/null
  openssl verify -CAfile "$tls_source/ca.crt" -verify_hostname "$JM_HOSTNAME" "$tls_source/service.crt" >/dev/null
  key_public=$(openssl pkey -in "$tls_source/service.key" -pubout 2>/dev/null | openssl dgst -sha256)
  cert_public=$(openssl x509 -in "$tls_source/service.crt" -pubkey -noout | openssl dgst -sha256)
  [[ $key_public == "$cert_public" ]] || exit 15
  if [[ -d $tls_target ]]; then
    install -d -m 700 "$snapshot/previous-tls"
    for tls_file in service.crt service.key ca.crt; do
      if [[ -f "$tls_target/$tls_file" ]]; then cp -p "$tls_target/$tls_file" "$snapshot/previous-tls/$tls_file"; fi
    done
  fi
  install -d -m 700 "$tls_target"
  install -m 644 "$tls_source/service.crt" "$tls_source/ca.crt" "$tls_target/"
  install -m 600 "$tls_source/service.key" "$tls_target/"
  restorecon -RF "$tls_target"
fi
node "$script_dir/vm-profile.mjs" nginx "$profile" > "$snapshot/candidate-nginx.conf"
nginx -t -c "$snapshot/candidate-nginx.conf"
# Refuse relabeling a port already owned by another SELinux service.
for port in "$JM_PUBLIC_PORT" "$JM_BACKEND_PORT"; do
  if ! semanage port -l | grep '^http_port_t ' | grep -qw "$port"; then
    semanage port -a -t http_port_t -p tcp "$port"
  fi
done
if [[ $JM_REDIRECT == 1 ]] && ! semanage port -l | grep '^http_port_t ' | grep -qw "$JM_HTTP_PORT"; then
  semanage port -a -t http_port_t -p tcp "$JM_HTTP_PORT"
fi
setsebool -P httpd_can_network_relay on
if ! firewall-cmd --permanent --get-zones | tr ' ' '\n' | grep -Fxq "$JM_ZONE"; then
  firewall-cmd --permanent --new-zone="$JM_ZONE"
  firewall-cmd --reload
fi
IFS=',' read -ra sources <<< "$JM_SOURCES"
for source_cidr in "${sources[@]}"; do
  firewall-cmd --zone="$JM_ZONE" --add-source="$source_cidr"
  firewall-cmd --permanent --zone="$JM_ZONE" --add-source="$source_cidr"
done
firewall-cmd --zone="$JM_ZONE" --add-service=ssh
firewall-cmd --permanent --zone="$JM_ZONE" --add-service=ssh
firewall-cmd --zone="$JM_ZONE" --add-port="$JM_PUBLIC_PORT/tcp"
firewall-cmd --permanent --zone="$JM_ZONE" --add-port="$JM_PUBLIC_PORT/tcp"
if [[ $JM_REDIRECT == 1 ]]; then
  firewall-cmd --zone="$JM_ZONE" --add-port="$JM_HTTP_PORT/tcp"
  firewall-cmd --permanent --zone="$JM_ZONE" --add-port="$JM_HTTP_PORT/tcp"
fi
# The selected backend is loopback-only; never publish it through this zone.
if firewall-cmd --zone="$JM_ZONE" --query-port="$JM_BACKEND_PORT/tcp" >/dev/null; then firewall-cmd --zone="$JM_ZONE" --remove-port="$JM_BACKEND_PORT/tcp"; fi
if firewall-cmd --permanent --zone="$JM_ZONE" --query-port="$JM_BACKEND_PORT/tcp" >/dev/null; then firewall-cmd --permanent --zone="$JM_ZONE" --remove-port="$JM_BACKEND_PORT/tcp"; fi
changed=0
rollback() {
  local exit_code=$?
  if [[ $changed == 1 && $exit_code != 0 ]]; then
    cp -p "$snapshot/server.env" "$env_file"
    cp -p "$snapshot/nginx.conf" /etc/nginx/nginx.conf
    chown "$JM_APP_USER:$JM_APP_USER" "$env_file"
    if [[ -d "$snapshot/previous-tls" ]]; then
      for tls_file in service.crt service.key ca.crt; do
        if [[ -f "$snapshot/previous-tls/$tls_file" ]]; then cp -p "$snapshot/previous-tls/$tls_file" "$tls_target/$tls_file"; fi
      done
      restorecon -RF "$tls_target" || true
    fi
    if grep -qx active "$snapshot/app-active"; then app_systemctl restart j-messenger || true; else app_systemctl stop j-messenger || true; fi
    if grep -qx active "$snapshot/nginx-active"; then systemctl restart nginx || true; else systemctl stop nginx || true; fi
    if ! grep -qx enabled "$snapshot/nginx-enabled"; then systemctl disable nginx || true; fi
    printf 'web.apply.failed snapshot=%s (review firewall/SELinux snapshots)\n' "$snapshot" >&2
  fi
}
trap rollback EXIT
changed=1
node "$script_dir/vm-profile.mjs" patch-env "$profile" "$env_file"
chown "$JM_APP_USER:$JM_APP_USER" "$env_file"
install -m 644 "$snapshot/candidate-nginx.conf" /etc/nginx/nginx.conf
restorecon /etc/nginx/nginx.conf
app_systemctl restart j-messenger
systemctl enable --now nginx
systemctl reload nginx
ready=(curl --fail --silent --max-time 3 "$JM_ORIGIN/health/ready")
if [[ $JM_PROTOCOL == https ]]; then ready+=(--cacert "$tls_source/ca.crt"); fi
for attempt in {1..20}; do
  if "${ready[@]}" >/dev/null; then
    printf 'web.ready %s snapshot=%s\n' "$JM_ORIGIN" "$snapshot"
    changed=0
    exit 0
  fi
  sleep 1
done
exit 20
