import { spawn, spawnSync } from 'node:child_process';
import { openSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';

const statePath = path.join(os.tmpdir(), 'magisform-stage11a-qa.json');
const tenants = [
  { tenant: 'a', port: 33111, apiPort: 3101, dbPassword: 'Stage11aAppQA_A', rootPassword: 'Stage11aRootQA_A' },
  { tenant: 'b', port: 33112, apiPort: 3102, dbPassword: 'Stage11aAppQA_B', rootPassword: 'Stage11aRootQA_B' },
];
const docker = (...args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(result.stderr?.trim() || result.error?.message || `docker ${args[0]} falhou.`);
  return result.stdout.trim();
};
const runNode = (args, env) => {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) throw new Error(result.stderr?.trim() || result.error?.message || `Node ${args.join(' ')} falhou.`);
};

try {
  docker('image', 'inspect', 'mariadb:11.4');
  for (const item of tenants) {
    docker('run', '--detach', '--rm', '--name', `magisform-stage11a-${item.tenant}-db`, '--env', `MARIADB_ROOT_PASSWORD=${item.rootPassword}`, '--env', 'MARIADB_ROOT_HOST=%', '--env', 'MARIADB_DATABASE=magisform', '--env', 'MARIADB_USER=magisform_app', '--env', `MARIADB_PASSWORD=${item.dbPassword}`, '--publish', `127.0.0.1:${item.port}:3306`, 'mariadb:11.4');
  }
  for (const item of tenants) {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const conn = await mysql.createConnection({ host: '127.0.0.1', port: item.port, user: 'root', password: item.rootPassword, connectTimeout: 1500 });
        await conn.end(); ready = true; break;
      } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
    if (!ready) throw new Error(`MariaDB ${item.tenant.toUpperCase()} não ficou pronto.`);
    runNode(['scripts/database-schema.mjs', 'bootstrap'], { MAGISFORM_DB_HOST: '127.0.0.1', MAGISFORM_DB_PORT: String(item.port), MAGISFORM_DB_NAME: 'magisform', MAGISFORM_DB_USER: 'root', MAGISFORM_DB_PASSWORD: item.rootPassword });
    runNode(['deploy/qa/stage11-fixtures.mjs', item.tenant], { MAGISFORM_SERVER_DB_HOST: '127.0.0.1', MAGISFORM_SERVER_DB_PORT: String(item.port), MAGISFORM_SERVER_DB_NAME: 'magisform', MAGISFORM_SERVER_DB_USER: 'magisform_app', MAGISFORM_SERVER_DB_PASSWORD: item.dbPassword });
  }
  const children = [];
  for (const item of tenants) {
    const stdoutPath = path.join(os.tmpdir(), `magisform-stage11a-${item.tenant}-server.log`);
    const stderrPath = path.join(os.tmpdir(), `magisform-stage11a-${item.tenant}-server-error.log`);
    const child = spawn(process.execPath, ['dist-server/server/index.js'], { cwd: process.cwd(), detached: true, windowsHide: true, stdio: ['ignore', openSync(stdoutPath, 'a'), openSync(stderrPath, 'a')], env: { ...process.env, NODE_ENV: 'development', MAGISFORM_SERVER_HOST: '127.0.0.1', MAGISFORM_SERVER_PORT: String(item.apiPort), MAGISFORM_SERVER_ORIGIN: `http://127.0.0.1:${item.apiPort}`, MAGISFORM_SERVER_INSTALLATION_NAME: `QA Empresa ${item.tenant.toUpperCase()}`, MAGISFORM_SERVER_VERSION: '0.2.8', MAGISFORM_SERVER_DB_HOST: '127.0.0.1', MAGISFORM_SERVER_DB_PORT: String(item.port), MAGISFORM_SERVER_DB_NAME: 'magisform', MAGISFORM_SERVER_DB_USER: 'magisform_app', MAGISFORM_SERVER_DB_PASSWORD: item.dbPassword, MAGISFORM_SERVER_DB_CONNECTION_LIMIT: '12' } });
    child.unref(); children.push({ tenant: item.tenant, pid: child.pid, apiPort: item.apiPort, stdoutPath, stderrPath });
  }
  writeFileSync(statePath, JSON.stringify({ containers: tenants.map(item => `magisform-stage11a-${item.tenant}-db`), processes: children, createdAt: new Date().toISOString() }, null, 2));
  for (const item of tenants) {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { if ((await fetch(`http://127.0.0.1:${item.apiPort}/api/v1/health/ready`)).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!ready) throw new Error(`API QA ${item.tenant.toUpperCase()} não ficou pronta.`);
  }
  process.stdout.write(`Ambiente isolado pronto. Controle: ${statePath}\nAPI A: http://127.0.0.1:3101; API B: http://127.0.0.1:3102\n`);
} catch (error) {
  process.stderr.write(`${error.message}\nExecute stage11a-cleanup.mjs antes de repetir se algum container ou processo parcial tiver iniciado.\n`);
  process.exitCode = 1;
}
