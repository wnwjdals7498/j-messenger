#!/usr/bin/env bash
set -euo pipefail
[[ $(id -un) == jmsg && $(hostname) == j-messenger-lab ]] || exit 10
umask 077
cp -p "$HOME/.config/j-messenger/server.env" "$HOME/.config/j-messenger/server.env.before-direct-$(date -u +%Y%m%dT%H%M%SZ)"
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
const file = `${homedir()}/.config/j-messenger/server.env`;
const settings = Object.fromEntries(readFileSync(file, 'utf8').trim().split('\n').map((line) => {
  const at = line.indexOf('=');
  if (at < 1) throw new Error('invalid configuration');
  return [line.slice(0, at), line.slice(at + 1)];
}));
Object.assign(settings, { HOST: '127.0.0.1', PORT: '3443', PUBLIC_ORIGIN: 'https://10.77.0.10', SECURE_COOKIES: 'true' });
writeFileSync(file, Object.entries(settings).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 });
JS
systemctl --user restart j-messenger
for attempt in {1..20}; do
  if curl --fail --silent --cacert "$HOME/.config/j-messenger/tls/ca.crt" --max-time 2 https://10.77.0.10/health/ready > /dev/null; then
    printf 'vm.web.ready\n'
    exit 0
  fi
  sleep 1
done
printf 'vm.web.failed\n' >&2
exit 20
