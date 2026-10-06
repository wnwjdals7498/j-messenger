import { spawnSync } from 'node:child_process';
const cli = process.env.npm_execpath;
if (!cli) throw new Error('Run this script through npm');
function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['run', 'build:contracts']);
run(['run', 'build', '--workspace=@j-messenger/client-core']);
run(['run', 'build', '--workspace=@j-messenger/client-react']);
run(['run', 'lint']);
run(['run', 'test:deploy']);
for (const name of ['contracts', 'client-core', 'client-react', 'server', 'web', 'desktop']) run(['run', 'check', `--workspace=@j-messenger/${name}`]);
