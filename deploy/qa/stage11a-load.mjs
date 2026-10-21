import http from 'node:http';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const users = Number(process.argv[2]);
const durationMinutes = Number(process.argv[3]);
const portA = Number(process.env.STAGE11A_PORT_A ?? 3101);
const portB = Number(process.env.STAGE11A_PORT_B ?? 3102);
const pidA = Number(process.env.STAGE11A_PID_A);
const pidB = Number(process.env.STAGE11A_PID_B);
if (![5, 20].includes(users) || !Number.isInteger(durationMinutes) || durationMinutes < 1 || !Number.isInteger(pidA) || pidA <= 0 || !Number.isInteger(pidB) || pidB <= 0) {
  throw new Error('Uso: STAGE11A_PID_A=<pid> STAGE11A_PID_B=<pid> node stage11a-load.mjs 5|20 <minutos>');
}
const targets = [{ tenant: 'a', port: portA, pid: pidA }, { tenant: 'b', port: portB, pid: pidB }];
const execFileAsync = promisify(execFile);
const password = (tenant) => `Etapa11QA_${tenant}_Synthet1c_${crypto.createHash('sha256').update(`STAGE11_QA_${tenant.toUpperCase()}`).digest('hex').slice(0, 8)}`;
const stats = { usersPerInstallation: users, durationMinutes, requests: 0, failures5xx: 0, nonSuccess: 0, bytes: 0, latencies: {}, responseBytes: {}, rowsPerResponse: {}, startedAt: new Date().toISOString(), endedAt: null, samples: [] };

