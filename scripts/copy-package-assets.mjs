import { readdir, mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
async function copy(source, destination) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copy(from, to);
    else if (/\.(?:css|svg|png)$/.test(entry.name)) {
      await mkdir(destination, { recursive: true });
      await copyFile(from, to);
    }
  }
}
await copy('src', 'dist');
