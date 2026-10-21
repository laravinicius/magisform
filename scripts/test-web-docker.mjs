// QA isolado: nunca usa o catálogo, volumes ou segredos de uma instalação existente.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hash } from '@node-rs/argon2';
import { createTenantControl } from '../dist-server/manager/agent.js';
import { buildManagerApi } from '../dist-server/manager/api.js';
import { createTotpSecret, totpAt } from '../dist-server/manager/totp.js';

const exec = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magisform-web-qa-'));
const suffix = crypto.randomBytes(5).toString('hex');
const image = `magisform:git-${suffix}`;
const tenants = ['a', 'b'].map(letter => ({ id: `webqa-${suffix}-${letter}`, host: `webqa-${suffix}-${letter}.invalid`, brand: `Farmácia QA ${letter.toUpperCase()}` }));
const run = async (command, args, options = {}) => (await exec(command, args, { windowsHide: true, timeout: 180_000, maxBuffer: 4 * 1024 * 1024, ...options })).stdout.trim();
const docker = (...args) => run('docker', args);
let manager;
const states = new Map();
const cookies = value => (Array.isArray(value) ? value : [value]).filter(Boolean).map(value => value.split(';')[0]).join('; ');

async function container(tenant) {
  const rows = JSON.parse(await docker('inspect', `magisform-${tenant.id}-app-1`));
  const ip = rows[0].NetworkSettings.Networks[`npm-${tenant.id}`].IPAddress;
  return { name: rows[0].Name.slice(1), ip };
}

