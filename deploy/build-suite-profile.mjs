#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const profilePath = path.join(scriptDirectory, 'suite-profile.json');

function runNpm(args) {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `npm ${args.join(' ')} failed (${result.status ?? 'signal'})`,
    );
}

async function copyTree(source, destination) {
  const info = await lstat(source);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`Expected a built directory: ${source}`);
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink())
      throw new Error('Symlinks are not package inputs');
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await copyFile(from, to);
    else throw new Error('Unsupported package input');
  }
}

async function collectFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symlink in suite package');
    if (entry.isDirectory()) files.push(...(await collectFiles(root, target)));
    else if (entry.isFile())
      files.push(path.relative(root, target).split(path.sep).join('/'));
    else throw new Error('Unsupported suite package entry');
  }
  return files.sort();
}

function parseOutput(args) {
  const at = args.indexOf('--output');
  if (at < 0 || !args[at + 1])
    throw new Error(
      'Usage: node deploy/build-suite-profile.mjs build | package --output <archive.tar.gz>',
    );
  return path.resolve(repositoryRoot, args[at + 1]);
}

async function build() {
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  for (const workspace of profile.buildWorkspaces)
    runNpm(['run', 'build', `--workspace=${workspace}`]);
}

async function packageArtifact(output) {
  await mkdir(path.dirname(output), { recursive: true });
  try {
    await lstat(output);
    throw new Error('Suite artifact output already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await build();

  // Keep the staged archive beside the destination so publishing is an
  // exclusive same-filesystem link. A concurrent creator can never be
  // overwritten, and only this invocation's private directory is cleaned up.
  const temporary = await mkdtemp(
    path.join(path.dirname(output), '.jm-suite-profile-'),
  );
  const stage = path.join(temporary, 'payload');
  const temporaryArchive = path.join(temporary, 'artifact.tar.gz');
  try {
    const profile = JSON.parse(await readFile(profilePath, 'utf8'));
    for (const workspace of ['apps/server', 'packages/contracts']) {
      const destination = path.join(stage, workspace);
      await mkdir(destination, { recursive: true });
      await copyFile(
        path.join(repositoryRoot, workspace, 'package.json'),
        path.join(destination, 'package.json'),
      );
      await copyTree(
        path.join(repositoryRoot, workspace, 'dist'),
        path.join(destination, 'dist'),
      );
    }
    await mkdir(path.join(stage, 'deploy'), { recursive: true });
    await copyTree(
      path.join(repositoryRoot, 'deploy/postgres-migrations'),
      path.join(stage, 'deploy/postgres-migrations'),
    );
    await copyFile(
      path.join(scriptDirectory, 'j-messenger.service'),
      path.join(stage, 'deploy', 'j-messenger.service'),
    );
    await copyFile(
      profilePath,
      path.join(stage, 'deploy', 'suite-profile.json'),
    );
    const releasePackage = {
      name: 'j-messenger-suite-runtime',
      private: true,
      type: 'module',
      engines: { node: '>=22.18.0' },
      dependencies: {
        '@j-messenger/contracts': 'file:./packages/contracts',
        '@j-messenger/server': 'file:./apps/server',
      },
    };
    await writeFile(
      path.join(stage, 'package.json'),
      `${JSON.stringify(releasePackage, null, 2)}\n`,
      { flag: 'wx', mode: 0o644 },
    );

    const paths = await collectFiles(stage);
    for (const excluded of profile.excludedWorkspaces)
      if (
        paths.some(
          (item) => item === excluded || item.startsWith(`${excluded}/`),
        )
      )
        throw new Error(
          `Excluded workspace entered suite package: ${excluded}`,
        );
    const body = `${JSON.stringify({ ...profile, artifactPaths: paths }, null, 2)}\n`;
    await writeFile(path.join(stage, 'deploy', 'suite-profile.json'), body, {
      flag: 'w',
    });

    const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
    const result = spawnSync(
      tar,
      ['-czf', temporaryArchive, '-C', stage, '.'],
      {
        encoding: 'utf8',
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Suite archive creation failed');
    await link(temporaryArchive, output);
    const digest = createHash('sha256');
    const { createReadStream } = await import('node:fs');
    for await (const chunk of createReadStream(temporaryArchive))
      digest.update(chunk);
    const outputStat = await stat(output);
    process.stdout.write(
      `${JSON.stringify({ profile: profile.profile, output, sha256: digest.digest('hex'), bytes: outputStat.size, files: paths.length })}\n`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'build') await build();
  else if (command === 'package') await packageArtifact(parseOutput(args));
  else throw new Error('Expected build or package command');
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Suite profile failed'}\n`,
  );
  process.exitCode = 1;
}
