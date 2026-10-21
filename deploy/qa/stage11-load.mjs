import https from 'node:https';
import { loginSession, sessionHeaders } from './web-session.mjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const users = Number(process.argv[2]);
const durationMinutes = Number(process.argv[3]);
if (![5, 20].includes(users) || !Number.isInteger(durationMinutes) || durationMinutes < 1) throw new Error('Uso: node deploy/qa/stage11-load.mjs 5|20 <minutos>');
const hosts = ['qa-a.invalid', 'qa-b.invalid'];
const port = 28443;
const password = (tenant) => `Etapa11QA_${tenant}_Synthet1c_${crypto.createHash('sha256').update(`STAGE11_QA_${tenant.toUpperCase()}`).digest('hex').slice(0, 8)}`;
const agent = new https.Agent({ keepAlive: true, maxSockets: 100, rejectUnauthorized: false, lookup: (_hostname, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (options?.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
  else callback(null, '127.0.0.1', 4);
} });
const stats = { users, durationMinutes, requests: 0, failures5xx: 0, nonSuccess: 0, bytes: 0, latencies: {}, responseBytes: {}, rowsPerResponse: {}, startAt: new Date().toISOString(), endAt: null, samples: [] };

function request(host, method, pathname, session, body) {
  return new Promise((resolve) => {
    const start = performance.now();
    const req = https.request({ hostname: host, port, method, path: pathname, agent, headers: { host, ...sessionHeaders(host, port, session), ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let bytes = 0; let body = '';
      res.on('data', (chunk) => { bytes += chunk.length; body += chunk.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, ms: performance.now() - start, bytes, headers: res.headers, payload: (() => { try { return JSON.parse(body); } catch { return null; } })() }));
    });
    req.setTimeout(30_000, () => req.destroy(new Error('request timeout')));
    req.on('error', () => resolve({ status: 0, ms: performance.now() - start, bytes: 0, payload: null }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function dockerMetrics() {
  const out = execFileSync('docker', ['stats', '--no-stream', '--format', '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}'], { encoding: 'utf8', windowsHide: true });
  const relevant = out.trim().split(/\r?\n/).filter((line) => /magisform-(npm-stage11|stage11-[ab]-(app|db)-1)/.test(line));
  const dbConnections = {};
  for (const tenant of ['a', 'b']) {
    const container = `magisform-stage11-${tenant}-db-1`;
    const result = execFileSync('docker', ['exec', container, 'sh', '-c', 'mariadb -uroot --password="$(cat /run/secrets/db_root_password)" -N -e "SHOW STATUS LIKE \'Threads_connected\'"'], { encoding: 'utf8', windowsHide: true });
    dbConnections[tenant] = Number(result.trim().split(/\s+/).at(-1));
  }
  return { at: new Date().toISOString(), containers: relevant.map((line) => { const [name, cpu, memory] = line.split('|'); return { name, cpu: Number.parseFloat(cpu), memory }; }), dbConnections };
}
function percentile(values, percentileValue) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? Number(sorted[Math.ceil(sorted.length * percentileValue) - 1].toFixed(2)) : null;
}

const sessions = [];
for (const host of hosts) {
  const tenant = host.endsWith('-a.invalid') ? 'a' : 'b';
  for (let index = 1; index <= users; index++) {
    const username = `s11load${tenant}${String(index).padStart(2, '0')}`;
    const loginResult = await loginSession((host, path, options = {}) => request(host, options.method ?? 'GET', path, options.session, options.body), host, username, password(tenant), true);
    if (loginResult.status !== 200) throw new Error(`Login QA ${tenant}/${index} falhou com HTTP ${loginResult.status}.`);
    sessions.push({ host, tenant, index, session: loginResult.session });
  }
}

const stopAt = Date.now() + durationMinutes * 60_000;
let lastMetrics = 0;
async function worker(session) {
  let cursor = null;
  while (Date.now() < stopAt) {
    const formulaPath = `/api/v1/formulas?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    for (const pathname of [formulaPath, '/api/v1/health/ready']) {
      const result = await request(session.host, 'GET', pathname, session.session);
      stats.requests += 1;
      stats.bytes += result.bytes;
      const metricKey = `${session.tenant}:${pathname}`;
      (stats.latencies[metricKey] ??= []).push(result.ms);
      (stats.responseBytes[metricKey] ??= []).push(result.bytes);
      if (pathname.startsWith('/api/v1/formulas')) {
        const page = result.payload?.data;
        cursor = page?.nextCursor ?? null;
        (stats.rowsPerResponse[metricKey] ??= []).push(Array.isArray(page?.rows) ? page.rows.length : 0);
      }
      if (result.status >= 500 || result.status === 0) stats.failures5xx += 1;
      if (result.status !== 200) stats.nonSuccess += 1;
      if (Date.now() >= stopAt) break;
    }
    const now = Date.now();
    if (now - lastMetrics >= 30_000) {
      lastMetrics = now;
      try { stats.samples.push(dockerMetrics()); } catch (error) { stats.samples.push({ at: new Date().toISOString(), metricsError: error.message }); }
    }
    await delay(10_000);
  }
}
await Promise.all(sessions.map(worker));
agent.destroy();
stats.endAt = new Date().toISOString();
stats.error5xxPercent = stats.requests ? Number((stats.failures5xx * 100 / stats.requests).toFixed(4)) : null;
stats.nonSuccessPercent = stats.requests ? Number((stats.nonSuccess * 100 / stats.requests).toFixed(4)) : null;
stats.latencyByTenantAndOperation = Object.fromEntries(Object.entries(stats.latencies).map(([key, values]) => [key, { count: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), p99Ms: percentile(values, 0.99), maxMs: Number(Math.max(...values).toFixed(2)) }]));
stats.responseMetricsByTenantAndOperation = Object.fromEntries(Object.entries(stats.responseBytes).map(([key, values]) => [key, { transferredBytes: values.reduce((sum, value) => sum + value, 0), averageBytes: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)), p95Bytes: percentile(values, 0.95), maxBytes: Math.max(...values), formulaRowsPerResponse: stats.rowsPerResponse[key] ? { average: Number((stats.rowsPerResponse[key].reduce((sum, value) => sum + value, 0) / stats.rowsPerResponse[key].length).toFixed(2)), max: Math.max(...stats.rowsPerResponse[key]) } : null }]));
delete stats.latencies;
delete stats.responseBytes;
delete stats.rowsPerResponse;
const resourceRows = stats.samples.flatMap((sample) => sample.containers ?? []);
stats.resources = Object.fromEntries([...new Set(resourceRows.map(({ name }) => name))].map((name) => {
  const rows = resourceRows.filter((row) => row.name === name);
  const memoryMiB = (value) => { const [, amount, unit] = value.match(/^([\d.]+)(B|KB|KiB|MB|MiB|GB|GiB)/) ?? []; const number = Number(amount); return unit === 'GiB' || unit === 'GB' ? number * 1024 : unit === 'KiB' || unit === 'KB' ? number / 1024 : unit === 'B' ? number / 1_048_576 : number; };
  return [name, { averageCpuPercent: Number((rows.reduce((total, row) => total + row.cpu, 0) / rows.length).toFixed(2)), peakCpuPercent: Number(Math.max(...rows.map((row) => row.cpu)).toFixed(2)), peakMemoryMiB: Number(Math.max(...rows.map((row) => memoryMiB(row.memory))).toFixed(2)) }];
}));
stats.dbConnections = Object.fromEntries(['a', 'b'].map((tenant) => { const values = stats.samples.map((sample) => sample.dbConnections?.[tenant]).filter(Number.isFinite); return [tenant, { average: values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)) : null, peak: values.length ? Math.max(...values) : null }]; }));
delete stats.samples;
process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
