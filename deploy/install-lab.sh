#!/usr/bin/env bash
set -euo pipefail

# This is a private development lab deployment, not production mail authentication.
profile=${3:-}
if [[ -n $profile ]]; then
  profile=$(realpath "$profile")
  source "$(dirname "${BASH_SOURCE[0]}")/vm-profile.sh"
  load_vm_profile "$profile"
  [[ $(id -un) == "$JM_APP_USER" && $(hostname) == "$JM_HOSTNAME" && $HOME == "$JM_APP_HOME" ]] || exit 10
else
  [[ $(id -un) == jmsg && $(hostname) == j-messenger-lab ]] || exit 10
fi
release=${1:?release identifier required}
expected_hash=${2:?archive checksum required}
[[ $release =~ ^[a-f0-9]{7,40}-[0-9TZ]+$ && $expected_hash =~ ^[a-f0-9]{64}$ ]] || exit 11
umask 077
archive="$HOME/app/releases/$release.tar.gz"
destination="$HOME/app/releases/$release"
[[ -f $archive && ! -e $destination ]] || exit 12
printf '%s  %s\n' "$expected_hash" "$archive" | sha256sum --check --status
mkdir -m 700 "$destination"
tar -xzf "$archive" --no-same-owner -C "$destination"
cd "$destination"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=warn
node --input-type=module -e 'await import("./apps/server/dist/bootstrap/application.js"); console.log("release.import.valid")'

configuration="$HOME/.config/j-messenger"
snapshot="$configuration/deploy-snapshots/$release"
mkdir -p "$snapshot" "$HOME/.config/systemd/user" "$HOME/data/files" "$HOME/data/tmp" "$HOME/data/backups"
if [[ -f "$configuration/server.env" ]]; then cp -p "$configuration/server.env" "$snapshot/server.env"; fi
if [[ -f "$HOME/.config/systemd/user/j-messenger.service" ]]; then cp -p "$HOME/.config/systemd/user/j-messenger.service" "$snapshot/j-messenger.service"; fi
if [[ -L "$HOME/app/current" ]]; then
  previous=$(readlink -f "$HOME/app/current")
  [[ $previous == "$HOME/app/releases/"* ]] || exit 13
  printf '%s\n' "$previous" > "$snapshot/previous-release"
elif [[ -e "$HOME/app/current" ]]; then
  exit 14
fi
systemctl --user is-enabled j-messenger > "$snapshot/previous-enabled" 2>/dev/null || true

RELEASE_ID="$release" node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
const home = homedir();
const path = `${home}/.config/j-messenger/server.env`;
let key;
let previous = {};
try {
  const raw = readFileSync(path, 'utf8');
  key = raw.match(/^CURSOR_SIGNING_KEY=([A-Za-z0-9_-]{43,})$/m)?.[1];
  previous = Object.fromEntries(raw.trim().split('\n').filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
} catch {}
key ??= randomBytes(32).toString('base64url');
const settings = {
  NODE_ENV: 'development', AUTH_MODE: 'development-fixed', HOST: '10.77.0.10', PORT: '3000',
  PUBLIC_ORIGIN: 'http://10.77.0.10:3000', SECURE_COOKIES: 'false',
  DB_PATH: `${home}/data/j-messenger.sqlite`, FILE_ROOT: `${home}/data/files`,
  TEMP_ROOT: `${home}/data/tmp`, BACKUP_ROOT: `${home}/data/backups`,
  WEB_DIST: `${home}/app/current/apps/web/dist`, CURSOR_SIGNING_KEY: key,
  MAIL_SERVERS: 'dev-a,dev-b', FEATURE_FILES: 'true', FEATURE_RECEIPTS: 'true',
  FEATURE_RETENTION: 'true', FEATURE_NATIVE_SESSIONS: 'true', FEATURE_NOTIFICATIONS: 'false',
  FILE_QUOTA_BYTES: '2000000000', SESSION_DAYS: '7', LOG_LEVEL: 'info', RELEASE: process.env.RELEASE_ID,
};
if (previous.PORT === '3443' && ['https://10.77.0.10:3443', 'https://10.77.0.10'].includes(previous.PUBLIC_ORIGIN) &&
  previous.TLS_CERT_PATH === `${home}/.config/j-messenger/tls/service.crt` &&
  previous.TLS_KEY_PATH === `${home}/.config/j-messenger/tls/service.key`) {
  Object.assign(settings, { HOST: previous.PUBLIC_ORIGIN === 'https://10.77.0.10' ? '127.0.0.1' : '10.77.0.10', PORT: previous.PORT, PUBLIC_ORIGIN: previous.PUBLIC_ORIGIN, SECURE_COOKIES: 'true',
    TLS_CERT_PATH: previous.TLS_CERT_PATH, TLS_KEY_PATH: previous.TLS_KEY_PATH });
}
if (process.env.JM_HOSTNAME) {
  Object.assign(settings, previous, { RELEASE: process.env.RELEASE_ID, WEB_DIST: `${home}/app/current/apps/web/dist` });
}
writeFileSync(`${path}.next`, Object.entries(settings).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 });
JS

