import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const base = { host: process.env.MARIADB_HOST ?? '127.0.0.1', port: Number(process.env.MARIADB_PORT ?? 3306), user: process.env.MARIADB_USER ?? 'root', password: process.env.MARIADB_PASSWORD ?? '' };
const suffix = crypto.randomBytes(4).toString('hex');
const databases = [`mf_v2_${suffix}`, `mf_v3_${suffix}`, `mf_bootstrap_${suffix}`];
let admin: mysql.Connection;
const run = (command: string, database: string) => spawnSync(process.execPath, ['scripts/database-schema.mjs', command], { encoding: 'utf8', env: { ...process.env, MAGISFORM_DB_HOST: base.host, MAGISFORM_DB_PORT: String(base.port), MAGISFORM_DB_USER: base.user, MAGISFORM_DB_PASSWORD: base.password, MAGISFORM_DB_NAME: database } });

describe.skipIf(!process.env.MARIADB_HOST)('bootstrap e upgrades de schema', () => {
  beforeAll(async () => { admin = await mysql.createConnection({ ...base, multipleStatements: true }); });
  afterAll(async () => { if (admin) { for (const database of databases) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``); await admin.end(); } });

  for (const version of [2, 3]) {
    it(`atualiza o schema v${version} para o modelo de pedidos`, async () => {
      const database = databases[version - 2];
      let schema = (await readFile('tests/fixtures/legacy-schema-v4.sql','utf8')).replace(/CREATE DATABASE IF NOT EXISTS magisform[\s\S]*?;\s*USE magisform;?/i, '').replace(/-- Farmácias solicitantes[\s\S]*?(?=CREATE INDEX idx_action_logs_created)/, '');
      if (version === 2) schema = schema.replace(/^.*created_by_name.*\n/gm, '').replaceAll('VARCHAR(16)', 'VARCHAR(5)');
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      await admin.query(`USE \`${database}\`; ${schema}`);
      const digest = version === 2 ? '6438d5e84358613e4a638d40f6e8da9055248bed4779800479a92b5fde6dfbf9' : '23be321bd34ab098e3ce350b6fb67cdd334c6d688299bd85511c0fc7c0b03dc5';
      await admin.query("INSERT INTO schema_version(singleton,version,source,checksum) VALUES(1,?,'bootstrap',?)", [version, digest]);
      await admin.query("INSERT INTO customers(id,name) VALUES(1,'Paciente antigo')");
      await admin.query("INSERT INTO formulas(id,customer_id,attendant_name) VALUES(1,1,'Atendente')");
      expect(run('preflight', database).status).toBe(0);
      const upgraded = run('upgrade', database);
      expect(upgraded.status, upgraded.stderr).toBe(0);
      expect(run('preflight', database).status).toBe(0);
      const [rows] = await admin.query<mysql.RowDataPacket[]>('SELECT version FROM schema_version');
      expect(rows[0].version).toBe(5);
      const [tables] = await admin.query<mysql.RowDataPacket[]>("SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('customers','formulas')");
      expect(tables).toHaveLength(0);
    }, 30_000);
  }

  it('faz bootstrap apenas em banco vazio', async () => {
    const database = databases[2];
    const bootstrap = run('bootstrap', database);
    expect(bootstrap.status, bootstrap.stderr).toBe(0);
    expect(run('preflight', database).status).toBe(0);
    expect(run('bootstrap', database).status).not.toBe(0);
  }, 30_000);
});
