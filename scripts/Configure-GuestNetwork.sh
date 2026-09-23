#!/usr/bin/env bash
# Run on the Rocky guest console after Minimal installation.
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "Usage: sudo bash Configure-GuestNetwork.sh <IPv4/CIDR> <gateway> <DNS IPv4> <connection-name>" >&2
  exit 2
fi
if [[ $(id -u) -ne 0 ]]; then
  echo "Run as root." >&2
  exit 2
fi

address=$1
gateway=$2
dns=$3
connection=$4

nmcli connection show "$connection" >/dev/null
nmcli connection modify "$connection" \
  ipv4.method manual \
  ipv4.addresses "$address" \
  ipv4.gateway "$gateway" \
  ipv4.dns "$dns" \
  connection.autoconnect yes
nmcli connection up "$connection"
ip -4 address show
ip -4 route show