if [[ -n $profile ]]; then
  node deploy/vm-profile.mjs patch-env "$profile" "$configuration/server.env.next"
fi

systemctl --user stop j-messenger
database_file="$HOME/data/j-messenger.sqlite"
if [[ -n $profile && -f "$configuration/server.env" ]]; then
  configured_database=$(sed -n 's/^DB_PATH=//p' "$configuration/server.env")
  [[ -z $configured_database || $configured_database == /* ]] || exit 15
  if [[ -n $configured_database ]]; then database_file=$configured_database; fi
fi
if [[ -f $database_file ]]; then
  BACKUP_PATH="$snapshot/pre-upgrade.sqlite" DATABASE_PATH="$database_file" node --input-type=module <<'JS'
import { DatabaseSync, backup } from 'node:sqlite';
import { homedir } from 'node:os';
const database = new DatabaseSync(process.env.DATABASE_PATH, { readOnly: true });
try { await backup(database, process.env.BACKUP_PATH); } finally { database.close(); }
JS
fi
mv "$configuration/server.env.next" "$configuration/server.env"
install -m 600 deploy/j-messenger.service "$HOME/.config/systemd/user/j-messenger.service"
ln -s "$destination" "$HOME/app/current.$release"
mv -T "$HOME/app/current.$release" "$HOME/app/current"
systemctl --user daemon-reload
systemctl --user enable --now j-messenger
for attempt in {1..20}; do
  if [[ -n $profile && $JM_BACKEND_PROTOCOL == https ]]; then
    ready=(curl --fail --silent --cacert "$configuration/tls/ca.crt" --resolve "$JM_HOSTNAME:$JM_BACKEND_PORT:127.0.0.1" --max-time 2 "https://$JM_HOSTNAME:$JM_BACKEND_PORT/health/ready")
  elif [[ -n $profile ]]; then
    ready=(curl --fail --silent --max-time 2 "http://127.0.0.1:$JM_BACKEND_PORT/health/ready")
  elif grep -qx 'PORT=3443' "$configuration/server.env"; then
    if grep -qx 'PUBLIC_ORIGIN=https://10.77.0.10' "$configuration/server.env"; then
      ready=(curl --fail --silent --cacert "$configuration/tls/ca.crt" --max-time 2 https://10.77.0.10/health/ready)
    else
      ready=(curl --fail --silent --cacert "$configuration/tls/ca.crt" --max-time 2 https://10.77.0.10:3443/health/ready)
    fi
  else
    ready=(curl --fail --silent --max-time 2 http://10.77.0.10:3000/health/ready)
  fi
  if "${ready[@]}" > /dev/null; then
    printf 'release.active %s\n' "$release"
    exit 0
  fi
  sleep 1
done
systemctl --user stop j-messenger
if [[ -f "$snapshot/previous-release" ]]; then
  ln -s "$(cat "$snapshot/previous-release")" "$HOME/app/current.rollback.$release"
  mv -T "$HOME/app/current.rollback.$release" "$HOME/app/current"
fi
if [[ -f "$snapshot/server.env" ]]; then cp -p "$snapshot/server.env" "$configuration/server.env"; fi
if [[ -f "$snapshot/j-messenger.service" ]]; then cp -p "$snapshot/j-messenger.service" "$HOME/.config/systemd/user/j-messenger.service"; fi
systemctl --user daemon-reload
if grep -qx enabled "$snapshot/previous-enabled"; then systemctl --user enable --now j-messenger; else systemctl --user disable j-messenger; fi
printf 'release.failed %s\n' "$release" >&2
exit 20
