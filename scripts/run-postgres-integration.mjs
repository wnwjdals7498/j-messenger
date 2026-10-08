import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repository = fileURLToPath(new URL('../', import.meta.url));
try {
  const file = await realpath(process.env.JMS_TEST_ENV ?? path.resolve(repository, '../.suite-runtime/j-messenger-pg/integration.env'));
  if (!path.relative(repository, file).startsWith('..' + path.sep)) throw new Error();
  const runtime = { ...parseEnv(await readFile(file, 'utf8')), ...process.env };
  const url = new URL(runtime.JMS_TEST_DATABASE_URL ?? '');
  if (runtime.JMS_PG_TEST_MARKER !== 'isolated-cloud-messenger-pg' || url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || url.port !== '54240' || url.username !== 'jgw_messenger' || url.pathname !== '/jgw_messenger' || url.search || url.hash) throw new Error();
  const child = spawn(process.execPath, [path.join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.postgres.config.ts', ...process.argv.slice(2)], { cwd: repository, env: runtime, shell: false, stdio: 'inherit' });
  child.once('error', () => { process.stderr.write('PostgreSQL test runner failed.\n'); process.exitCode = 1; });
  child.once('close', (code) => { process.exitCode = code ?? 1; });
} catch {
  process.stderr.write('PostgreSQL integration requires an external isolated cloud test env. No tests were run.\n');
  process.exitCode = 1;
}
