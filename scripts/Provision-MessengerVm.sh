#!/usr/bin/env bash
# Provision the j-messenger lab VM (Rocky Linux 10). Idempotent. Run from WSL:
#   ssh jm-vm-admin "sudo bash -s -- '$(cat ~/.ssh/id_ed25519_jm.pub)'" < scripts/Provision-MessengerVm.sh
# Leaves the network on the current profile; the new static profile applies on next boot.
set -euo pipefail

if [[ $# -ne 1 || $1 != ssh-* ]]; then
  echo "Usage: sudo bash Provision-MessengerVm.sh '<ssh public key for jmsg>'" >&2
  exit 2
fi
if [[ $(id -u) -ne 0 ]]; then
  echo "Run as root." >&2
  exit 2
fi
pubkey=$1
app_user=jmsg
vm_cidr=10.77.0.10/24
gateway=10.77.0.1
dns=8.8.8.8,1.1.1.1
app_port=3000

echo "== host name and time"
hostnamectl set-hostname j-messenger-lab
timedatectl set-timezone Asia/Seoul

echo "== packages"
dnf -y -q install nodejs tar hyperv-daemons
systemctl enable --now hypervkvpd.service || true
node --version

echo "== app user $app_user (no sudo)"
if ! id "$app_user" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$app_user"
fi
home=/home/$app_user
install -d -m 700 -o "$app_user" -g "$app_user" "$home/.ssh"
if ! grep -qxF "$pubkey" "$home/.ssh/authorized_keys" 2>/dev/null; then
  echo "$pubkey" >> "$home/.ssh/authorized_keys"
fi
chown "$app_user:$app_user" "$home/.ssh/authorized_keys"
chmod 600 "$home/.ssh/authorized_keys"
restorecon -R "$home/.ssh"
for dir in app data .config/j-messenger .config/systemd/user; do
  install -d -m 700 -o "$app_user" -g "$app_user" "$home/$dir"
done
chown "$app_user:$app_user" "$home/.config"
loginctl enable-linger "$app_user"

env_file=$home/.config/j-messenger/server.env
if [[ ! -f $env_file ]]; then
  cat > "$env_file" <<EOF
NODE_ENV=production
HOST=0.0.0.0
PORT=$app_port
DB_PATH=$home/data/j-messenger.sqlite
WEB_DIST=$home/app/web/dist
EOF
fi
chown "$app_user:$app_user" "$env_file"
chmod 600 "$env_file"

unit=$home/.config/systemd/user/j-messenger.service
cat > "$unit" <<'EOF'
[Unit]
Description=j-messenger server
After=network-online.target

[Service]
WorkingDirectory=%h/app/server
EnvironmentFile=%h/.config/j-messenger/server.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/index.ts
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF
chown "$app_user:$app_user" "$unit"
chmod 644 "$unit"

echo "== ssh: keys only"
printf 'PasswordAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/10-j-messenger.conf
chmod 600 /etc/ssh/sshd_config.d/10-j-messenger.conf
sshd -t
systemctl reload sshd

echo "== firewall: ssh + app port only from the host-only network and WSL NAT range"
if ! firewall-cmd --permanent --get-zones | tr ' ' '\n' | grep -qx jm-clients; then
  firewall-cmd --permanent --new-zone=jm-clients
fi
for src in 10.77.0.0/24 172.16.0.0/12; do
  firewall-cmd --permanent --zone=jm-clients --query-source="$src" >/dev/null ||
    firewall-cmd --permanent --zone=jm-clients --add-source="$src"
done
firewall-cmd --permanent --zone=jm-clients --add-service=ssh
firewall-cmd --permanent --zone=jm-clients --add-port="$app_port/tcp"
firewall-cmd --permanent --zone=public --remove-service=cockpit || true
firewall-cmd --reload

echo "== network: static profile jm-internal ($vm_cidr) for next boot"
old=$(nmcli -g NAME,DEVICE connection show | awk -F: '$2 == "eth0" && $1 != "jm-internal" {print $1; exit}')
if ! nmcli -g NAME connection show | grep -qx jm-internal; then
  nmcli connection add type ethernet ifname eth0 con-name jm-internal \
    ipv4.method manual ipv4.addresses "$vm_cidr" ipv4.gateway "$gateway" ipv4.dns "$dns" \
    ipv6.method disabled connection.autoconnect yes connection.autoconnect-priority 10
fi
if [[ -n $old ]]; then
  nmcli connection modify "$old" connection.autoconnect no
fi
nmcli -f NAME,DEVICE,AUTOCONNECT,AUTOCONNECT-PRIORITY connection show

echo "PROVISION_OK"
