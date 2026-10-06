import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  normalizeProfile,
  originOf,
  renderNginx,
  patchEnvironment,
  shellSettings,
} from '../../deploy/vm-profile.mjs';
import { createBundle } from '../../scripts/setup-vm.mjs';

test('default HTTPS keeps private Node TLS, strict upstream identity and WSS/Origin', () => {
  const p = normalizeProfile(),
    config = renderNginx(p);
  assert.equal(originOf(p), 'https://10.77.0.10');
  assert.match(config, /listen 10\.77\.0\.10:443 ssl/);
  assert.match(config, /proxy_pass https:\/\/127\.0\.0\.1:3443/);
  assert.match(config, /proxy_ssl_verify on/);
  assert.match(config, /proxy_ssl_name j-messenger-lab/);
  assert.match(config, /proxy_set_header Origin \$http_origin/);
  assert.match(config, /proxy_set_header Upgrade \$http_upgrade/);
  assert.match(config, /proxy_set_header Host \$http_host/);
});
test('alternative VM/network/ports and redirect produce one coherent profile', () => {
  const p = normalizeProfile({
    vmName: 'office-chat',
    hostname: 'office-chat',
    vmIp: '192.168.50.20',
    networkPrefix: '192.168.50.0/24',
    gateway: '192.168.50.1',
    allowedSources: ['192.168.50.0/24'],
    publicPort: 8443,
    backendPort: 9443,
    redirectHttp: true,
    httpPort: 8080,
  });
  assert.equal(originOf(p), 'https://192.168.50.20:8443');
  const config = renderNginx(p);
  assert.match(
    config,
    /return 308 https:\/\/192\.168\.50\.20:8443\$request_uri/,
  );
  assert.match(config, /proxy_pass https:\/\/127\.0\.0\.1:9443/);
  assert.doesNotMatch(config, /10\.77\.0\.10|j-messenger-lab|:3443/);
  assert.equal(shellSettings(p).JM_VM_CIDR, '192.168.50.20/24');
});
test('HTTP profile removes stale Node TLS and uses explicit insecure lab cookies', () => {
  const p = normalizeProfile({
    protocol: 'http',
    publicPort: 8080,
    backendProtocol: 'http',
    backendPort: 3080,
  });
  const config = renderNginx(p),
    env = patchEnvironment(
      p,
      'TLS_CERT_PATH=/old/cert\nTLS_KEY_PATH=/old/key\nCURSOR_SIGNING_KEY=test-existing-key-that-is-not-a-real-secret\n',
    );
  assert.doesNotMatch(config, /ssl_certificate|proxy_ssl_/);
  assert.match(config, /proxy_pass http:\/\/127\.0\.0\.1:3080/);
  assert.match(env, /PUBLIC_ORIGIN=http:\/\/10\.77\.0\.10:8080/);
  assert.match(env, /SECURE_COOKIES=false/);
  assert.doesNotMatch(env, /TLS_CERT_PATH|TLS_KEY_PATH/);
});
test('TLS termination can keep HTTPS cookies with HTTP only on loopback', () => {
  const p = normalizeProfile({ backendProtocol: 'http', backendPort: 3080 });
  assert.match(renderNginx(p), /ssl_certificate /);
  assert.doesNotMatch(renderNginx(p), /proxy_ssl_verify/);
  const env = patchEnvironment(p, 'TLS_CERT_PATH=/old\nTLS_KEY_PATH=/old\n');
  assert.match(env, /SECURE_COOKIES=true/);
  assert.match(env, /HOST=127\.0\.0\.1/);
  assert.doesNotMatch(env, /TLS_CERT_PATH/);
});
test('env patch preserves cursor key, business paths, sessions and other settings', () => {
  const raw =
    'DB_PATH=/srv/custom/chat.sqlite\nFILE_ROOT=/srv/custom/files\nCURSOR_SIGNING_KEY=test-key-preserved-12345678901234567890\nMAIL_SERVERS=realm-one\nSESSION_DAYS=4\nRELEASE=known-release\n';
  const result = patchEnvironment(normalizeProfile(), raw);
  for (const line of raw.trim().split('\n'))
    assert.ok(result.includes(line + '\n'));
  assert.match(
    result,
    /TLS_CERT_PATH=\/home\/jmsg\/\.config\/j-messenger\/tls\/service\.crt/,
  );
});
test('production/mail authentication cannot be downgraded by lab patching', () => {
  assert.throws(
    () =>
      patchEnvironment(
        normalizeProfile(),
        'NODE_ENV=production\nAUTH_MODE=mail\n',
      ),
    /production\/mail/,
  );
  assert.throws(
    () =>
      patchEnvironment(
        normalizeProfile(),
        'NODE_ENV=development\nAUTH_MODE=mail\n',
      ),
    /production\/mail/,
  );
});

