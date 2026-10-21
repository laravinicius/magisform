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
      await pool.execute('INSERT INTO customers(id,name,phone) VALUES(1,?,?)', [`Paciente sintético ${tenant}`, `55119999000${tenant === 'A' ? '1' : '2'}`]);
      await pool.execute('INSERT INTO formulas(id,customer_id,attendant_name,budget_number,status) VALUES(1,1,?,?,?)', [`Atendente ${tenant}`, 'Q009', 'pending']);
      await pool.execute('INSERT INTO schema_version(singleton,version,source,checksum) VALUES(1,3,?,?)', ['bootstrap', '0'.repeat(64)]);
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

    const ownA = await appA.inject({ method: 'GET', url: '/api/v1/customers', headers: sessionA.headers });
    const crossed = await appB.inject({ method: 'GET', url: '/api/v1/customers', headers: sessionA.headers });
    const ownB = await appB.inject({ method: 'GET', url: '/api/v1/customers', headers: sessionB.headers });
    expect(ownA.json().data[0]).toMatchObject({ id: 1, name: 'Paciente sintético A' });
    expect(ownB.json().data[0]).toMatchObject({ id: 1, name: 'Paciente sintético B' });
    const [[formulaA]] = await poolA.execute<mysql.RowDataPacket[]>('SELECT id,budget_number FROM formulas WHERE id=1');
    const [[formulaB]] = await poolB.execute<mysql.RowDataPacket[]>('SELECT id,budget_number FROM formulas WHERE id=1');
    expect(formulaA).toMatchObject({ id: 1, budget_number: 'Q009' });
    expect(formulaB).toMatchObject({ id: 1, budget_number: 'Q009' });
    expect(crossed.statusCode).toBe(401);

    const timestamp = '2025-01-01 12:00:00';
    await poolA.query('INSERT INTO formulas(customer_id,customer_phone,attendant_name,budget_number,status,created_at) VALUES ?', [Array.from({ length: 120 }, (_, index) => [1, `55119999${String(index).padStart(4, '0')}`, 'Busca cursor QA', `P${String(index).padStart(5, '0')}`, 'pending', timestamp])]);
    const firstPage = await appA.inject({ method: 'GET', url: '/api/v1/formulas?limit=50&statuses=pending', headers: sessionA.headers });
    expect(firstPage.statusCode).toBe(200);
    const first = firstPage.json().data;
    expect(first.rows).toHaveLength(50);
    expect(first.nextCursor).toBeTruthy();
    const [newRow] = await poolA.execute<mysql.ResultSetHeader>('INSERT INTO formulas(customer_id,attendant_name,budget_number,status) VALUES(1,?,?,?)', ['Inserida durante paginação', 'P99999', 'pending']);
    const collected = [...first.rows.map((row: any) => row.id)];
    const orderedRows = [...first.rows];
    let cursor = first.nextCursor;
    while (cursor) {
      const nextPage = await appA.inject({ method: 'GET', url: `/api/v1/formulas?limit=50&statuses=pending&cursor=${encodeURIComponent(cursor)}`, headers: sessionA.headers });
      expect(nextPage.statusCode).toBe(200);
      const page = nextPage.json().data;
      collected.push(...page.rows.map((row: any) => row.id));
      orderedRows.push(...page.rows);
      cursor = page.nextCursor;
    }
    expect(collected).toHaveLength(121);
    expect(new Set(collected).size).toBe(collected.length);
    expect(collected).not.toContain(newRow.insertId);
    for (let index = 1; index < orderedRows.length; index++) {
      const previous = orderedRows[index - 1]; const current = orderedRows[index];
      const previousDate = new Date(previous.created_at).getTime(); const currentDate = new Date(current.created_at).getTime();
      expect(previousDate).toBeGreaterThanOrEqual(currentDate);
      if (previousDate === currentDate) expect(previous.id).toBeGreaterThan(current.id);
    }
    const reloaded = await appA.inject({ method: 'GET', url: '/api/v1/formulas?limit=50&statuses=pending', headers: sessionA.headers });
    expect(reloaded.json().data.rows[0].id).toBe(newRow.insertId);
    const foundBySearch = await appA.inject({ method: 'GET', url: '/api/v1/formulas?limit=50&search=Busca%20cursor%20QA', headers: sessionA.headers });
    expect(foundBySearch.json().data.total).toBe(120);
    const deepLink = await appA.inject({ method: 'GET', url: `/api/v1/formulas/${collected[70]}`, headers: sessionA.headers });
    expect(deepLink.json().data.id).toBe(collected[70]);
    const selectedIds = [collected[70], collected[71]];
    const batch = await appA.inject({ method: 'PATCH', url: '/api/v1/formulas/delivery-status-batch', headers: sessionA.headers, payload: { ids: selectedIds, status: 'aguardando_retirada' } });
    expect(batch.statusCode).toBe(200);
    const [selectedRows] = await poolA.query<mysql.RowDataPacket[]>('SELECT id,delivery_status FROM formulas WHERE id IN (?,?)', selectedIds);
    expect(selectedRows).toHaveLength(2);
    expect(selectedRows.every((row) => row.delivery_status === 'aguardando_retirada')).toBe(true);
    const isolatedB = await appB.inject({ method: 'GET', url: '/api/v1/formulas?limit=50', headers: sessionB.headers });
    expect(isolatedB.json().data.rows.every((row: any) => row.attendant_name !== 'Busca cursor QA')).toBe(true);
    const crossedPayment = await appB.inject({ method: 'PATCH', url: '/api/v1/formulas/1/payment', headers: sessionA.headers, payload: { payment_status: 'pago', partial_payment_amount: null } });
    expect(crossedPayment.statusCode).toBe(401);
    const summaryB = await appB.inject({ url: '/api/v1/formulas-summary?month=1&year=2025&paymentStatus=parcial', headers: sessionB.headers });
    expect(summaryB.json().data.deliveredMonthlyTotal).toBe(0);

  });
});
