import https from 'node:https';
import { loginSession, sessionHeaders } from './web-session.mjs';
import http from 'node:http';
import crypto from 'node:crypto';

const tlsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false, lookup: (_hostname, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (options?.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
  else callback(null, '127.0.0.1', 4);
} });
const hostA = 'qa-a.invalid';
const hostB = 'qa-b.invalid';
const port = 28443;
const password = (tenant) => `Etapa11QA_${tenant}_Synthet1c_${crypto.createHash('sha256').update(`STAGE11_QA_${tenant.toUpperCase()}`).digest('hex').slice(0, 8)}`;
const fail = (message) => { throw new Error(message); };
function httpsRequest(host, pathname, { method = 'GET', session, body, overrideHost } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, port, method, path: pathname, agent: tlsAgent, headers: { host: overrideHost ?? host, ...sessionHeaders(host, port, session), ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let data = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: data, json: (() => { try { return JSON.parse(data); } catch { return null; } })() }));
    });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}
async function expectStatus(name, actual, expected, evidence) {
  if (actual !== expected) fail(`${name}: HTTP ${actual}, esperado ${expected}.`);
  console.log(`${name}: HTTP ${actual}${evidence ? ` (${evidence})` : ''}`);
}
async function login(host, tenant, force = false) {
  const username = `s11load${tenant}01`;
  return loginSession(httpsRequest, host, username, password(tenant), force);
}

try {
  const rootA = await httpsRequest(hostA, '/');
  await expectStatus('frontend A por NPM/HTTPS', rootA.status, 200);
  const rootB = await httpsRequest(hostB, '/');
  await expectStatus('frontend B por NPM/HTTPS', rootB.status, 200);
  const readyA = await httpsRequest(hostA, '/api/v1/health/ready');
  await expectStatus('health A por NPM/HTTPS', readyA.status, 200);
  const readyB = await httpsRequest(hostB, '/api/v1/health/ready');
  await expectStatus('health B por NPM/HTTPS', readyB.status, 200);
  const unknown = await httpsRequest('desconhecido.invalid', '/');
  await expectStatus('host desconhecido TLS fallback', unknown.status, 404);
  const httpRedirect = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: 28080, path: '/', headers: { host: hostA } }, (res) => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject));
  await expectStatus('HTTP A forçado para HTTPS', httpRedirect.statusCode ?? 0, 301, httpRedirect.headers.location);

  const anonymous = await httpsRequest(hostA, '/api/v1/customers');
  await expectStatus('consulta sem sessão', anonymous.status, 401);
  const first = await login(hostA, 'a', true);
  await expectStatus('login inicial A', first.status, 200);
  const firstToken = first.session;
  if (!firstToken) fail('Login A não entregou cookie de sessão.');
  const conflict = await login(hostA, 'a');
  await expectStatus('conflito de sessão única A', conflict.status, 409);
  const forced = await login(hostA, 'a', true);
  await expectStatus('login forçado A', forced.status, 200);
  const newToken = forced.session;
  if (!newToken) fail('Login forçado A não entregou cookie.');
  const revoked = await httpsRequest(hostA, '/api/v1/customers', { session: firstToken });
  await expectStatus('cookie anterior após force', revoked.status, 401);
  const ownA = await httpsRequest(hostA, '/api/v1/formulas?limit=50', { session: newToken });
  await expectStatus('listagem de dados A', ownA.status, 200, ownA.text.includes('Atendente QA A') ? 'marcador A presente' : 'sem marcador A');
  if (!ownA.text.includes('Atendente QA A')) fail('A não retornou marcador de fórmula A.');
  const cross = await httpsRequest(hostB, '/api/v1/customers', { session: newToken });
  await expectStatus('cookie A usado contra B', cross.status, 401);
  const second = await login(hostB, 'b', true);
  await expectStatus('login B', second.status, 200);
  const ownB = await httpsRequest(hostB, '/api/v1/formulas?limit=50', { session: second.session });
  await expectStatus('listagem de dados B', ownB.status, 200, ownB.text.includes('Atendente QA B') ? 'marcador B presente' : 'sem marcador B');
  if (!ownB.text.includes('Atendente QA B')) fail('B não retornou marcador de fórmula B.');
  const mismatch = await httpsRequest(hostA, '/api/v1/health/ready', { overrideHost: 'intruso.invalid' });
  await expectStatus('Host divergente encaminhado pelo Proxy Host', mismatch.status, 404);
  console.log('Matriz de rota, sessão e isolamento HTTP: aprovada.');
} finally {
  tlsAgent.destroy();
}