async function request(tenant, route, method = 'GET', body, headers = {}) {
  const target = await container(tenant);
  // A chamada sai da rede edge confiável e simula o encaminhamento HTTPS do proxy.
  const options = { hostname: target.ip, port: 3001, path: `/api/v1${route}`, method, headers: { host: tenant.host, 'x-forwarded-proto': 'https', origin: `https://${tenant.host}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } };
  const code = `const req=require('http').request(${JSON.stringify(options)},r=>{let data='';r.on('data',c=>data+=c);r.on('end',()=>console.log(JSON.stringify({status:r.statusCode,cookies:r.headers['set-cookie']??[],data:JSON.parse(data)})))});req.on('error',()=>process.exit(1));req.end(${JSON.stringify(body === undefined ? '' : JSON.stringify(body))});`;
  return JSON.parse(await docker('exec', target.name, 'node', '-e', code));
}

async function login(tenant, credentials) {
  const csrf = await request(tenant, '/auth/csrf');
  const headers = { cookie: cookies(csrf.cookies), 'x-csrf-token': csrf.data.data.csrfToken };
  const result = await request(tenant, '/auth/login', 'POST', { username: credentials.username, password: credentials.password, force: true }, headers);
  assert.equal(result.status, 200);
  headers.cookie += '; ' + cookies(result.cookies);
  return headers;
}

async function ready(tenant) {
  let last = '';
  for (let attempt = 0; attempt < 40; attempt++) {
    try { const result = await request(tenant, '/health/ready'); if (result.status === 200) return; last = `HTTP ${result.status}`; } catch (error) { last = error.message; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  console.error(await docker('logs', '--tail', '8', `magisform-${tenant.id}-app-1`));
  throw new Error(`Instalação QA ${tenant.id} não ficou pronta: ${last}`);
}

try {
  await docker('tag', process.env.MAGISFORM_QA_IMAGE ?? 'magisform:web-removal-qa', image);
  for (const directory of ['scripts', 'database/upgrades', 'deploy/tenant-template']) await fs.mkdir(path.join(root, directory), { recursive: true });
  for (const file of ['scripts/provision-tenant.mjs', 'database.sql', 'deploy/tenant-template/compose.yaml']) await fs.copyFile(file, path.join(root, file));
  await fs.cp('database/upgrades', path.join(root, 'database/upgrades'), { recursive: true });
  for (const tenant of tenants) {
    const output = await run(process.execPath, ['scripts/provision-tenant.mjs', tenant.id, tenant.host, '--image', image, '--brand', tenant.brand, '--admin-name', 'Administrador QA', '--admin-user', 'admin-qa', '--apply', '--json-result'], { env: { ...process.env, MAGISFORM_PROVISION_ROOT: root } });
    const credentials = JSON.parse(output).admin;
    await ready(tenant);
    states.set(tenant.id, await login(tenant, credentials));
    const created = await request(tenant, '/customers', 'POST', { name: `Paciente ${tenant.brand}`, phone: tenant === tenants[0] ? '5541999990001' : '5541999990002' }, states.get(tenant.id));
    assert.equal(created.status, 200);
    const publicConfig = await request(tenant, '/public-config');
    assert.equal(publicConfig.data.data.brand, tenant.brand);
    assert.deepEqual(publicConfig.data.data.capabilities, ['web']);
    console.log(`Provisionamento, login cookie/CSRF, CRUD e marca: ${tenant.id} aprovados.`);
  }
  const crossed = await request(tenants[1], '/customers', 'GET', undefined, states.get(tenants[0].id));
  assert.equal(crossed.status, 401);
  const rowsB = await request(tenants[1], '/customers', 'GET', undefined, states.get(tenants[1].id));
  assert(!JSON.stringify(rowsB.data).includes(tenants[0].brand));
  for (const tenant of tenants) {
    const inspect = JSON.parse(await docker('inspect', `magisform-${tenant.id}-db-1`))[0];
    assert.equal(Object.keys(inspect.NetworkSettings.Networks).length, 1);
    assert.equal(inspect.HostConfig.PortBindings && Object.keys(inspect.HostConfig.PortBindings).length, 0);
    const network = JSON.parse(await docker('network', 'inspect', `magisform-${tenant.id}_data`))[0];
    assert.equal(network.Internal, true);
  }
  const origin = 'http://127.0.0.1:3303';
  const password = crypto.randomBytes(24).toString('hex');
  const totpSecret = createTotpSecret();
  const control = createTenantControl({ root, token: crypto.randomBytes(32).toString('hex'), port: 3101, approvedImages: [image] });
  manager = await buildManagerApi({ config: { origin, secure: false, trustProxy: false, agentOrigin: 'http://127.0.0.1:1', agentToken: crypto.randomBytes(32).toString('hex'), port: 3303, operatorFile: '', approvedImages: [image], webRoot: path.resolve('dist-manager') }, operator: { username: 'qa', passwordHash: await hash(password), totpSecret }, control });
  const csrf = await manager.inject('/api/manager/v1/auth/csrf');
  const headers = { origin, cookie: cookies(csrf.headers['set-cookie']), 'x-csrf-token': csrf.json().data.csrfToken };
  const auth = await manager.inject({ method: 'POST', url: '/api/manager/v1/auth/login', headers, payload: { username: 'qa', password, totp: totpAt(totpSecret) } });
  assert.equal(auth.statusCode, 200);
  headers.cookie += '; ' + cookies(auth.headers['set-cookie']);
  const listing = await manager.inject({ url: '/api/manager/v1/installations', headers });
  assert.equal(listing.json().data.length, 2);
  assert.equal((await manager.inject('/')).statusCode, 200);
  for (const action of ['stop', 'start', 'restart']) {
    for (const tenant of tenants) {
      const response = await manager.inject({ method: 'POST', url: `/api/manager/v1/installations/${tenant.id}/actions`, headers, payload: { action } });
      assert.equal(response.statusCode, 200);
      if (action === 'stop') {
        const info = JSON.parse(await docker('inspect', `magisform-${tenant.id}-app-1`))[0];
        assert.equal(info.State.Running, false);
      } else {
        await ready(tenant);
        const rows = await request(tenant, '/customers', 'GET', undefined, states.get(tenant.id));
        assert.equal(rows.status, 200);
        assert.equal(rows.data.data[0].name, `Paciente ${tenant.brand}`);
      }
    }
    console.log(`Painel/API com Docker real: ${action} e persistência aprovados.`);
  }
  console.log('QA Docker aprovado: dois clientes, isolamento, painel, ciclo de vida e persistência.');
} finally {
  if (manager) await manager.close();
  for (const tenant of tenants) {
    const directory = path.join(root, 'deploy/tenants', tenant.id);
    try {
      await fs.access(path.join(directory, 'compose.yaml'));
      await run('docker', ['compose', '--project-name', `magisform-${tenant.id}`, '--file', path.join(directory, 'compose.yaml'), 'down', '--volumes', '--remove-orphans'], { cwd: directory });
    } catch { /* recurso ainda não criado */ }
    try { await docker('network', 'rm', `npm-${tenant.id}`); } catch { /* recurso ainda não criado */ }
  }
  try { await docker('image', 'rm', image); } catch { /* tag ainda não criada */ }
  if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('magisform-web-qa-')) await fs.rm(root, { recursive: true, force: true });
}
