import { readFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { webLogin } from './fixtures/webSession';

const base = { host: process.env.MARIADB_HOST ?? '127.0.0.1', port: Number(process.env.MARIADB_PORT ?? 3306), user: process.env.MARIADB_USER ?? 'root', password: process.env.MARIADB_PASSWORD ?? '' };
const enabled = Boolean(process.env.MARIADB_HOST);
const suffix = crypto.randomBytes(4).toString('hex');
const databaseA = `mf_tenant_a_${suffix}`;
const databaseB = `mf_tenant_b_${suffix}`;
let admin: mysql.Connection;
let poolA: mysql.Pool;
let poolB: mysql.Pool;
let appA: Awaited<ReturnType<typeof buildApp>>;
let appB: Awaited<ReturnType<typeof buildApp>>;

describe.skipIf(!enabled)('isolamento entre instalações por farmácia', () => {
  beforeAll(async () => {
    admin = await mysql.createConnection({ ...base, multipleStatements: true });
    const sql = (await readFile(path.resolve('database.sql'), 'utf8')).replace(/CREATE DATABASE IF NOT EXISTS magisform[\s\S]*?;\s*USE magisform;?/i, '');
    for (const [database, tenant, brand, primary] of [[databaseA, 'A', 'Farmácia Alfa QA', '#AA1122'], [databaseB, 'B', 'Farmácia Beta QA', '#1133AA']] as const) {
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      await admin.query(`USE \`${database}\`; ${sql}`);
      const pool = mysql.createPool({ ...base, database, dateStrings: true, timezone: '-03:00' });
      const password = crypto.createHash('sha256').update('qa-mesma-senha').digest('hex');
      await pool.execute('INSERT INTO users(id,name,username,password,role) VALUES(1,?,?,?,?)', [`Administrador ${tenant}`, 'admin-compartilhado', password, 'admin']);
      await pool.execute('INSERT INTO partner_pharmacies(id,name) VALUES(1,?)', [`Farmácia ${tenant}`]);
      const order = JSON.stringify({patient_name:`Paciente sintético ${tenant}`,patient_phone:'',attendant_name:'QA',items:[{name:'Insumo',quantity:1,unit:'mg'}],budget_number:'',budget_items:[],delivery_date:null});
      await pool.execute('INSERT INTO orders(id,pharmacy_id,original_data,current_data) VALUES(1,1,?,?)',[order,order]);
      await pool.execute('INSERT INTO schema_version(singleton,version,source,checksum) VALUES(1,5,?,?)', ['bootstrap', '0'.repeat(64)]);
      const config = loadConfig({ NODE_ENV: 'test', MAGISFORM_SERVER_DB_HOST: base.host, MAGISFORM_SERVER_DB_PORT: String(base.port), MAGISFORM_SERVER_DB_NAME: database, MAGISFORM_SERVER_DB_USER: base.user, MAGISFORM_SERVER_DB_PASSWORD: base.password, MAGISFORM_SERVER_INSTALLATION_NAME: `Instalação ${tenant}`, MAGISFORM_SERVER_BRAND: brand, MAGISFORM_SERVER_BRAND_PRIMARY: primary });
      const app = await buildApp({ config, pool, closePool: false });
      if (tenant === 'A') { poolA = pool; appA = app; } else { poolB = pool; appB = app; }
    }
  }, 30_000);

  afterAll(async () => {
    if (appA) await appA.close();
    if (appB) await appB.close();
    if (poolA) await poolA.end();
    if (poolB) await poolB.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS \`${databaseA}\`; DROP DATABASE IF EXISTS \`${databaseB}\``); await admin.end(); }
  });

  it('isola IDs, usuários, registros, cookie cruzado e configuração pública de marca', async () => {
    const configA = (await appA.inject('/api/v1/public-config')).json().data;
    const configB = (await appB.inject('/api/v1/public-config')).json().data;
    expect(configA).toMatchObject({ installationName: 'Instalação A', brand: 'Farmácia Alfa QA', brandTheme: { primary: '#AA1122' } });
    expect(configB).toMatchObject({ installationName: 'Instalação B', brand: 'Farmácia Beta QA', brandTheme: { primary: '#1133AA' } });

    const sessionA = await webLogin(appA, 'admin-compartilhado', 'qa-mesma-senha');
    const loginA = sessionA.response;
    const sessionB = await webLogin(appB, 'admin-compartilhado', 'qa-mesma-senha');
    const loginB = sessionB.response;
    expect(loginA.statusCode).toBe(200);
    expect(loginB.statusCode).toBe(200);
    expect(loginA.json().data.user.id).toBe(loginB.json().data.user.id);

    const ownA = await appA.inject({ url:'/api/v1/orders', headers:sessionA.headers });
    const ownB = await appB.inject({ url:'/api/v1/orders', headers:sessionB.headers });
    const crossed = await appB.inject({ url:'/api/v1/orders', headers:sessionA.headers });
    expect(ownA.json().data[0]).toMatchObject({id:1,current_data:{patient_name:'Paciente sintético A'}});
    expect(ownB.json().data[0]).toMatchObject({id:1,current_data:{patient_name:'Paciente sintético B'}});
    expect(crossed.statusCode).toBe(401);
    expect((await appB.inject({method:'POST',url:'/api/v1/orders/1/accept',headers:sessionA.headers,payload:{revision:1}})).statusCode).toBe(401);
    expect((await appA.inject({method:'POST',url:'/api/v1/orders/1/accept',headers:sessionA.headers,payload:{revision:1}})).statusCode).toBe(200);
    expect((await appB.inject({url:'/api/v1/orders/1',headers:sessionB.headers})).json().data.status).toBe('submitted');

  });
});
