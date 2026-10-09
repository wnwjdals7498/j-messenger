import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  realpath,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = fileURLToPath(new URL('../../', import.meta.url));
const registry = 'http://127.0.0.1:4873/';
async function run(args, cwd, env = process.env) {
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
  timer.unref();
  try {
    const [code] = await once(child, 'exit');
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
test(
  'actual immutable client packages install, typecheck and browser bundle with CSS in a fresh registry consumer',
  { timeout: 150000 },
  async () => {
    if (!process.env.npm_execpath)
      throw new Error('Run through npm test:registry.');
    const profile = await realpath(
      process.env.JMS_TEST_NPMRC ??
        path.resolve(root, '../.suite-runtime/j-groupware/registry/user.npmrc'),
    );
    assert.ok(
      path.relative(root, profile).startsWith('..' + path.sep),
      'Private registry profile must be outside checkout.',
    );
    const temporary = await mkdtemp(
      path.join(os.tmpdir(), 'jms-client-registry-'),
    );
    const npm = async (args) => {
      const result = await run(
        [
          process.env.npm_execpath,
          ...args,
          '--workspaces=false',
          '--userconfig',
          profile,
          '--cache',
          path.join(temporary, 'cache'),
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
        ],
        temporary,
      );
      assert.equal(
        result.code,
        0,
        'npm consumer operation failed; private output withheld.',
      );
      return result.stdout;
    };
    try {
      const metadata = {};
      for (const name of ['contracts', 'client-core', 'client-react']) {
        const response = await fetch(registry + '@j-messenger%2f' + name, {
          signal: AbortSignal.timeout(3000),
        });
        assert.equal(
          response.status,
          200,
          'Shared packages must actually be published.',
        );
        const document = await response.json(),
          version = JSON.parse(
            await readFile(
              path.join(root, 'packages', name, 'package.json'),
              'utf8',
            ),
          ).version,
          manifest = document.versions[version];
        assert.equal(manifest.name, '@j-messenger/' + name);
        assert.equal(manifest.version, version);
        const packed = JSON.parse(
          await npm([
            'pack',
            path.join(root, 'packages', name),
            '--json',
            '--pack-destination',
            temporary,
          ]),
        );
        const bytes = await readFile(path.join(temporary, packed[0].filename));
        assert.equal(
          manifest.dist.integrity,
          'sha512-' + createHash('sha512').update(bytes).digest('base64'),
          'Published contents must match this checkout; changed contents need a new version.',
        );
        assert.ok(
          packed[0].files.every(
            (file) =>
              ['package.json', 'README.md', 'CHANGELOG.md'].includes(
                file.path,
              ) || file.path.startsWith('dist/'),
          ),
          'Package allowlist must exclude source/tests/env/runtime.',
        );
        metadata[name] = manifest;
      }
      assert.equal(metadata['client-react'].peerDependencies.react, '19.3.0');
      assert.equal(metadata['client-react'].dependencies.react, undefined);
      assert.equal(
        metadata['client-react'].exports['./styles.css'],
        './dist/messenger.css',
      );
      await writeFile(
        path.join(temporary, '.npmrc'),
        'registry=https://registry.npmjs.org/\n@j-messenger:registry=' +
          registry +
          '\n',
      );
      await writeFile(
        path.join(temporary, 'package.json'),
        JSON.stringify({
          name: 'isolated-client-consumer',
          private: true,
          type: 'module',
          dependencies: {
            '@j-messenger/client-core': metadata['client-core'].version,
            '@j-messenger/client-react': metadata['client-react'].version,
            react: '19.3.0',
            'react-dom': '19.3.0',
          },
          devDependencies: {
            '@types/react': '19.3.0',
            '@types/react-dom': '19.3.0',
          },
        }),
      );
      await npm(['install']);
      const lock = JSON.parse(
        await readFile(path.join(temporary, 'package-lock.json'), 'utf8'),
      );
      for (const name of ['contracts', 'client-core', 'client-react']) {
        const entry = lock.packages['node_modules/@j-messenger/' + name];
        assert.equal(entry.version, metadata[name].version);
        assert.equal(new URL(entry.resolved).origin, new URL(registry).origin);
        assert.equal(entry.integrity, metadata[name].dist.integrity);
      }
      assert.equal(
        Object.keys(lock.packages).filter(
          (name) =>
            name.endsWith('/node_modules/react') ||
            name === 'node_modules/react',
        ).length,
        1,
        'Host and component must share one React instance.',
      );
      await writeFile(
        path.join(temporary, 'consumer.mjs'),
        `import assert from 'node:assert/strict';
import {createGroupwareMessengerClient} from '@j-messenger/client-core';
import {isValidMessageText} from '@j-messenger/contracts';
assert.equal(isValidMessageText('공유 계약'),true);
const client=createGroupwareMessengerClient({origin:'https://gw.sample-a.jgw.test',csrfToken:()=>null,fetch:async(input,init)=>{
 assert.equal(String(input),'https://gw.sample-a.jgw.test/api/messenger/api/v1/me');
 assert.equal(init.credentials,'include');assert.equal(new Headers(init.headers).has('authorization'),false);
 return Response.json({data:{id:'1',serverId:'sample-a',displayName:'회원',enabledFeatures:{files:false}}});
}});
assert.equal((await client.getMe()).id,'1');client.dispose();`,
      );
      const executed = await run(['consumer.mjs'], temporary);
      assert.equal(
        executed.code,
        0,
        'Installed core runtime failed; private output withheld.',
      );
      await writeFile(
        path.join(temporary, 'index.html'),
        '<html><div id="root"></div><script type="module" src="/main.ts"></script></html>',
      );
      await writeFile(
        path.join(temporary, 'main.ts'),
        `import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {MessengerApp} from '@j-messenger/client-react';
import '@j-messenger/client-react/styles.css';
import {createGroupwareMessengerClient} from '@j-messenger/client-core';
const client=createGroupwareMessengerClient({origin:'https://gw.sample-a.jgw.test',csrfToken:()=>null});
createRoot(document.getElementById('root')!).render(createElement(MessengerApp,{client}));`,
      );
      await writeFile(
        path.join(temporary, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2023',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            noEmit: true,
            lib: ['ES2023', 'DOM', 'DOM.Iterable'],
            skipLibCheck: false,
          },
          include: ['main.ts'],
        }),
      );
      const typed = await run(
        [
          path.join(root, 'node_modules/typescript/bin/tsc'),
          '-p',
          'tsconfig.json',
        ],
        temporary,
      );
      assert.equal(
        typed.code,
        0,
        'Installed component public types failed; private output withheld.',
      );
      const bundled = await run(
        [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'],
        temporary,
      );
      assert.equal(
        bundled.code,
        0,
        'Installed component browser bundle failed; private output withheld.',
      );
      const assets = await readdir(path.join(temporary, 'dist/assets'));
      assert.ok(assets.some((name) => name.endsWith('.js')));
      assert.ok(
        assets.some((name) => name.endsWith('.css')),
        'Published CSS must survive consumer bundling.',
      );
      const css = (
        await Promise.all(
          assets
            .filter((name) => name.endsWith('.css'))
            .map((name) =>
              readFile(path.join(temporary, 'dist/assets', name), 'utf8'),
            ),
        )
      ).join('\n');
      assert.match(css, /var\(--jgw-color-primary/);
      assert.match(css, /var\(--jgw-color-surface/);
      const duplicate = await run(
        [
          path.resolve(root, '../j-groupware/scripts/registry-publish.mjs'),
          '--package',
          path.join(root, 'packages/contracts'),
          '--npmrc',
          profile,
        ],
        root,
        { ...process.env, NPM_CONFIG_CACHE: path.join(temporary, 'cache') },
      );
      assert.notEqual(duplicate.code, 0);
      assert.ok(
        duplicate.stderr.includes('published versions are immutable'),
        'Guard must reject duplicate exact-version publication.',
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
