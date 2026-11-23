import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Execute este teste com npm run test:release.');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'magisform-release-qa-'));
const source = path.join(temp, 'source');
const remote = path.join(temp, 'remote.git');

function execute(command, args, cwd, allowFailure = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error || (!allowFailure && result.status !== 0)) {
    throw new Error(`${command} falhou: ${result.error?.message ?? result.stderr}`);
  }
  return result;
}
const git = (...args) => execute('git', args, source).stdout.trim();
const release = () => execute(process.execPath, [npmCli, 'run', 'release:patch'], source, true);
const check = 'node -e "process.exit(0)"';

try {
  fs.mkdirSync(source);
  fs.mkdirSync(path.join(source, 'scripts'));
  fs.copyFileSync(new URL('./release-patch.mjs', import.meta.url), path.join(source, 'scripts', 'release-patch.mjs'));
  const pkg = { name: 'magisform-release-qa', version: '0.0.1', private: true, type: 'module',
    scripts: { 'release:patch': 'node scripts/release-patch.mjs', lint: check, test: check, 'test:integration': check, build: check } };
  const writePackage = () => fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  writePackage();
  fs.writeFileSync(path.join(source, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version,
    lockfileVersion: 3, requires: true, packages: { '': { name: pkg.name, version: pkg.version } } }, null, 2) + '\n');
  execute('git', ['init', '--bare', remote], temp);
  execute('git', ['init', '-b', 'main'], source);
  git('config', 'user.name', 'MagisForm QA');
  git('config', 'user.email', 'qa@example.invalid');
  git('remote', 'add', 'origin', remote);
  git('add', '.');
  git('commit', '-m', 'base de teste');
  git('push', '-u', 'origin', 'main');

  const dirty = path.join(source, 'alteracao-local.txt');
  fs.writeFileSync(dirty, 'arquivo não revisado');
  const dirtyResult = release();
  assert.notEqual(dirtyResult.status, 0);
  assert.match(dirtyResult.stderr, /alterações locais/i);
  fs.unlinkSync(dirty);

  pkg.scripts.test = 'node -e "process.exit(1)"';
  writePackage();
  git('add', 'package.json');
  git('commit', '-m', 'falha de teste sintética');
  const failed = release();
  assert.notEqual(failed.status, 0);
  assert.equal(git('tag', '--list', 'v0.0.2'), '');
  assert.equal(git('ls-remote', '--tags', 'origin', 'refs/tags/v0.0.2'), '');

  pkg.scripts.test = check;
  writePackage();
  git('add', 'package.json');
  git('commit', '-m', 'corrige teste sintético');
  const successful = release();
  assert.equal(successful.status, 0, successful.stderr + successful.stdout);
  assert.equal(JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version, '0.0.2');
  assert.equal(JSON.parse(fs.readFileSync(path.join(source, 'package-lock.json'), 'utf8')).version, '0.0.2');
  assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'refs/tags/v0.0.2^{commit}'));
  assert.ok(git('ls-remote', '--tags', 'origin', 'refs/tags/v0.0.2'));
  assert.equal(git('rev-parse', 'HEAD'), git('ls-remote', 'origin', 'refs/heads/main').split('\t')[0]);
  console.log('Release validada em repositórios Git descartáveis: falha segura, versão e push atômico.');
} finally {
  const actual = fs.realpathSync(temp);
  const tmpRoot = fs.realpathSync(os.tmpdir());
  if (path.dirname(actual) !== tmpRoot || !path.basename(actual).startsWith('magisform-release-qa-')) {
    throw new Error('Diretório temporário de QA fora do local esperado; limpeza recusada.');
  }
  fs.rmSync(actual, { recursive: true, force: true });
}
