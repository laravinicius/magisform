import { readFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { webLogin } from './fixtures/webSession';

const base = { host: process.env.MARIADB_HOST ?? '127.0.0.1', port: Number(process.env.MARIADB_PORT ?? 3306), user: process.env.MARIADB_USER ?? 'root', password: process.env.MARIADB_PASSWORD ?? '' };
const database = `magisform_server_${crypto.randomBytes(4).toString('hex')}`;
let admin: mysql.Connection;
let pool: mysql.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
const enabled = !!process.env.MARIADB_HOST;
const cookieHeader = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value ?? '').split(';')[0];

describe.skipIf(!enabled)('API HTTP com MariaDB isolado', () => {
  beforeAll(async () => {
    admin = await mysql.createConnection({ ...base, multipleStatements: true });
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    const sql = (await readFile(path.resolve('database.sql'), 'utf8')).replace(/CREATE DATABASE IF NOT EXISTS magisform[\s\S]*?;\s*USE magisform;?/i, '');
    await admin.query(`USE \`${database}\`; ${sql}`);
    pool = mysql.createPool({ ...base, database, dateStrings: true, timezone: '-03:00' });
    const password = crypto.createHash('sha256').update('senha-de-teste').digest('hex');
    await pool.execute('INSERT INTO users(name,username,password,role) VALUES(?,?,?,?)', ['Admin QA', 'admin-qa', password, 'admin']);
    await pool.execute('INSERT INTO users(name,username,password,role) VALUES(?,?,?,?)', ['Gerente QA', 'manager-qa', password, 'manager']);
    await pool.execute('INSERT INTO users(name,username,password,role) VALUES(?,?,?,?)', ['Browser QA', 'browser-qa', password, 'admin']);
    await pool.execute('INSERT INTO schema_version(singleton,version,source,checksum) VALUES(1,5,?,?)', ['bootstrap', '0'.repeat(64)]);
    const config = loadConfig({ NODE_ENV: 'test', MAGISFORM_SERVER_HOST: '127.0.0.1', MAGISFORM_SERVER_PORT: '3001', MAGISFORM_SERVER_DB_HOST: base.host, MAGISFORM_SERVER_DB_PORT: String(base.port), MAGISFORM_SERVER_DB_NAME: database, MAGISFORM_SERVER_DB_USER: base.user, MAGISFORM_SERVER_DB_PASSWORD: base.password });
    app = await buildApp({ config, pool, closePool: false });
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS \`${database}\``); await admin.end(); }
  });

  it('publica health e OpenAPI sem divulgar detalhes internos', async () => {
    const live = await app.inject({ method: 'GET', url: '/api/v1/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.json().data).toEqual({ status: 'ok' });
    const ready = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(ready.statusCode).toBe(200);
    const openapi = await app.inject({ method: 'GET', url: '/api/docs/json' });
    expect(openapi.statusCode).toBe(200);
    expect(openapi.json().paths['/api/v1/auth/desktop/login']).toBeUndefined();
    expect(openapi.json().components.securitySchemes.BearerAuth).toBeUndefined();
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/desktop/login', payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/v1/orders', headers: { authorization: 'Bearer ' + 'a'.repeat(64) } })).statusCode).toBe(400);
    expect(openapi.json().paths['/api/v1/orders'].post.requestBody).toBeDefined();
    expect(openapi.json().components.schemas.UserDto).toBeDefined();
    expect(JSON.stringify(ready.json())).not.toMatch(/password|sql|host/i);
  });

  it('valida configuração de produção e encerra o pool no shutdown', async () => {
    const productionEnv = { NODE_ENV: 'production', MAGISFORM_SERVER_DB_HOST: base.host, MAGISFORM_SERVER_DB_NAME: database, MAGISFORM_SERVER_DB_USER: base.user, MAGISFORM_SERVER_DB_PASSWORD: base.password };
    expect(() => loadConfig(productionEnv)).toThrow(/ORIGIN HTTPS/);
    expect(() => loadConfig({ ...productionEnv, MAGISFORM_SERVER_ORIGIN: 'https://farmacia.example', MAGISFORM_SERVER_TRUST_PROXY: 'not-an-ip' })).toThrow(/IPs\/CIDRs de proxy/);
    expect(loadConfig({ ...productionEnv, MAGISFORM_SERVER_ORIGIN: 'https://farmacia.example', MAGISFORM_SERVER_TRUST_PROXY: '172.28.16.0/24' }).trustProxy).toEqual(['172.28.16.0/24']);
    expect(() => loadConfig({ NODE_ENV: 'test', MAGISFORM_SERVER_DB_HOST: base.host, MAGISFORM_SERVER_DB_NAME: database, MAGISFORM_SERVER_DB_USER: base.user, MAGISFORM_SERVER_DB_PASSWORD: base.password, MAGISFORM_SERVER_BRAND_PRIMARY: 'red; background:url(javascript:1)' })).toThrow(/Configuração do servidor inválida/);
    expect(() => loadConfig({ NODE_ENV: 'test', MAGISFORM_SERVER_HOST: '0.0.0.0', MAGISFORM_SERVER_DB_HOST: base.host, MAGISFORM_SERVER_DB_NAME: database, MAGISFORM_SERVER_DB_USER: base.user, MAGISFORM_SERVER_DB_PASSWORD: base.password })).toThrow(/loopback/);
    const ownedPool = mysql.createPool({ ...base, database });
    const ownedApp = await buildApp({ config: loadConfig({ NODE_ENV: 'test', MAGISFORM_SERVER_DB_HOST: base.host, MAGISFORM_SERVER_DB_NAME: database, MAGISFORM_SERVER_DB_USER: base.user, MAGISFORM_SERVER_DB_PASSWORD: base.password }), pool: ownedPool });
    await ownedApp.close();
    await expect(ownedPool.query('SELECT 1')).rejects.toThrow();
  });

  it('aceita Host e HTTPS encaminhados somente por CIDR confiável', async () => {
    const proxyConfig = loadConfig({ NODE_ENV: 'production', MAGISFORM_SERVER_HOST: '0.0.0.0', MAGISFORM_SERVER_ORIGIN: 'https://farmacia.example', MAGISFORM_SERVER_TRUST_PROXY: '10.20.30.0/24', MAGISFORM_SERVER_DB_HOST: base.host, MAGISFORM_SERVER_DB_PORT: String(base.port), MAGISFORM_SERVER_DB_NAME: database, MAGISFORM_SERVER_DB_USER: base.user, MAGISFORM_SERVER_DB_PASSWORD: base.password });
    const proxyApp = await buildApp({ config: proxyConfig, pool, closePool: false });
    try {
      const localHealth = await proxyApp.inject({ method: 'GET', url: '/health/live', remoteAddress: '127.0.0.1', headers: { host: 'localhost' } });
      expect(localHealth.statusCode).toBe(200);
      const trusted = await proxyApp.inject({ method: 'GET', url: '/api/v1/health/live', remoteAddress: '10.20.30.9', headers: { host: 'farmacia.example', 'x-forwarded-proto': 'https' } });
      expect(trusted.statusCode).toBe(200);
      const spoofed = await proxyApp.inject({ method: 'GET', url: '/api/v1/health/live', remoteAddress: '127.0.0.1', headers: { host: 'farmacia.example', 'x-forwarded-proto': 'https' } });
      expect(spoofed.statusCode).toBe(404);
      const wrongHost = await proxyApp.inject({ method: 'GET', url: '/api/v1/health/live', remoteAddress: '10.20.30.9', headers: { host: 'outra-farmacia.example', 'x-forwarded-proto': 'https' } });
      expect(wrongHost.statusCode).toBe(404);
      const wrongProtocol = await proxyApp.inject({ method: 'GET', url: '/api/v1/health/live', remoteAddress: '10.20.30.9', headers: { host: 'farmacia.example', 'x-forwarded-proto': 'http' } });
      expect(wrongProtocol.statusCode).toBe(404);
    } finally { await proxyApp.close(); }
  });

  it('protege login web com Origin/CSRF, valida payload e retorna erro seguro', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/v1/orders' });
    expect(denied.statusCode).toBe(401);
    const csrf = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf' });
    const csrfToken = csrf.json().data.csrfToken;
    const csrfCookie = cookieHeader(csrf.headers['set-cookie']);
    const noCsrf = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://127.0.0.1:3001', cookie: csrfCookie }, payload: { username: 'admin-qa', password: 'senha-de-teste' } });
    expect(noCsrf.statusCode).toBe(403);
    const badOrigin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'https://attacker.invalid', cookie: csrfCookie, 'x-csrf-token': csrfToken }, payload: { username: 'admin-qa', password: 'senha-de-teste' } });
    expect(badOrigin.statusCode).toBe(403);
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://127.0.0.1:3001', cookie: csrfCookie, 'x-csrf-token': csrfToken }, payload: { username: '', password: '' } });
    expect(invalid.statusCode).toBe(400);
    expect(JSON.stringify(invalid.json())).not.toMatch(/stack|sql|password/i);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const failedLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://127.0.0.1:3001', cookie: csrfCookie, 'x-csrf-token': csrfToken }, payload: { username: 'rate-limit-qa', password: 'senha-incorreta' } });
      expect(failedLogin.statusCode).toBe(401);
    }
    const limited = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://127.0.0.1:3001', cookie: csrfCookie, 'x-csrf-token': csrfToken }, payload: { username: 'rate-limit-qa', password: 'senha-incorreta' } });
    expect(limited.statusCode).toBe(429);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/setup' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/database' })).statusCode).toBe(404);
    expect(limited.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('mantém sessões, permissões e administração de usuários e insumos', async () => {
    const adminSession = await webLogin(app, 'admin-qa', 'senha-de-teste', true);
    expect(adminSession.response.statusCode).toBe(200);
    const cookie = String(adminSession.response.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(JSON.stringify(adminSession.response.json())).not.toMatch(/token|password/i);
    expect((await app.inject({ url: '/api/v1/auth/me', headers: adminSession.headers })).json().data.authenticated).toBe(true);
    expect((await app.inject({ method:'POST', url:'/api/v1/partners', headers:{ cookie:adminSession.headers.cookie }, payload:{name:'CSRF negado'} })).statusCode).toBe(403);
    const user = await app.inject({ method:'POST', url:'/api/v1/users', headers:adminSession.headers, payload:{name:'Funcionário QA',username:'employee-qa',password:'senha',role:'employee'} });
    expect(user.statusCode, user.body).toBe(200);
    const employee = await webLogin(app,'employee-qa','senha');
    expect(employee.response.statusCode).toBe(200);
    expect((await app.inject({url:'/api/v1/users',headers:employee.headers})).statusCode).toBe(403);
    expect((await app.inject({url:'/api/v1/partners',headers:employee.headers})).statusCode).toBe(403);
    const insumo = await app.inject({method:'POST',url:'/api/v1/insumos',headers:adminSession.headers,payload:{name:'Insumo QA'}});
    expect(insumo.statusCode).toBe(200);
    const insumoId=insumo.json().data.id;
    expect((await app.inject({method:'PATCH',url:`/api/v1/insumos/${insumoId}`,headers:adminSession.headers,payload:{name:'Insumo atualizado'}})).statusCode).toBe(200);
    expect((await app.inject({method:'DELETE',url:`/api/v1/insumos/${insumoId}`,headers:adminSession.headers,payload:{username:'admin-qa',password:'senha-inválida'}})).statusCode).toBe(403);
    expect((await app.inject({method:'DELETE',url:`/api/v1/insumos/${insumoId}`,headers:adminSession.headers,payload:{username:'admin-qa',password:'senha-de-teste'}})).statusCode).toBe(200);
    expect((await app.inject({method:'DELETE',url:`/api/v1/users/${user.json().data.id}`,headers:adminSession.headers,payload:{username:'admin-qa',password:'senha-de-teste'}})).statusCode).toBe(200);
    const unlinkedLogs = await app.inject({url:'/api/v1/logs?userId=0',headers:adminSession.headers});
    expect(unlinkedLogs.statusCode).toBe(200);
    expect(unlinkedLogs.json().data.rows.length).toBeGreaterThan(0);
    expect(unlinkedLogs.json().data.rows.every((row: { user_id: number | null }) => row.user_id === null)).toBe(true);
    const conflict = await webLogin(app,'admin-qa','senha-de-teste');
    expect(conflict.response.statusCode).toBe(409);
    const forced = await webLogin(app,'admin-qa','senha-de-teste',true);
    expect(forced.response.statusCode).toBe(200);
    expect((await app.inject({url:'/api/v1/orders',headers:adminSession.headers})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/api/v1/auth/logout',headers:forced.headers,payload:{}})).statusCode).toBe(200);
  });

  it('mantém duas sessões web de contas distintas na mesma instalação', async () => {
    const first = await webLogin(app, 'admin-qa', 'senha-de-teste', true);
    const second = await webLogin(app, 'browser-qa', 'senha-de-teste');
    expect(first.response.statusCode).toBe(200);
    expect(second.response.statusCode).toBe(200);
    const created = await app.inject({ method: 'POST', url: '/api/v1/insumos', headers: first.headers, payload: { name: 'Insumo entre sessões QA' } });
    expect(created.statusCode).toBe(200);
    const rows = (await app.inject({ url: '/api/v1/insumos', headers: second.headers })).json().data;
    expect(rows.some((row: any) => row.id === created.json().data.id)).toBe(true);
    for (const session of [first, second]) expect((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: session.headers, payload: {} })).statusCode).toBe(200);
  });
});
