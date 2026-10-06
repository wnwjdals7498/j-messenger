#!/usr/bin/env bash
set -euo pipefail
[[ $(hostname) == j-messenger-lab && $(id -u) == 0 ]] || exit 10
source_file=${1:?configuration file required}
[[ $source_file == /home/jjm/.local/share/j-messenger-lab/journald-lab.conf && -f $source_file ]] || exit 11
configuration=/etc/systemd/journald.conf.d/90-j-messenger-lab.conf
install -d -m 755 /etc/systemd/journald.conf.d
if [[ -f $configuration ]]; then
  install -d -m 700 /root/j-messenger-lab-deploy-backups
  cp -p "$configuration" "/root/j-messenger-lab-deploy-backups/journald-$(date -u +%Y%m%dT%H%M%SZ).conf"
fi
install -m 644 "$source_file" "$configuration"
install -d -m 2755 -o root -g systemd-journal /var/log/journal
systemd-tmpfiles --create --prefix /var/log/journal
systemctl restart systemd-journald
journalctl --flush
systemd-analyze cat-config systemd/journald.conf | grep -E '^(Storage|SplitMode|SystemMaxUse|SystemKeepFree|MaxRetentionSec|Compress)='
