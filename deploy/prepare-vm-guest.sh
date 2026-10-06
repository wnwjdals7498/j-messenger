#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || exit 10
profile=${1:?profile.json required}
public_key=${2:-}
command -v node >/dev/null || { printf 'Install official Rocky Node.js >=22.18 first.\n' >&2; exit 11; }
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22 || (major===22 && minor<18)) process.exit(1);'
source "$(dirname "${BASH_SOURCE[0]}")/vm-profile.sh"
load_vm_profile "$profile"
command -v nmcli >/dev/null
ip link show "$JM_INTERFACE" >/dev/null
ip -4 address show "$JM_INTERFACE" | grep -Fq "inet $JM_VM_IP/" || { printf 'Install/select the profile IP on this VM NIC first.\n' >&2; exit 15; }
if id "$JM_APP_USER" >/dev/null 2>&1 && id -nG "$JM_APP_USER" | tr ' ' '\n' | grep -Eq '^(wheel|sudo)$'; then
  printf 'Choose an application account without administrator groups.\n' >&2
  exit 16
fi
if [[ -n $public_key ]]; then [[ -f $public_key && $(wc -l < "$public_key") -le 1 ]] || exit 13; fi
dnf -y install nginx openssl tar policycoreutils-python-utils openssh-clients
if [[ -n $public_key ]]; then ssh-keygen -l -f "$public_key" >/dev/null; fi
if ! id "$JM_APP_USER" >/dev/null 2>&1; then useradd --create-home --shell /bin/bash "$JM_APP_USER"; fi
[[ $(getent passwd "$JM_APP_USER" | cut -d: -f6) == "$JM_APP_HOME" ]] || exit 12
for folder in app/releases data/files data/tmp data/backups .config/j-messenger .config/systemd/user; do
  install -d -m 700 -o "$JM_APP_USER" -g "$JM_APP_USER" "$JM_APP_HOME/$folder"
done
if [[ -n $public_key ]]; then
  install -d -m 700 -o "$JM_APP_USER" -g "$JM_APP_USER" "$JM_APP_HOME/.ssh"
  key=$(cat "$public_key")
  [[ $key == ssh-* || $key == ecdsa-* ]] || exit 14
  if ! grep -Fxq "$key" "$JM_APP_HOME/.ssh/authorized_keys" 2>/dev/null; then printf '%s\n' "$key" >> "$JM_APP_HOME/.ssh/authorized_keys"; fi
  chown "$JM_APP_USER:$JM_APP_USER" "$JM_APP_HOME/.ssh/authorized_keys"
  chmod 600 "$JM_APP_HOME/.ssh/authorized_keys"
  restorecon -RF "$JM_APP_HOME/.ssh"
fi
loginctl enable-linger "$JM_APP_USER"
hostnamectl set-hostname "$JM_HOSTNAME"
connection="jm-$JM_HOSTNAME"
if ! nmcli -g NAME connection show | grep -Fxq "$connection"; then
  nmcli connection add type ethernet ifname "$JM_INTERFACE" con-name "$connection" ipv4.method manual \
    ipv4.addresses "$JM_VM_CIDR" ipv4.gateway "$JM_GATEWAY" ipv4.dns "$JM_DNS" ipv6.method disabled \
    connection.autoconnect yes connection.autoconnect-priority 50
else
  nmcli connection modify "$connection" ipv4.method manual ipv4.addresses "$JM_VM_CIDR" \
    ipv4.gateway "$JM_GATEWAY" ipv4.dns "$JM_DNS" ipv6.method disabled connection.autoconnect yes connection.autoconnect-priority 50
fi
printf 'guest.prepared %s %s (network activates on next boot; SSH settings unchanged)\n' "$JM_HOSTNAME" "$JM_VM_CIDR"