function request(port, method, pathname, session, body) {
  return new Promise((resolve) => {
    const start = performance.now();
    const req = http.request({ hostname: '127.0.0.1', port, method, path: pathname, headers: { host: `127.0.0.1:${port}`, ...(session ? { origin: `http://127.0.0.1:${port}`, cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let bytes = 0; let data = '';
      res.on('data', chunk => { bytes += chunk.length; data += chunk.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, ms: performance.now() - start, bytes, headers: res.headers, payload: (() => { try { return JSON.parse(data); } catch { return null; } })() }));
    });
    req.setTimeout(30_000, () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0, ms: performance.now() - start, bytes: 0, payload: null }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function login(target, index) {
  const username = `s11load${target.tenant}${String(index).padStart(2, '0')}`;
  const csrf = await request(target.port, 'GET', '/api/v1/auth/csrf');
  const session = { cookie: (csrf.headers['set-cookie'] ?? []).map(value => value.split(';')[0]).join('; '), csrf: csrf.payload?.data?.csrfToken };
  const result = await request(target.port, 'POST', '/api/v1/auth/login', session, { username, password: password(target.tenant), force: true });
  if (result.status !== 200) throw new Error(`Login QA ${target.tenant}/${index} falhou (HTTP ${result.status}).`);
  session.cookie += '; ' + (result.headers['set-cookie'] ?? []).map(value => value.split(';')[0]).join('; ');
  return session;
}

async function dockerMetrics() {
  const { stdout: out } = await execFileAsync('docker', ['stats', '--no-stream', '--format', '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}'], { encoding: 'utf8', windowsHide: true });
  const containers = out.trim().split(/\r?\n/).filter(line => /magisform-stage11a-[ab]-db/.test(line)).map(line => { const [name, cpu, memory] = line.split('|'); return { name, cpu: Number.parseFloat(cpu), memory }; });
  const dbConnections = {};
  for (const tenant of ['a', 'b']) {
    const name = `magisform-stage11a-${tenant}-db`;
    const { stdout: output } = await execFileAsync('docker', ['exec', name, 'sh', '-c', 'mariadb -uroot --password="$MARIADB_ROOT_PASSWORD" -N -e "SHOW STATUS LIKE \'Threads_connected\'"'], { encoding: 'utf8', windowsHide: true });
    dbConnections[tenant] = Number(output.trim().split(/\s+/).at(-1));
  }
  const pids = `${pidA},${pidB}`;
  const { stdout: processJson } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', `Get-Process -Id ${pids} | Select-Object Id,CPU,WorkingSet64 | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true });
  const processes = (Array.isArray(JSON.parse(processJson)) ? JSON.parse(processJson) : [JSON.parse(processJson)]).map(row => ({ id: Number(row.Id), cpuSeconds: Number(row.CPU ?? 0), memoryMiB: Number(row.WorkingSet64) / 1_048_576 }));
  return { at: new Date().toISOString(), containers, dbConnections, processes };
}

const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? Number(sorted[Math.ceil(sorted.length * p) - 1].toFixed(2)) : null; };
const sessions = [];
for (const target of targets) for (let index = 1; index <= users; index++) sessions.push({ ...target, index, session: await login(target, index) });

const stopAt = Date.now() + durationMinutes * 60_000;
let lastMetrics = 0;
async function worker(session) {
  let cursor = null;
  while (Date.now() < stopAt) {
    const formulaPath = `/api/v1/formulas?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    for (const pathname of [formulaPath, '/api/v1/health/ready']) {
      const result = await request(session.port, 'GET', pathname, session.session);
      stats.requests++; stats.bytes += result.bytes;
      const key = `${session.tenant}:${pathname.startsWith('/api/v1/formulas') ? 'GET /api/v1/formulas' : 'GET /api/v1/health/ready'}`;
      (stats.latencies[key] ??= []).push(result.ms);
      (stats.responseBytes[key] ??= []).push(result.bytes);
      if (pathname.startsWith('/api/v1/formulas')) {
        const page = result.payload?.data;
        cursor = page?.nextCursor ?? null;
        (stats.rowsPerResponse[key] ??= []).push(Array.isArray(page?.rows) ? page.rows.length : 0);
      }
      if (result.status === 0 || result.status >= 500) stats.failures5xx++;
      if (result.status !== 200) stats.nonSuccess++;
      if (Date.now() >= stopAt) break;
    }
    if (Date.now() - lastMetrics >= 30_000) {
      lastMetrics = Date.now();
      try { stats.samples.push(await dockerMetrics()); } catch (error) { stats.samples.push({ at: new Date().toISOString(), metricsError: error.message }); }
    }
    await delay(10_000);
  }
}
await Promise.all(sessions.map(worker));
stats.endedAt = new Date().toISOString();
stats.error5xxPercent = stats.requests ? Number((stats.failures5xx * 100 / stats.requests).toFixed(4)) : null;
stats.nonSuccessPercent = stats.requests ? Number((stats.nonSuccess * 100 / stats.requests).toFixed(4)) : null;
stats.latencyByTenantAndOperation = Object.fromEntries(Object.entries(stats.latencies).map(([key, values]) => [key, { count: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), p99Ms: percentile(values, 0.99), maxMs: Number(Math.max(...values).toFixed(2)) }]));
stats.responseMetricsByTenantAndOperation = Object.fromEntries(Object.entries(stats.responseBytes).map(([key, values]) => [key, { transferredBytes: values.reduce((sum, value) => sum + value, 0), averageBytes: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)), p95Bytes: percentile(values, 0.95), maxBytes: Math.max(...values), formulaRowsPerResponse: stats.rowsPerResponse[key] ? { average: Number((stats.rowsPerResponse[key].reduce((sum, value) => sum + value, 0) / stats.rowsPerResponse[key].length).toFixed(2)), max: Math.max(...stats.rowsPerResponse[key]) } : null }]));
const processSamples = stats.samples.flatMap(sample => sample.processes ?? []);
stats.nodeProcesses = Object.fromEntries([pidA, pidB].map((pid, index) => {
  const rows = processSamples.filter(row => row.id === pid);
  const deltas = rows.slice(1).map((row, position) => Math.max(0, row.cpuSeconds - rows[position].cpuSeconds));
  return [['a', 'b'][index], { peakMemoryMiB: rows.length ? Number(Math.max(...rows.map(row => row.memoryMiB)).toFixed(2)) : null, startMemoryMiB: rows.length ? Number(rows[0].memoryMiB.toFixed(2)) : null, endMemoryMiB: rows.length ? Number(rows.at(-1).memoryMiB.toFixed(2)) : null, averageCpuPercent: deltas.length ? Number((deltas.reduce((a, b) => a + b, 0) * 100 / (deltas.length * 30)).toFixed(2)) : null, samples: rows.length }];
}));
const mib = (text) => { const match = String(text).match(/^([\d.]+)(B|KB|KiB|MB|MiB|GB|GiB)/); if (!match) return null; const amount = Number(match[1]); return ['GB','GiB'].includes(match[2]) ? amount * 1024 : ['KB','KiB'].includes(match[2]) ? amount / 1024 : match[2] === 'B' ? amount / 1_048_576 : amount; };
stats.databaseContainers = Object.fromEntries(['a', 'b'].map(tenant => {
  const rows = stats.samples.flatMap(sample => sample.containers ?? []).filter(row => row.name === `magisform-stage11a-${tenant}-db`);
  const cpu = rows.map(row => row.cpu).filter(Number.isFinite); const memory = rows.map(row => mib(row.memory)).filter(Number.isFinite);
  return [tenant, { averageCpuPercent: cpu.length ? Number((cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(2)) : null, peakCpuPercent: cpu.length ? Number(Math.max(...cpu).toFixed(2)) : null, averageMemoryMiB: memory.length ? Number((memory.reduce((a, b) => a + b, 0) / memory.length).toFixed(2)) : null, peakMemoryMiB: memory.length ? Number(Math.max(...memory).toFixed(2)) : null, samples: rows.length }];
}));
stats.dbConnections = Object.fromEntries(['a', 'b'].map(tenant => { const values = stats.samples.map(sample => sample.dbConnections?.[tenant]).filter(Number.isFinite); return [tenant, { average: values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)) : null, peak: values.length ? Math.max(...values) : null }]; }));
delete stats.latencies; delete stats.responseBytes; delete stats.rowsPerResponse; delete stats.samples;
process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
