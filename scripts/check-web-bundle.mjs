import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'dist-web');
const files = [];
async function visit(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await visit(full);
    else files.push(full);
  }
}
await visit(root);

const forbidden = [
  ['Electron bridge/runtime', /electronAPI|electron-updater|vite-plugin-electron|from["']electron["']/i],
  ['Node runtime/module', /node:(?:fs|path|crypto|process|os|child_process)|process\.env|__dirname\b|\bBuffer\.from\s*\(/i],
  ['MariaDB driver', /mysql2\/|createPool\s*\(|createConnection\s*\(/i],
  ['secret environment variable', /(?:VITE|MAGISFORM)_[A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|PRIVATE_KEY)[A-Z0-9_]*/i],
];
const issues = [];
for (const file of files) {
  if (!/\.(?:js|css|html|json|svg|txt)$/i.test(file)) continue;
  const contents = await readFile(file, 'utf8');
  for (const [label, pattern] of forbidden) if (pattern.test(contents)) issues.push(`${path.relative(root, file)}: ${label}`);
}
if (issues.length) {
  console.error(`Falha na auditoria do bundle web:\n${issues.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Auditoria aprovada: ${files.length} arquivos de ${path.basename(root)} sem runtime Node/Electron, driver MariaDB ou nomes de variáveis secretas.`);
}
