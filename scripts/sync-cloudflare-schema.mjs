import { readFile, writeFile } from 'node:fs/promises';

// O primeiro upgrade D1 é a fonte canônica do snapshot consolidado.
const source = new URL('../cloudflare/migrations/0001_initial.sql', import.meta.url);
const snapshot = new URL('../cloudflare/schema.sql', import.meta.url);
const sql = await readFile(source, 'utf8');
await writeFile(snapshot, sql, 'utf8');
console.log('Snapshot D1 sincronizado com a migration inicial.');
