import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import mysql from 'mysql2/promise';

const containerName = `magisform-contract-qa-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const docker = (args) => spawnSync('docker', args, { encoding: 'utf8', windowsHide: true });
const fail = (message) => { console.error(message); process.exitCode = 1; };

const started = docker(['run', '--detach', '--rm', '--name', containerName,
  '--env', `MARIADB_ROOT_PASSWORD=${password}`,
  '--env', 'MARIADB_DATABASE=magisform_contract',
  '--publish', '127.0.0.1::3306', 'mariadb:11.4']);

if (started.error || started.status !== 0) {
  fail(`Não foi possível iniciar MariaDB descartável: ${started.error?.message ?? started.stderr.trim()}`);
} else {
  try {
    const portResult = docker(['port', containerName, '3306/tcp']);
    const hostPort = portResult.stdout.trim().split(':').at(-1);
    if (portResult.status !== 0 || !hostPort) throw new Error('Docker não informou a porta local do MariaDB QA.');

    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const connection = await mysql.createConnection({ host: '127.0.0.1', port: Number(hostPort), user: 'root', password, database: 'magisform_contract', connectTimeout: 1500 });
        await connection.end();
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    if (!ready) throw new Error('MariaDB QA não ficou pronto em 30 segundos.');

    const result = spawnSync(process.execPath, [path.resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.ts', 'tests/mariadb.integration.test.ts', 'tests/server.integration.test.ts', 'tests/tenant-isolation.integration.test.ts', 'tests/upstream.integration.test.ts'], {
      encoding: 'utf8', windowsHide: true,
      env: { ...process.env, MARIADB_HOST: '127.0.0.1', MARIADB_PORT: hostPort, MARIADB_USER: 'root', MARIADB_PASSWORD: password, MARIADB_DATABASE: 'magisform_contract' },
    });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.error || result.status !== 0) process.exitCode = result.status || 1;
  } catch (error) {
    fail(`Falha no harness MariaDB QA: ${error.message}`);
  } finally {
    const removed = docker(['rm', '--force', containerName]);
    if (removed.error || removed.status !== 0) fail(`Falha ao remover container QA ${containerName}: ${removed.stderr.trim()}`);
  }
}
