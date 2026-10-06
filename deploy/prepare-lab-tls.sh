#!/usr/bin/env bash
set -euo pipefail
[[ $(id -un) == jjm ]] || exit 10
umask 077
tls="$HOME/.local/share/j-messenger-lab/tls"
mkdir -p "$tls"
ssh_options=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5)
[[ $(ssh "${ssh_options[@]}" jm-vm hostname) == j-messenger-lab ]] || exit 11
if [[ ! -f "$tls/ca.key" ]]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 -days 365 \
    -keyout "$tls/ca.key" -out "$tls/ca.crt" -subj '/CN=J Messenger Lab Development CA' \
    -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
fi
chmod 600 "$tls/ca.key"
ssh "${ssh_options[@]}" jm-vm 'umask 077; mkdir -p ~/.config/j-messenger/tls; if test ! -f ~/.config/j-messenger/tls/service.key; then openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout ~/.config/j-messenger/tls/service.key -out ~/.config/j-messenger/tls/service.csr -subj /CN=j-messenger-lab -addext subjectAltName=IP:10.77.0.10,DNS:j-messenger-lab; fi'
scp -q "${ssh_options[@]}" jm-vm:.config/j-messenger/tls/service.csr "$tls/service.csr"
cat > "$tls/service.ext" <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=IP:10.77.0.10,DNS:j-messenger-lab
EXT
openssl x509 -req -in "$tls/service.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial \
  -out "$tls/service.crt" -days 30 -sha256 -extfile "$tls/service.ext"
openssl verify -CAfile "$tls/ca.crt" "$tls/service.crt"
scp -q "${ssh_options[@]}" "$tls/service.crt" "$tls/ca.crt" jm-vm:.config/j-messenger/tls/
public_copy=/mnt/d/workspace/test-space/github/j-messenger/.tools/vm-deploy/tls
mkdir -p "$public_copy"
cp "$tls/ca.crt" "$public_copy/ca.crt"
openssl x509 -in "$tls/ca.crt" -noout -subject -fingerprint -sha256
