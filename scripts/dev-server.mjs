import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['apps/server/dist/main.js'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'development', PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:5173' },
});
child.on('exit', (code) => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
