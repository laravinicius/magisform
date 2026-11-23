import { readFile } from 'node:fs/promises';

const tag = process.argv[2] ?? '';
if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) {
  throw new Error('Use uma tag de versão final no formato v0.0.0.');
}
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const version = tag.slice(1);
if (pkg.version !== version || lock.version !== version || lock.packages?.['']?.version !== version) {
  throw new Error(`A tag ${tag}, package.json e package-lock.json devem ter a mesma versão.`);
}
console.log(`Versão ${tag} conferida.`);
