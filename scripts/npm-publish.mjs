import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
const npm = process.env.OMA_NPM_BIN ?? 'npm';
const npx = process.env.OMA_NPX_BIN ?? 'npx';
const registry = 'https://registry.npmjs.org';
const packageSpec = `${packageJson.name}@${packageJson.version}`;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: 'inherit',
      ...options,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args[0] ?? ''} failed${signal ? ` (${signal})` : ` (exit ${code})`}`));
    });
  });
}

function runQuietly(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, output: output.trim() }));
  });
}

async function readSecret(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('npm-release-publish requires an interactive terminal to read the token safely.');
  }

  process.stdout.write(prompt);
  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdout.write('\n');
      error ? reject(error) : resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          finish(new Error('Cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    process.stdin.on('data', onData);
  });
}

function printHelp() {
  console.log(`Safe npm release helper for ${packageJson.name}.

Before running make npm-release-publish, create a short-lived granular npm token:
  1. npmjs.com -> profile -> Access Tokens -> Generate New Token.
  2. Enable Bypass two-factor authentication (2FA).
  3. Packages and scopes: Read and write + All packages.
     This package is unscoped, so do not select only @oneryalcin.
  4. Organizations: none. Use a 1-7 day expiration.
  5. Restrict the token to the current publisher IP only if it is stable.

The publish target reads the token without echoing it, writes a 0600 temporary
npm config outside the repository, verifies the npm identity, asks for an
explicit publish confirmation, and removes the temporary config afterward.

Targets:
  make npm-release-check     verify the npm tarball before release
  make npm-release-publish   run the guided publish flow
  make npm-release-verify    verify the public package and npx CLI
`);
}

async function verifyPublishedRelease() {
  await run(npm, ['view', packageSpec, 'version', 'dist-tags', `--registry=${registry}`]);
  await run(npx, ['--yes', packageSpec, '--version']);
}

async function publish() {
  const existing = await runQuietly(npm, ['view', packageSpec, 'version', `--registry=${registry}`]);
  if (existing.code === 0 && existing.output === packageJson.version) {
    throw new Error(`${packageSpec} is already published. Bump package.json before publishing again.`);
  }

  const token = await readSecret('npm granular publish token: ');
  if (!token) {
    throw new Error('No token entered.');
  }

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'oma-npm-publish-'));
  const npmrcPath = path.join(temporaryDirectory, '.npmrc');
  const publishEnvironment = { ...process.env, NPM_CONFIG_USERCONFIG: npmrcPath };

  try {
    await writeFile(npmrcPath, `//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 });
    await chmod(npmrcPath, 0o600);
    await run(npm, ['whoami', `--registry=${registry}`], { env: publishEnvironment });

    const confirmation = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await confirmation.question(`Publish ${packageSpec} publicly with the latest tag? Type publish to continue: `);
    confirmation.close();
    if (answer.trim() !== 'publish') {
      console.log('Cancelled before publishing.');
      return;
    }

    await run(npm, ['publish', '--access', 'public', `--registry=${registry}`], { env: publishEnvironment });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

try {
  if (process.argv.includes('--help')) {
    printHelp();
  } else if (process.argv.includes('--verify')) {
    await verifyPublishedRelease();
  } else {
    await publish();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
