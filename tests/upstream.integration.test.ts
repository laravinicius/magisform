import { webLogin } from './fixtures/webSession';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../core/db';
import { buildApp } from '../server/app';
import { loadConfig } from '../server/config';

const base = { host: process.env.MARIADB_HOST, port: Number(process.env.MARIADB_PORT), user: process.env.MARIADB_USER, password: process.env.MARIADB_PASSWORD };
const database = `magisform_upstream_${randomBytes(5).toString('hex')}`;
const upgradeDatabase = `${database}_upgrade`;
let admin: mysql.Connection;
let pool: mysql.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let token: string;
let customerId: number;
let insumoId: number;
const db = new Db();
const schemaCommand = (command: string, name = database) => spawnSync(process.execPath, [path.resolve('scripts/database-schema.mjs'), command], {
  encoding: 'utf8', windowsHide: true,
  env: { ...process.env, MAGISFORM_DB_HOST: base.host, MAGISFORM_DB_PORT: String(base.port), MAGISFORM_DB_USER: base.user, MAGISFORM_DB_PASSWORD: base.password, MAGISFORM_DB_PASSWORD_FILE: '', MAGISFORM_DB_NAME: name },
});
const within = <T>(fn: () => Promise<T>) => db.withSessionContext(token, fn);
const input = (budget: string) => ({ customer_id: customerId, attendant_name: 'Atendente distinto', items: [{ insumo_id: insumoId, quantity: 2.5, unit: '%' }], budget_number: budget, budget_items: [{ quantity: 30, unit: 'caps s.l.', value: 100, is_selected: true }], status: 'pending' as const, payment_status: 'pagar_na_retirada', delivery_date: '2020-01-01' });

