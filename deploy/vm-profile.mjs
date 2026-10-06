import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PROFILE = Object.freeze({
  vmName: 'j-messenger-lab',
  hostname: 'j-messenger-lab',
  vmIp: '10.77.0.10',
  networkPrefix: '10.77.0.0/24',
  gateway: '10.77.0.1',
  dns: ['8.8.8.8', '1.1.1.1'],
  interfaceName: 'eth0',
  appUser: 'jmsg',
  sshAppAlias: 'jm-vm',
  sshAdminAlias: 'jm-vm-admin',
  switchName: 'JMessengerInternal',
  natName: 'JMessengerNat',
  protocol: 'https',
  publicPort: 443,
  backendProtocol: 'https',
  backendPort: 3443,
  redirectHttp: false,
  httpPort: 80,
  allowedSources: ['10.77.0.0/24', '172.16.0.0/12'],
  firewallZone: 'jm-clients',
});
const allowedKeys = new Set(Object.keys(DEFAULT_PROFILE));
const fail = (field) => {
  throw new Error(`Invalid VM setting: ${field}`);
};
function text(value, field, pattern, max = 63) {
  if (typeof value !== 'string' || value.length > max || !pattern.test(value))
    fail(field);
  return value;
}
function ip(value, field) {
  if (typeof value !== 'string' || isIP(value) !== 4) fail(field);
  return value;
}
function numberIp(value) {
  return value.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}
