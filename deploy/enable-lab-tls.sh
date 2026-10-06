#!/usr/bin/env bash
set -euo pipefail
[[ $(id -un) == jmsg && $(hostname) == j-messenger-lab ]] || exit 10
tls="$HOME/.config/j-messenger/tls"
openssl verify -CAfile "$tls/ca.crt" "$tls/service.crt"
openssl x509 -in "$tls/service.crt" -noout -checkip 10.77.0.10
openssl pkey -in "$tls/service.key" -check -noout >/dev/null
umask 077
cp -p "$HOME/.config/j-messenger/server.env" "$HOME/.config/j-messenger/server.env.http-$(date -u +%Y%m%dT%H%M%SZ)"
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
const home = homedir();
const path = `${home}/.config/j-messenger/server.env`;
const settings = Object.fromEntries(readFileSync(path, 'utf8').trim().split('\n').map((line) => {
  const at = line.indexOf('=');
  if (at < 1) throw new Error('invalid configuration');
  return [line.slice(0, at), line.slice(at + 1)];
}));
Object.assign(settings, {
  PORT: '3443', PUBLIC_ORIGIN: 'https://10.77.0.10:3443', SECURE_COOKIES: 'true',
  TLS_CERT_PATH: `${home}/.config/j-messenger/tls/service.crt`,
  TLS_KEY_PATH: `${home}/.config/j-messenger/tls/service.key`,
});
writeFileSync(path, Object.entries(settings).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 });
JS
systemctl --user restart j-messenger
for attempt in {1..20}; do
  if curl --fail --silent --cacert "$tls/ca.crt" --max-time 2 https://10.77.0.10:3443/health/ready > /dev/null; then
    printf 'lab.tls.ready\n'
    exit 0
  fi
  sleep 1
done
printf 'lab.tls.failed\n' >&2
exit 20
