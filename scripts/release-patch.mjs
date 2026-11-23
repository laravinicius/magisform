import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Execute este comando com npm run release:patch.');

function run(command, args, capture = false, allowFailure = false) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', windowsHide: true });
  if (result.error || (!allowFailure && result.status !== 0)) {
    throw new Error(`Falha em ${command}: ${result.error?.message ?? result.stderr?.trim() ?? `código ${result.status}`}`);
  }
  return result;
}

const git = (...args) => run('git', args, true).stdout.trim();
const npm = (...args) => run(process.execPath, [npmCli, ...args]);
const assertCleanMain = () => {
  if (git('branch', '--show-current') !== 'main') throw new Error('A versão final deve ser gerada na branch main.');
  if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('Há alterações locais. Revise e faça commit antes de criar a versão.');
};

let createdTag = '';
try {
  assertCleanMain();
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(pkg.version ?? '');
  if (!match || lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
    throw new Error('package.json e package-lock.json devem conter a mesma versão final.');
  }
  const next = `${match[1]}.${match[2]}.${BigInt(match[3]) + 1n}`;
  const tag = `v${next}`;
  console.log(`Preparando a versão ${tag}.`);
  run('git', ['fetch', '--no-tags', 'origin', 'main']);
  if (run('git', ['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD'], true, true).status !== 0) {
    throw new Error('A main local está atrás da origem. Atualize-a antes de criar a versão.');
  }
  if (run('git', ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], true, true).status === 0 ||
      git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) {
    throw new Error(`A tag ${tag} já existe.`);
  }

  for (const script of ['lint', 'test', 'test:integration', 'build']) {
    console.log(`\nExecutando ${script} antes da release.`);
    npm('run', script);
  }
  assertCleanMain();
  npm('version', 'patch', '--git-tag-version=true', '--tag-version-prefix=v', '-m', 'v%s');
  createdTag = tag;
  assertCleanMain();
  if (git('rev-parse', 'HEAD') !== git('rev-parse', `refs/tags/${tag}^{commit}`)) {
    throw new Error('A tag gerada não aponta para o commit atual.');
  }
  console.log(`\nEnviando main e ${tag} ao GitHub.`);
  run('git', ['push', '--atomic', 'origin', 'HEAD:refs/heads/main', `refs/tags/${tag}`]);
  console.log(`\n${tag} enviada. Acompanhe o CI e a release no GitHub Actions.`);
} catch (error) {
  console.error(`Release interrompida: ${error instanceof Error ? error.message : error}`);
  if (createdTag) console.error(`A tag ${createdTag} foi criada localmente. Após corrigir a falha, envie-a com: git push --atomic origin main refs/tags/${createdTag}`);
  process.exitCode = 1;
}
