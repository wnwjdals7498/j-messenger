#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const environmentFile = (file, required) => {
  const text = readFileSync(file, 'utf8');
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) result[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  for (const key of required)
    if (!result[key]) throw new Error(`Missing ${key} in test environment`);
  return result;
};

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1])
    throw new Error(
      `Usage: node tests/deploy/suite-profile-http-smoke.mjs --runtime <extracted-profile>`,
    );
  return path.resolve(process.argv[index + 1]);
}

const runtimeRoot = argument('--runtime');
const messengerEnv = environmentFile(
  '/workspace/.suite-runtime/j-messenger-pg/integration.env',
  ['JMS_TEST_DATABASE_URL', 'JMS_PG_TEST_MARKER'],
);
const suiteEnv = environmentFile(
  '/workspace/.suite-runtime/j-groupware/server.env',
  ['JGW_TENANT', 'KC_PUBLIC_URL'],
);
if (messengerEnv.JMS_PG_TEST_MARKER !== 'isolated-cloud-messenger-pg')
  throw new Error('Dedicated PostgreSQL test database marker required');

const schema = `jm_suite_profile_${randomUUID().replaceAll('-', '')}`;
const temp = await mkdtemp(path.join(os.tmpdir(), 'jm-suite-http-'));
const fileRoot = path.join(temp, 'files');
const tempRoot = path.join(temp, 'upload-temp');
const backupRoot = path.join(temp, 'backups');
await Promise.all([mkdir(fileRoot), mkdir(tempRoot), mkdir(backupRoot)]);
let application;
try {
  const serverPackage = JSON.parse(
    await readFile(path.join(runtimeRoot, 'apps/server/package.json'), 'utf8'),
  );
  for (const dependency of Object.keys(serverPackage.dependencies)) {
    const destination = path.join(
      runtimeRoot,
      'node_modules',
      ...dependency.split('/'),
    );
    try {
      await access(destination);
      continue;
    } catch {
      // The ordinary profile smoke can borrow this dependency from the
      // workspace; a cold-install runtime already has every dependency here.
    }
    await mkdir(path.dirname(destination), { recursive: true });
    const source =
      dependency === '@j-messenger/contracts'
        ? path.join(runtimeRoot, 'packages/contracts')
        : path.join(repositoryRoot, 'node_modules', ...dependency.split('/'));
    await symlink(
      source,
      destination,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }

  const { createApplication } = await import(
    pathToFileURL(
      path.join(runtimeRoot, 'apps/server/dist/bootstrap/application.js'),
    )
  );
  const { loadConfig } = await import(
    pathToFileURL(
      path.join(runtimeRoot, 'apps/server/dist/platform/config/index.js'),
    )
  );
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '3000',
      PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
      AUTH_MODE: 'j-auth',
      JAUTH_TENANT: suiteEnv.JGW_TENANT,
      KC_PUBLIC_URL: suiteEnv.KC_PUBLIC_URL,
      DATABASE_DRIVER: 'postgres',
      DATABASE_URL: messengerEnv.JMS_TEST_DATABASE_URL,
      DATABASE_SCHEMA: schema,
      FILE_ROOT: fileRoot,
      TEMP_ROOT: tempRoot,
      BACKUP_ROOT: backupRoot,
      CURSOR_SIGNING_KEY: 'suite-profile-http-smoke-key-123456789',
      FEATURE_FILES: 'false',
      FEATURE_RECEIPTS: 'false',
      FEATURE_RETENTION: 'false',
      FEATURE_NATIVE_SESSIONS: 'false',
      FEATURE_NOTIFICATIONS: 'false',
    },
    temp,
  );
  assert.equal(config.authMode, 'j-auth');
  application = await createApplication(config, {
    maintenance: false,
    logger: { emit() {} },
  });
  await application.app.listen({ host: '127.0.0.1', port: 0 });
  const address = application.app.server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const rootResponse = await fetch(`${origin}/`);
  const htmlResponse = await fetch(`${origin}/index.html`);
  assert.equal(rootResponse.status, 404);
  assert.equal(htmlResponse.status, 404);
  const readyResponse = await fetch(`${origin}/health/ready`);
  assert.equal(readyResponse.status, 200);
  process.stdout.write(
    `${JSON.stringify({
      profile: 'j-groupware-internal-messenger',
      authMode: 'j-auth',
      database: 'isolated-postgres-schema',
      listener: 'loopback-ephemeral-port',
      rootStatus: rootResponse.status,
      htmlStatus: htmlResponse.status,
      readyStatus: readyResponse.status,
    })}\n`,
  );
} finally {
  if (application) await application.close().catch(() => {});
  const pool = new Pool({
    connectionString: messengerEnv.JMS_TEST_DATABASE_URL,
  });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await pool.end();
    await rm(temp, { recursive: true, force: true });
  }
}
