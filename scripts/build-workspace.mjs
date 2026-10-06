import { spawnSync } from 'node:child_process';
if (!process.env.npm_execpath) throw new Error('Run this script through npm');
for (const name of ['contracts', 'client-core', 'client-react', 'server', 'web']) {
  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'run', 'build', `--workspace=@j-messenger/${name}`], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