function privateIp(value) {
  const n = numberIp(value);
  return (
    (n >= 0x0a000000 && n <= 0x0affffff) ||
    (n >= 0xac100000 && n <= 0xac1fffff) ||
    (n >= 0xc0a80000 && n <= 0xc0a8ffff)
  );
}
function cidr(value, field) {
  if (typeof value !== 'string') fail(field);
  const parts = value.split('/');
  if (parts.length !== 2 || !/^(?:[1-9]|[12][0-9]|3[0-2])$/.test(parts[1]))
    fail(field);
  const address = ip(parts[0], field),
    bits = Number(parts[1]);
  const size = 2 ** (32 - bits),
    first = Math.floor(numberIp(address) / size) * size;
  if (
    numberIp(address) !== first ||
    !privateIp(address) ||
    !privateIp(
      [24, 16, 8, 0]
        .map((s) => Math.floor((first + size - 1) / 2 ** s) % 256)
        .join('.'),
    )
  )
    fail(field);
  return { text: value, first, last: first + size - 1, bits };
}
function port(value, field) {
  if (!Number.isInteger(value) || value < 1 || value > 65535 || value === 3001)
    fail(field);
  return value;
}
export function normalizeProfile(input = {}) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !allowedKeys.has(k))
  )
    fail('profile keys');
  const p = { ...DEFAULT_PROFILE, ...input };
  p.vmName = text(p.vmName, 'vmName', /^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
  p.hostname = text(
    p.hostname,
    'hostname',
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
  );
  p.vmIp = ip(p.vmIp, 'vmIp');
  const net = cidr(p.networkPrefix, 'networkPrefix');
  if (
    net.bits > 30 ||
    !privateIp(p.vmIp) ||
    numberIp(p.vmIp) <= net.first ||
    numberIp(p.vmIp) >= net.last
  )
    fail('vmIp/subnet');
  p.gateway = ip(p.gateway, 'gateway');
  if (
    p.gateway === p.vmIp ||
    numberIp(p.gateway) <= net.first ||
    numberIp(p.gateway) >= net.last
  )
    fail('gateway/subnet');
  if (!Array.isArray(p.dns) || !p.dns.length || p.dns.length > 3) fail('dns');
  p.dns = p.dns.map((v) => ip(v, 'dns'));
  for (const key of [
    'interfaceName',
    'sshAppAlias',
    'sshAdminAlias',
    'switchName',
    'natName',
    'firewallZone',
  ])
    p[key] = text(p[key], key, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
  p.appUser = text(p.appUser, 'appUser', /^[a-z_][a-z0-9_-]*$/, 32);
  if (p.appUser === 'root') fail('appUser');
  for (const key of ['protocol', 'backendProtocol'])
    if (!['http', 'https'].includes(p[key])) fail(key);
  for (const key of ['publicPort', 'backendPort', 'httpPort'])
    p[key] = port(p[key], key);
  if (
    typeof p.redirectHttp !== 'boolean' ||
    (p.redirectHttp && p.protocol !== 'https')
  )
    fail('redirectHttp');
  const activePorts = [
    p.publicPort,
    p.backendPort,
    ...(p.redirectHttp ? [p.httpPort] : []),
  ];
  if (new Set(activePorts).size !== activePorts.length) fail('port collision');
  if (
    !Array.isArray(p.allowedSources) ||
    !p.allowedSources.length ||
    p.allowedSources.length > 8
  )
    fail('allowedSources');
  p.allowedSources = [
    ...new Set(p.allowedSources.map((v) => cidr(v, 'allowedSources').text)),
  ];
  if (
    !p.allowedSources.some((v) => {
      const n = cidr(v, 'allowedSources');
      return numberIp(p.gateway) >= n.first && numberIp(p.gateway) <= n.last;
    })
  )
    fail('gateway/allowedSources');
  return p;
}
export const originOf = (p) =>
  `${p.protocol}://${p.vmIp}${p.publicPort === (p.protocol === 'https' ? 443 : 80) ? '' : ':' + p.publicPort}`;
export function shellSettings(p) {
  p = normalizeProfile(p);
  return {
    JM_VM_NAME: p.vmName,
    JM_HOSTNAME: p.hostname,
    JM_VM_IP: p.vmIp,
    JM_VM_CIDR: `${p.vmIp}/${p.networkPrefix.split('/')[1]}`,
    JM_NETWORK_PREFIX: p.networkPrefix,
    JM_GATEWAY: p.gateway,
    JM_DNS: p.dns.join(','),
    JM_INTERFACE: p.interfaceName,
    JM_APP_USER: p.appUser,
    JM_APP_HOME: `/home/${p.appUser}`,
    JM_SSH_APP: p.sshAppAlias,
    JM_SSH_ADMIN: p.sshAdminAlias,
    JM_PROTOCOL: p.protocol,
    JM_PUBLIC_PORT: String(p.publicPort),
    JM_ORIGIN: originOf(p),
    JM_BACKEND_PROTOCOL: p.backendProtocol,
    JM_BACKEND_PORT: String(p.backendPort),
    JM_REDIRECT: p.redirectHttp ? '1' : '0',
    JM_HTTP_PORT: String(p.httpPort),
    JM_SOURCES: p.allowedSources.join(','),
    JM_ZONE: p.firewallZone,
  };
}
export function renderNginx(p) {
  p = normalizeProfile(p);
  const tls = `/etc/nginx/j-messenger/${p.hostname}`;
  const redirect = p.redirectHttp
    ? `    server {\n        listen ${p.vmIp}:${p.httpPort};\n        server_name ${p.vmIp};\n        if ($host != '${p.vmIp}') { return 421; }\n        return 308 ${originOf(p)}$request_uri;\n    }\n`
    : '';
  const publicTls =
    p.protocol === 'https'
      ? `        ssl_certificate ${tls}/service.crt;\n        ssl_certificate_key ${tls}/service.key;\n        ssl_protocols TLSv1.2 TLSv1.3;\n`
      : '';
  const upstreamTls =
    p.backendProtocol === 'https'
      ? `            proxy_ssl_trusted_certificate ${tls}/ca.crt;\n            proxy_ssl_verify on;\n            proxy_ssl_verify_depth 2;\n            proxy_ssl_server_name on;\n            proxy_ssl_name ${p.hostname};\n`
      : '';
  return `# Managed j-messenger dedicated VM: ${p.hostname}\nuser nginx;\nworker_processes auto;\npid /run/nginx.pid;\nerror_log /dev/null;\ninclude /usr/share/nginx/modules/*.conf;\nevents { worker_connections 1024; }\nhttp {\n    include /etc/nginx/mime.types;\n    default_type application/octet-stream;\n    access_log off;\n    server_tokens off;\n    sendfile on;\n    keepalive_timeout 65;\n    map $http_upgrade $jm_connection { default upgrade; '' close; }\n${redirect}    server {\n        listen ${p.vmIp}:${p.publicPort}${p.protocol === 'https' ? ' ssl' : ''};\n        server_name ${p.vmIp};\n${publicTls}        client_max_body_size 5065536;\n        if ($host != '${p.vmIp}') { return 421; }\n        location / {\n            proxy_pass ${p.backendProtocol}://127.0.0.1:${p.backendPort};\n${upstreamTls}            proxy_http_version 1.1;\n            proxy_set_header Host $http_host;\n            proxy_set_header Origin $http_origin;\n            proxy_set_header Upgrade $http_upgrade;\n            proxy_set_header Connection $jm_connection;\n            proxy_set_header X-Forwarded-Proto ${p.protocol};\n            proxy_buffering off;\n            proxy_request_buffering off;\n            proxy_connect_timeout 5s;\n            proxy_read_timeout 75s;\n            proxy_send_timeout 30s;\n        }\n    }\n}\n`;
}
export function patchEnvironment(p, raw, appHome = `/home/${p.appUser}`) {
  p = normalizeProfile(p);
  if (appHome !== `/home/${p.appUser}`) fail('app home');
  const settings = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1 || !/^[A-Z][A-Z0-9_]*$/.test(line.slice(0, at)))
      fail('server.env');
    settings[line.slice(0, at)] = line.slice(at + 1);
  }
  if (settings.NODE_ENV === 'production' || settings.AUTH_MODE === 'mail')
    fail('production/mail environment is outside this lab setup');
  const defaults = {
    DB_PATH: `${appHome}/data/j-messenger.sqlite`,
    FILE_ROOT: `${appHome}/data/files`,
    TEMP_ROOT: `${appHome}/data/tmp`,
    BACKUP_ROOT: `${appHome}/data/backups`,
    WEB_DIST: `${appHome}/app/current/apps/web/dist`,
    CURSOR_SIGNING_KEY: randomBytes(32).toString('base64url'),
    MAIL_SERVERS: 'dev-a,dev-b',
    FEATURE_FILES: 'true',
    FEATURE_RECEIPTS: 'true',
    FEATURE_RETENTION: 'true',
    FEATURE_NATIVE_SESSIONS: 'true',
    FEATURE_NOTIFICATIONS: 'false',
    FILE_QUOTA_BYTES: '2000000000',
    SESSION_DAYS: '7',
    LOG_LEVEL: 'info',
  };
  for (const [key, value] of Object.entries(defaults)) settings[key] ??= value;
  Object.assign(settings, {
    NODE_ENV: 'development',
    AUTH_MODE: 'development-fixed',
    HOST: '127.0.0.1',
    PORT: String(p.backendPort),
    PUBLIC_ORIGIN: originOf(p),
    SECURE_COOKIES: p.protocol === 'https' ? 'true' : 'false',
  });
  if (p.backendProtocol === 'https')
    Object.assign(settings, {
      TLS_CERT_PATH: `${appHome}/.config/j-messenger/tls/service.crt`,
      TLS_KEY_PATH: `${appHome}/.config/j-messenger/tls/service.key`,
    });
  else {
    delete settings.TLS_CERT_PATH;
    delete settings.TLS_KEY_PATH;
  }
  return Object.entries(settings)
    .map(([k, v]) => `${k}=${v}\n`)
    .join('');
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const [command, configFile, target] = process.argv.slice(2);
    const p = normalizeProfile(
      JSON.parse(readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')),
    );
    if (command === 'env')
      process.stdout.write(
        Object.entries(shellSettings(p))
          .map(([k, v]) => `${k}=${v}\n`)
          .join(''),
      );
    else if (command === 'nginx') process.stdout.write(renderNginx(p));
    else if (command === 'check-env') {
      if (!target) fail('env path');
      patchEnvironment(p, readFileSync(target, 'utf8'));
    } else if (command === 'patch-env') {
      if (!target) fail('env path');
      const next = `${target}.profile-next`;
      writeFileSync(next, patchEnvironment(p, readFileSync(target, 'utf8')), {
        mode: 0o600,
        flag: 'wx',
      });
      renameSync(next, target);
    } else fail('command');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
