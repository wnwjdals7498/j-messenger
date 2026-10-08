import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    ...options,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

test('suite profile builds server/contracts only and packages no standalone apps', async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), 'jm-suite-profile-test-'),
  );
  const archive = path.join(parent, 'messenger-suite.tar.gz');
  const extracted = path.join(parent, 'extracted');
  try {
    const buildPackage = run(process.execPath, [
      'deploy/build-suite-profile.mjs',
      'package',
      '--output',
      archive,
    ]);
    assert.equal(buildPackage.status, 0, buildPackage.stderr);
    const summaryLine = buildPackage.stdout
      .trim()
      .split(/\r?\n/)
      .findLast((line) => line.startsWith('{'));
    assert.ok(summaryLine, 'package command must report its archive');
    const summary = JSON.parse(summaryLine);
    assert.equal(summary.profile, 'j-groupware-internal-messenger');
    assert.ok(summary.bytes > 0);
    assert.match(summary.sha256, /^[0-9a-f]{64}$/);

    const listing = run(tar, ['-tzf', archive]);
    assert.equal(listing.status, 0, listing.stderr);
    const entries = listing.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((item) => item.replace(/^\.\//, '').replace(/\/$/, ''));
    const forbidden = [
      'apps/web',
      'apps/desktop',
      'apps/android',
      'packages/client-core',
      'packages/client-react',
    ];
    for (const pathPrefix of forbidden)
      assert.equal(
        entries.some(
          (entry) => entry === pathPrefix || entry.startsWith(`${pathPrefix}/`),
        ),
        false,
        `Excluded product path in artifact: ${pathPrefix}`,
      );
    for (const required of [
      'apps/server/package.json',
      'apps/server/dist/main.js',
      'apps/server/dist/bootstrap/application.js',
      'packages/contracts/package.json',
      'packages/contracts/dist/index.js',
      'deploy/postgres-migrations/20261008110000-storage.sql',
      'deploy/j-messenger.service',
      'deploy/suite-profile.json',
      'package.json',
    ])
      assert.ok(
        entries.includes(required),
        `Required artifact missing: ${required}`,
      );

    await mkdir(extracted);
    const unpack = run(tar, ['-xzf', archive, '-C', extracted]);
    assert.equal(unpack.status, 0, unpack.stderr);
    const embeddedProfile = JSON.parse(
      await readFile(path.join(extracted, 'deploy/suite-profile.json'), 'utf8'),
    );
    assert.equal(embeddedProfile.runtime.authMode, 'j-auth');
    assert.equal(embeddedProfile.runtime.databaseDriver, 'postgres');
    assert.match(embeddedProfile.runtime.webDist, /Unused.*j-auth/);
    assert.deepEqual(embeddedProfile.excludedWorkspaces, forbidden);
    assert.ok(
      embeddedProfile.artifactPaths.includes('apps/server/dist/main.js'),
    );
    assert.equal(
      embeddedProfile.artifactPaths.some((entry) =>
        forbidden.some((item) => entry.startsWith(`${item}/`)),
      ),
      false,
    );
    const releasePackage = JSON.parse(
      await readFile(path.join(extracted, 'package.json'), 'utf8'),
    );
    assert.deepEqual(Object.keys(releasePackage.dependencies).sort(), [
      '@j-messenger/contracts',
      '@j-messenger/server',
    ]);

    // Resolve runtime dependencies from the checked-out lock install while the
    // two in-profile workspace packages resolve from the extracted artifact.
    const serverPackage = JSON.parse(
      await readFile(path.join(extracted, 'apps/server/package.json'), 'utf8'),
    );
    const nodeModules = path.join(extracted, 'node_modules');
    for (const dependency of Object.keys(serverPackage.dependencies)) {
      const segments = dependency.split('/');
      const destination = path.join(nodeModules, ...segments);
      await mkdir(path.dirname(destination), { recursive: true });
      const source =
        dependency === '@j-messenger/contracts'
          ? path.join(extracted, 'packages/contracts')
          : path.join(repositoryRoot, 'node_modules', ...segments);
      await symlink(
        source,
        destination,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    const imported = run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "await import('./apps/server/dist/bootstrap/application.js')",
      ],
      { cwd: extracted },
    );
    assert.equal(imported.status, 0, imported.stderr);

    for (const standaloneSource of [
      'apps/web/src/main.tsx',
      'apps/desktop/src/main.tsx',
      'apps/android/app/src/main/java/com/jmessenger/android/MainActivity.java',
    ])
      assert.ok(
        await readFile(path.join(repositoryRoot, standaloneSource)),
        `Standalone source was removed: ${standaloneSource}`,
      );

    const defaultBuild = await readFile(
      path.join(repositoryRoot, 'scripts/build-workspace.mjs'),
      'utf8',
    );
    assert.match(defaultBuild, /'web'/);
    const defaultCheck = await readFile(
      path.join(repositoryRoot, 'scripts/check-workspace.mjs'),
      'utf8',
    );
    assert.match(defaultCheck, /'desktop'/);
    assert.match(defaultCheck, /'web'/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('package refuses an existing destination without changing its bytes', async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), 'jm-suite-profile-existing-'),
  );
  const archive = path.join(parent, 'existing.tar.gz');
  const original = Buffer.from('preserve this existing artifact\n');
  try {
    await writeFile(archive, original, { flag: 'wx' });
    const result = run(process.execPath, [
      'deploy/build-suite-profile.mjs',
      'package',
      '--output',
      archive,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /output already exists/);
    assert.deepEqual(await readFile(archive), original);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