describe.skipIf(!process.env.MARIADB_HOST)('atualizações funcionais e schema v3', () => {
  beforeAll(async () => {
    admin = await mysql.createConnection({ ...base, multipleStatements: true });
    const bootstrap = schemaCommand('bootstrap');
    expect(bootstrap.status, bootstrap.stderr).toBe(0);
    expect(schemaCommand('preflight').status).toBe(0);
    expect(schemaCommand('bootstrap').status).not.toBe(0);
    pool = mysql.createPool({ ...base, database, dateStrings: true });
    db.setPool(pool); db.enforceAuthentication();
    await pool.execute('INSERT INTO users(name,username,password,role) VALUES(?,?,?,?)', ['Criador original', 'upstream-qa', createHash('sha256').update('senha-qa').digest('hex'), 'admin']);
    const login = await db.login('upstream-qa', 'senha-qa'); token = login.sessionToken!;
    customerId = (await within(() => db.addCustomer({ name: 'Paciente upstream', phone: null }))).id!;
    insumoId = (await within(() => db.addInsumo('Insumo upstream'))).id!;
    app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', MAGISFORM_SERVER_DB_HOST: base.host, MAGISFORM_SERVER_DB_PORT: String(base.port), MAGISFORM_SERVER_DB_NAME: database, MAGISFORM_SERVER_DB_USER: base.user, MAGISFORM_SERVER_DB_PASSWORD: base.password }), pool, closePool: false });
  }, 30_000);
  afterAll(async () => {
    await app?.close(); await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS \`${database}\``); await admin.query(`DROP DATABASE IF EXISTS \`${upgradeDatabase}\``); await admin.end(); }
  });

  it('persiste autoria validada, preserva em edições e atribui novo autor ao repetir', async () => {
    const f = await within(() => db.addFormula({ ...input('810001'), created_by_name: 'Nome forjado' } as any));
    expect((await within(() => db.getFormula(f.id!)))?.created_by_name).toBe('Criador original');
    await pool.execute('UPDATE users SET name=? WHERE username=?', ['Criador renomeado', 'upstream-qa']);
    await within(() => db.updateFormula(f.id!, { ...input('810001'), items: [{ insumo_id: insumoId, quantity: 1000, unit: 'ml' }], created_by_name: 'Sobrescrito' } as any));
    const edited = await within(() => db.getFormula(f.id!));
    expect(edited?.created_by_name).toBe('Criador original');
    expect(Number(edited?.items[0].quantity)).toBe(1000);
    expect(edited?.items[0].insumo_id).toBe(insumoId);
    const repeated = await within(() => db.addFormula(input('810002')));
    expect((await within(() => db.getFormula(repeated.id!)))?.created_by_name).toBe('Criador renomeado');
    const savedInput = { name: 'Modelo autoria', items: input('').items, budget_items: [{ quantity: 10, unit: 'sachê', value: 50 }], created_by_name: 'Forjado' };
    const saved = await within(() => db.addSavedFormula(savedInput));
    expect(saved.success).toBe(true);
    await pool.execute('UPDATE users SET name=? WHERE username=?', ['Terceiro nome', 'upstream-qa']);
    await within(() => db.updateSavedFormula(saved.id!, { ...savedInput, items: [{ insumo_id: insumoId, quantity: 2.5, unit: 'g' }] }));
    expect((await within(() => db.listSavedFormulas())).find(f => f.id === saved.id)?.created_by_name).toBe('Criador renomeado');
  });

  it('entrega todos os pagamentos em lote e serializa pagamento sem mudar data nem composição', async () => {
    const ids: number[] = [];
    for (const [index, payment_status] of ['', 'parcial', 'pagar_na_retirada', 'pago'].entries()) {
      const f = await within(() => db.addFormula({ ...input(String(820000 + index)), payment_status, partial_payment_amount: 10 })); ids.push(f.id!);
    }
    await within(() => db.updateFormulasDeliveryStatus(ids, 'entregue'));
    const original = await within(() => db.getFormula(ids[0]));
    for (const amount of [0, -1, 100.01, 1.001, Infinity, NaN]) {
      await expect(within(() => db.updateFormulaPayment(ids[0], { payment_status: 'parcial', partial_payment_amount: amount }))).rejects.toThrow();
    }
    await within(() => db.updateFormulaPayment(ids[0], { payment_status: 'parcial', partial_payment_amount: 25.5 }));
    const settled = await Promise.allSettled([0, 1].map(() => within(() => db.updateFormulaPayment(ids[0], { payment_status: 'pago', partial_payment_amount: null }))));
    expect(settled.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const result = await within(() => db.getFormula(ids[0]));
    expect(result?.delivered_at).toBe(original?.delivered_at);
    expect(result?.created_by_name).toBe(original?.created_by_name);
    expect(result?.items).toEqual(original?.items);
    expect(result?.payment_status).toBe('pago');
    expect(result?.partial_payment_amount).toBeNull();
    const [[logs]] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS n FROM action_logs WHERE entity_id=? AND entity="formulas" AND action="update"', [ids[0]]);
    expect(Number(logs.n)).toBe(2);
    await expect(db.updateFormulaPayment(ids[1], { payment_status: 'pago', partial_payment_amount: null })).rejects.toThrow(/Sessão/);
    await expect(within(() => db.updateFormulaPayment(999999, { payment_status: 'pago', partial_payment_amount: null }))).rejects.toThrow(/não encontrada/);
  });

  it('soma todas as páginas por entrega efetiva e categoria de pagamento', async () => {
    const month = 1, year = 2025;
    for (const [index, payment] of ['pago', '', 'nao_pago', 'pagar_na_retirada', 'parcial'].entries()) {
      for (let n = 0; n < 61; n++) {
        const [f] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO formulas(customer_id,attendant_name,budget_number,status,delivery_status,delivered_at,payment_status,partial_payment_amount) VALUES(?,? ,?,'delivered','entregue','2025-02-15 12:00:00',?,?)", [customerId, 'Resumo', String(830000 + index * 100 + n), payment, payment === 'parcial' ? 12.5 : null]);
        await pool.execute('INSERT INTO formula_budget_items(formula_id,quantity,unit,value,is_selected) VALUES(?,30,?,100,1)', [f.insertId, 'sachê']);
      }
    }
    expect((await within(() => db.listFormulas({ limit: 50, statuses: ['delivered'] }))).rows).toHaveLength(50);
    for (const [payment, total] of [['pago',6100],['nao_pago',12200],['pagar_na_retirada',6100],['parcial',762.5]] as const) {
      expect((await within(() => db.getFormulaSummary(month,year,payment))).deliveredMonthlyTotal).toBe(total);
    }
    expect((await within(() => db.getFormulaSummary(month,year))).deliveredMonthlyTotal).toBe(6100);
    expect((await within(() => db.getFormulaSummary(2,year))).deliveredMonthlyTotal).toBe(0);
  });

  it('expõe pagamento e autoria por HTTP, rejeita falta de sessão e preserva o schema', async () => {
    const { headers } = await webLogin(app, 'upstream-qa', 'senha-qa', true);
    const created = await app.inject({ method: 'POST', url: '/api/v1/formulas', headers, payload: { ...input('890001'), created_by_name: 'Forjado HTTP' } });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().data.id;
    const get = await app.inject({ url: `/api/v1/formulas/${id}`, headers });
    expect(get.json().data.created_by_name).toBe('Terceiro nome');
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/formulas/${id}/payment`, headers, payload: { payment_status: 'pago', partial_payment_amount: null } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/formulas/${id}/delivery-status`, headers, payload: { status: 'entregue' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/formulas/${id}/payment`, headers: { origin: 'http://127.0.0.1:3001' }, payload: { payment_status: 'pago', partial_payment_amount: null } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/formulas/${id}/payment`, headers, payload: { payment_status: 'parcial', partial_payment_amount: 101 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/formulas/${id}/payment`, headers, payload: { payment_status: 'pago', partial_payment_amount: null } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/v1/formulas-summary?month=1&year=2025&paymentStatus=parcial', headers })).json().data.deliveredMonthlyTotal).toBe(762.5);
    expect((await app.inject({ url: '/api/v1/formulas-summary?month=1&year=2025&paymentStatus=invalido', headers })).statusCode).toBe(400);
  });

  it('retoma upgrade parcial v2, recupera autoria somente com evidência única e preserva datas', async () => {
    const schema = (await readFile('database.sql','utf8')).replace(/CREATE DATABASE IF NOT EXISTS magisform[\s\S]*?;\s*USE magisform;?/i, '').replace(/^.*created_by_name.*\n/gm,'').replaceAll('VARCHAR(16)', 'VARCHAR(5)');
    await admin.query(`CREATE DATABASE \`${upgradeDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.query(`USE \`${upgradeDatabase}\`; ${schema}`);
    await admin.query("INSERT INTO schema_version(singleton,version,source,checksum) VALUES(1,2,'bootstrap','6438d5e84358613e4a638d40f6e8da9055248bed4779800479a92b5fde6dfbf9')");
    await admin.query("INSERT INTO customers(id,name) VALUES(1,'Legado')");
    for (let id = 1; id <= 6; id++) {
      await admin.query("INSERT INTO formulas(id,customer_id,attendant_name,updated_at) VALUES(?,1,'Legado','2020-01-02 03:04:05')", [id]);
      await admin.query("INSERT INTO saved_formulas(id,name,updated_at) VALUES(?,?,'2020-01-02 03:04:05')", [id, `Legado ${id}`]);
      for (const entity of ['formulas','saved_formulas']) {
        const logs = id === 2 ? ['A','B'] : id === 3 ? ['Configuração'] : id === 4 ? [' '] : ['Autor histórico'];
        for (const name of logs) await admin.query("INSERT INTO action_logs(user_name,action,entity,entity_id) VALUES(?,?,?,?)", [name, id === 5 ? 'update' : 'add', entity, id]);
      }
    }
    // Simula falha após os primeiros DDL, antes de registrar a versão.
    await admin.query('ALTER TABLE formulas ADD COLUMN created_by_name VARCHAR(255) NULL');
    await admin.query("UPDATE formulas SET created_by_name='Autor preservado',updated_at='2020-01-02 03:04:05' WHERE id=6");
    const upgraded = schemaCommand('upgrade',upgradeDatabase);
    expect(upgraded.status,upgraded.stderr).toBe(0);
    expect(schemaCommand('preflight',upgradeDatabase).status).toBe(0);
    expect(schemaCommand('upgrade',upgradeDatabase).status).toBe(0);
    const [rows] = await admin.query<mysql.RowDataPacket[]>('SELECT id,created_by_name,DATE_FORMAT(updated_at,"%Y-%m-%d %H:%i:%s") AS stamp FROM formulas ORDER BY id');
    expect(rows.map(r=>r.created_by_name)).toEqual(['Autor histórico',null,null,null,null,'Autor preservado']);
    expect(rows.every(r=>r.stamp==='2020-01-02 03:04:05')).toBe(true);
    const [saved] = await admin.query<mysql.RowDataPacket[]>('SELECT created_by_name FROM saved_formulas ORDER BY id');
    expect(saved.map(r=>r.created_by_name)).toEqual(['Autor histórico',null,null,null,null,'Autor histórico']);
    const migration2 = await readFile('database/upgrades/002-formula-pagination-order.sql','utf8');
    const digest2 = createHash('sha256').update(migration2.replace(/\r\n/g,'\n')).digest('hex');
    await admin.execute("UPDATE schema_version SET version=2,source='upgrade',checksum=?",[digest2]);
    await admin.execute('INSERT INTO schema_upgrade_history(version,checksum) VALUES(2,?)',[digest2]);
    expect(schemaCommand('preflight',upgradeDatabase).status).toBe(0);
    expect(schemaCommand('upgrade',upgradeDatabase).status).toBe(0);
    const migration1 = await readFile('database/upgrades/001-password-session-expansion.sql','utf8');
    const digest1 = createHash('sha256').update(migration1.replace(/\r\n/g,'\n')).digest('hex');
    await admin.execute("UPDATE schema_version SET version=0,source='upgrade',checksum=?",[digest1]);
    expect(schemaCommand('upgrade',upgradeDatabase).status).toBe(0);
    expect(schemaCommand('preflight',upgradeDatabase).status).toBe(0);
    const lockName = `magisform-schema-${createHash('sha256').update(upgradeDatabase).digest('hex').slice(0,32)}`;
    await admin.execute('SELECT GET_LOCK(?,0)',[lockName]);
    const oldTimeout = process.env.MAGISFORM_DB_LOCK_TIMEOUT_SECONDS;
    process.env.MAGISFORM_DB_LOCK_TIMEOUT_SECONDS = '1';
    try { expect(schemaCommand('upgrade',upgradeDatabase).status).not.toBe(0); }
    finally { if (oldTimeout === undefined) delete process.env.MAGISFORM_DB_LOCK_TIMEOUT_SECONDS; else process.env.MAGISFORM_DB_LOCK_TIMEOUT_SECONDS = oldTimeout; await admin.execute('SELECT RELEASE_LOCK(?)',[lockName]); }
    await admin.query('ALTER TABLE formula_budget_items MODIFY unit TEXT NOT NULL');
    expect(schemaCommand('preflight',upgradeDatabase).status).not.toBe(0);
    expect(schemaCommand('upgrade',upgradeDatabase).status).not.toBe(0);
    await admin.query('ALTER TABLE formula_budget_items MODIFY unit VARCHAR(16) NOT NULL');
    await admin.query("UPDATE schema_version SET checksum=REPEAT('0',64)");
    expect(schemaCommand('upgrade',upgradeDatabase).status).not.toBe(0);
    await admin.query('UPDATE schema_version SET version=999');
    expect(schemaCommand('preflight',upgradeDatabase).status).not.toBe(0);
  },30_000);
});
