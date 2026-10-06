#!/usr/bin/env bash
# Run on the operator's WSL host after configuring both strict SSH aliases.
set -euo pipefail
profile=${1:?profile.json required}
public_output=${2:?local public certificate directory required}
source "$(dirname "${BASH_SOURCE[0]}")/vm-profile.sh"
load_vm_profile "$profile"
[[ $JM_PROTOCOL == https || $JM_BACKEND_PROTOCOL == https ]] || { printf 'TLS not selected.\n'; exit 0; }
ssh_options=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5)
[[ $(ssh "${ssh_options[@]}" "$JM_SSH_APP" hostname) == "$JM_HOSTNAME" ]] || exit 10
ssh "${ssh_options[@]}" "$JM_SSH_APP" 'ip -4 address show' | grep -Fq "inet $JM_VM_IP/" || exit 11
umask 077
tls="$HOME/.local/share/j-messenger-vm/$JM_HOSTNAME/tls"
ca_directory=$(realpath -m "${3:-$tls}")
if [[ $# -ge 3 && ( ! -f "$ca_directory/ca.key" || ! -f "$ca_directory/ca.crt" ) ]]; then
  printf 'Requested CA directory must contain the existing ca.key and ca.crt.\n' >&2
  exit 13
fi
public_output=$(realpath -m "$public_output")
[[ $public_output != "$tls" && $public_output != "$tls/"* && $public_output != "$ca_directory" && $public_output != "$ca_directory/"* ]] || { printf 'Public output must be separate from the private CA directory.\n' >&2; exit 12; }
mkdir -p "$tls" "$ca_directory" "$public_output"
if [[ ! -f "$ca_directory/ca.key" ]]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 -days 365 \
    -keyout "$ca_directory/ca.key" -out "$ca_directory/ca.crt" -subj "/CN=J Messenger Development CA $JM_HOSTNAME" \
    -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
fi
chmod 600 "$ca_directory/ca.key"
ssh "${ssh_options[@]}" "$JM_SSH_APP" "bash -s -- '$JM_HOSTNAME' '$JM_VM_IP'" <<'REMOTE'
set -euo pipefail
umask 077
mkdir -p "$HOME/.config/j-messenger/tls"
cd "$HOME/.config/j-messenger/tls"
if [[ ! -f service.key ]]; then openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:prime256v1 -out service.key; fi
chmod 600 service.key
openssl req -new -key service.key -out service.csr -subj "/CN=$1" -addext "subjectAltName=IP:$2,DNS:$1"
REMOTE
scp -q "${ssh_options[@]}" "$JM_SSH_APP:.config/j-messenger/tls/service.csr" "$tls/service.csr"
printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:%s,DNS:%s\n' "$JM_VM_IP" "$JM_HOSTNAME" > "$tls/service.ext"
openssl x509 -req -in "$tls/service.csr" -CA "$ca_directory/ca.crt" -CAkey "$ca_directory/ca.key" -CAcreateserial -out "$tls/service.crt" -days 30 -sha256 -extfile "$tls/service.ext"
openssl verify -CAfile "$ca_directory/ca.crt" -verify_ip "$JM_VM_IP" "$tls/service.crt"
openssl verify -CAfile "$ca_directory/ca.crt" -verify_hostname "$JM_HOSTNAME" "$tls/service.crt"
scp -q "${ssh_options[@]}" "$tls/service.crt" "$ca_directory/ca.crt" "$JM_SSH_APP:.config/j-messenger/tls/"
cp "$ca_directory/ca.crt" "$public_output/ca.crt"
openssl x509 -in "$ca_directory/ca.crt" -outform DER -out "$public_output/ca.cer"
openssl x509 -in "$ca_directory/ca.crt" -noout -fingerprint -sha256
