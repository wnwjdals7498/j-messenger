import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
const root = process.cwd();
async function* walk(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (['node_modules', 'dist'].includes(entry.name)) continue;
    const path = resolve(folder, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.(?:ts|tsx)$/.test(path)) yield path;
  }
}
const errors = [];
for (const area of ['apps', 'packages']) for await (const file of walk(resolve(root, area))) {
  const current = relative(root, file).replaceAll('\\', '/');
  const contents = await readFile(file, 'utf8');
  for (const match of contents.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
    const target = match[1];
    if (current.startsWith('packages/') && target?.startsWith('.')) {
      const destination = relative(root, resolve(dirname(file), target)).replaceAll('\\', '/');
      if (destination.startsWith('apps/')) errors.push(`${current}: package imports app`);
    }
    if (current.includes('/src/') && target?.includes('test-kit')) errors.push(`${current}: production imports test-kit`);
    const owner = /^apps\/server\/src\/modules\/([^/]+)/.exec(current)?.[1];
    if (owner && target?.startsWith('.')) {
      const destination = relative(root, resolve(dirname(file), target)).replaceAll('\\', '/');
      const other = /^apps\/server\/src\/modules\/([^/]+)\/(.+)$/.exec(destination);
      if (other && other[1] !== owner && other[2] !== 'index.js') errors.push(`${current}: imports private module ${other[1]}`);
    }
    if (current.startsWith('packages/contracts/') && (target?.startsWith('node:') || ['react', 'fastify'].includes(target))) errors.push(`${current}: contracts imports runtime`);
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('Workspace dependency boundaries OK');