test('shell injection, wrong protocols and unknown fields fail before rendering', () => {
  for (const p of [
    { hostname: 'x; touch /tmp/pwned' },
    { vmName: "x'" },
    { sshAppAlias: '-ProxyCommand' },
    { interfaceName: 'eth0$(id)' },
    { protocol: 'ftp' },
    { backendProtocol: 'file' },
    { appUser: 'root' },
    { unexpected: true },
  ])
    assert.throws(() => normalizeProfile(p), /Invalid VM setting/);
});
test('network/broadcast/outside-subnet/gateway and public CIDRs are rejected', () => {
  for (const p of [
    { vmIp: '10.77.0.0' },
    { vmIp: '10.77.0.255' },
    { vmIp: '10.78.0.10' },
    { gateway: '10.77.0.10' },
    { gateway: '10.78.0.1' },
    { networkPrefix: '10.77.0.1/24' },
    { networkPrefix: '10.77.0.0/33' },
    { allowedSources: ['0.0.0.0/0'] },
    { allowedSources: ['192.168.0.0/16'] },
  ])
    assert.throws(() => normalizeProfile(p));
});
test('prohibited port 3001, collisions and redirect on HTTP are rejected', () => {
  for (const p of [
    { publicPort: 3001 },
    { backendPort: 3001 },
    { httpPort: 3001 },
    { backendPort: 443 },
    { publicPort: 0 },
    { redirectHttp: true, httpPort: 443 },
    { protocol: 'http', publicPort: 80, redirectHttp: true },
  ])
    assert.throws(() => normalizeProfile(p));
});
test('bundle/CLI generate reviewable files and never overwrite an existing plan', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'jm-vm-profile-'));
  const target = path.join(parent, 'generated');
  const result = await createBundle(
    { vmName: 'qa-vm', hostname: 'qa-vm' },
    target,
  );
  const plan = JSON.parse(
    await readFile(path.join(target, 'plan.json'), 'utf8'),
  );
  assert.equal(plan.applied, false);
  assert.equal(plan.vmName, 'qa-vm');
  assert.equal(
    await readFile(path.join(target, 'nginx.conf'), 'utf8'),
    renderNginx(result.profile),
  );
  assert.match(
    await readFile(path.join(target, 'create-vm.ps1'), 'utf8'),
    /-VmName 'qa-vm' -VmAddress '10\.77\.0\.10'/,
  );
  await assert.rejects(createBundle({}, target), /already|이미/);
  const command = spawnSync(
    process.execPath,
    [
      'scripts/setup-vm.mjs',
      '--config',
      path.join(target, 'profile.json'),
      '--output',
      path.join(parent, 'cli'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(command.status, 0, command.stderr);
  assert.match(command.stdout, /https:\/\/10\.77\.0\.10/);
});

test('patch-env CLI updates the real file and refuses a pre-existing staging claimant', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'jm-env-patch-'));
  const profileFile = path.join(parent, 'profile.json'),
    envFile = path.join(parent, 'server.env');
  await writeFile(
    profileFile,
    JSON.stringify(
      normalizeProfile({
        protocol: 'http',
        publicPort: 8080,
        backendProtocol: 'http',
        backendPort: 3080,
      }),
    ),
  );
  const original =
    'DB_PATH=/srv/custom/chat.sqlite\nCURSOR_SIGNING_KEY=test-preserved-key-1234567890123456789\nTLS_CERT_PATH=/old.crt\nTLS_KEY_PATH=/old.key\n';
  await writeFile(envFile, original);
  const args = ['deploy/vm-profile.mjs', 'patch-env', profileFile, envFile];
  const success = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(success.status, 0, success.stderr);
  const changed = await readFile(envFile, 'utf8');
  assert.match(changed, /DB_PATH=\/srv\/custom\/chat.sqlite/);
  assert.match(changed, /CURSOR_SIGNING_KEY=test-preserved-key/);
  assert.doesNotMatch(changed, /TLS_CERT_PATH/);
  await writeFile(envFile + '.profile-next', 'external-claim');
  const blocked = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.notEqual(blocked.status, 0);
  assert.equal(await readFile(envFile, 'utf8'), changed);
  assert.equal(
    await readFile(envFile + '.profile-next', 'utf8'),
    'external-claim',
  );
});
