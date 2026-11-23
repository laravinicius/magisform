import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const database = process.env.MAGISFORM_DB_NAME || 'magisform';
const connectionOptions = {
  host: process.env.MAGISFORM_DB_HOST || '127.0.0.1',
  port: Number(process.env.MAGISFORM_DB_PORT || 3306),
  user: process.env.MAGISFORM_DB_USER,
  password: process.env.MAGISFORM_DB_PASSWORD,
  connectTimeout: 5000,
  charset: 'utf8mb4',
};
const usage = 'Uso: npm run db:bootstrap | npm run db:preflight | npm run db:upgrade';

function assertSafeName(value) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error('Nome de banco inválido.');
  return `\`${value}\``;
}

function checksum(value) {
  return crypto.createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex');
}

function statements(sql) {
  return sql
    .split(/\r?\n/)
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .filter((statement) => !/^CREATE\s+DATABASE\b/i.test(statement))
    .filter((statement) => !/^USE\s+/i.test(statement));
}

async function connect(withDatabase = true) {
  if (!connectionOptions.user || (connectionOptions.password === undefined && !process.env.MAGISFORM_DB_PASSWORD_FILE)) {
    throw new Error('Defina MAGISFORM_DB_USER e MAGISFORM_DB_PASSWORD para a conexão administrativa.');
  }
  const passwordFile = process.env.MAGISFORM_DB_PASSWORD_FILE;
  const password = passwordFile ? (await fs.readFile(passwordFile, 'utf8')).replace(/[\r\n]+$/, '') : connectionOptions.password;
  return mysql.createConnection({
    ...connectionOptions,
    password,
    ...(withDatabase ? { database } : {}),
    multipleStatements: false,
  });
}

async function tableNames(conn) {
  const [rows] = await conn.execute(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = ?',
    [database],
  );
  return new Set(rows.map((row) => row.TABLE_NAME ?? row.table_name));
}

async function columns(conn, table) {
  const [rows] = await conn.execute(
    'SELECT column_name, column_type, character_maximum_length FROM information_schema.columns WHERE table_schema = ? AND table_name = ?',
    [database, table],
  );
  return new Map(rows.map((row) => [row.COLUMN_NAME ?? row.column_name, row]));
}

async function assertKnownLegacy(conn, version = null) {
  const tables = await tableNames(conn);
  const requiredColumns = {
    users: ['id', 'name', 'username', 'password', 'role'],
    customers: ['id', 'name', 'phone', 'responsible_id'],
    insumos: ['id', 'name'],
    formulas: ['id', 'customer_id', 'attendant_name', 'budget_number', 'delivery_date', 'delivered_at', 'payment_status', 'partial_payment_amount', 'delivery_status', 'status', 'created_at', 'updated_at'],
    formula_items: ['id', 'formula_id', 'insumo_id', 'quantity', 'unit'],
    formula_budget_items: ['id', 'formula_id', 'quantity', 'unit', 'value', 'is_selected'],
    saved_formulas: ['id', 'name', 'budget_number', 'created_at', 'updated_at'],
    budget_number_registry: ['budget_number', 'source_type', 'source_id'],
    saved_formula_items: ['id', 'saved_formula_id', 'insumo_id', 'quantity', 'unit'],
    saved_formula_budget_items: ['id', 'saved_formula_id', 'quantity', 'unit', 'value'],
    sessions: ['id', 'user_id', 'token', 'last_seen', 'created_at'],
    action_logs: ['id', 'user_id', 'user_name', 'action', 'entity', 'entity_id', 'created_at'],
  };
  const required = Object.keys(requiredColumns);
  const missing = required.filter((name) => !tables.has(name));
  if (missing.length) throw new Error(`Preflight recusado: schema desconhecido; faltam tabelas: ${missing.join(', ')}.`);
  if (version === null && (tables.has('schema_version') || tables.has('schema_upgrade_history'))) {
    throw new Error('Preflight recusado: metadados incompletos ou inconsistentes; intervenção manual necessária.');
  }
  const columnsByTable = new Map(await Promise.all(required.map(async (table) => [table, await columns(conn, table)])));
  const mismatched = required.filter((table) => !requiredColumns[table].every((name) => columnsByTable.get(table).has(name)));
  const passwordColumn = columnsByTable.get('users').get('password');
  const passwordLength = Number(passwordColumn?.CHARACTER_MAXIMUM_LENGTH ?? passwordColumn?.character_maximum_length);
  if (mismatched.length || !(version === null ? [64] : version === 0 ? [64, 255] : [255]).includes(passwordLength)) {
    throw new Error('Preflight recusado: estrutura não corresponde ao legado suportado. Nenhuma alteração foi feita.');
  }
  const [engines] = await conn.execute(
    `SELECT table_name, engine FROM information_schema.tables WHERE table_schema = ? AND table_name IN (${required.map(() => '?').join(',')})`,
    [database, ...required],
  );
  if (engines.length !== required.length || engines.some((row) => String(row.ENGINE ?? row.engine).toLowerCase() !== 'innodb')) {
    throw new Error('Preflight recusado: tabelas do legado precisam usar InnoDB.');
  }
}

const upgrades = [
  '001-password-session-expansion.sql',
  '002-formula-pagination-order.sql',
  '003-formula-authorship-units.sql',
  '004-partner-orders.sql',
  '005-order-foundation.sql',
];
// Snapshot de bootstrap publicado antes do schema v3; normalizado em LF.
const previousBootstrapChecksum = '6438d5e84358613e4a638d40f6e8da9055248bed4779800479a92b5fde6dfbf9';
const bootstrapV3Checksum = '23be321bd34ab098e3ce350b6fb67cdd334c6d688299bd85511c0fc7c0b03dc5';
const bootstrapV4Checksum = 'c755662a82ec5d5c242a4d26a6fa01fb9af1afcb9d29b1635def138508d10888';
async function validateVersion(conn, row, allowInterrupted = false) {
  const version = Number(row.version);
  if (!Number.isInteger(version) || version < (allowInterrupted ? 0 : 1) || version > 5) throw new Error('Schema incompatível com o executor v5.');
  const schema = await fs.readFile(path.join(root, 'database.sql'), 'utf8');
  if (row.source === 'bootstrap') {
    const expected = version === 5 ? checksum(schema) : version === 4 ? bootstrapV4Checksum : version === 3 ? bootstrapV3Checksum : previousBootstrapChecksum;
    if (row.checksum !== expected) throw new Error('Checksum de bootstrap divergente.');
  } else if (row.source === 'upgrade') {
    const sql = await fs.readFile(path.join(root, 'database/upgrades', upgrades[Math.max(1,version)-1]), 'utf8');
    if (row.checksum !== checksum(sql)) throw new Error('Checksum de upgrade divergente.');
    if (version > 0) {
      const [history] = await conn.execute('SELECT checksum FROM schema_upgrade_history WHERE version=?', [version]);
      if (history.length !== 1 || history[0].checksum !== row.checksum) throw new Error('Histórico de upgrade incompleto ou divergente.');
    }
  } else throw new Error('Origem de schema desconhecida.');
  const existingTables = await tableNames(conn);
  let transitioning = false;
  if (existingTables.has('schema_upgrade_progress')) {
    const progressColumns = await columns(conn, 'schema_upgrade_progress');
    if (!['version', 'checksum', 'started_at'].every(name => progressColumns.has(name))) throw new Error('Metadados de upgrade incompatíveis.');
    const [progress] = await conn.query('SELECT version,checksum FROM schema_upgrade_progress');
    if (progress.length) {
      const expected = checksum(await fs.readFile(path.join(root, 'database/upgrades/005-order-foundation.sql'), 'utf8'));
      if (progress.length !== 1 || version !== 4 || Number(progress[0].version) !== 5 || progress[0].checksum !== expected) throw new Error('Upgrade interrompido desconhecido.');
      transitioning = true;
    }
  }
  if (version < 5 && !transitioning) await assertKnownLegacy(conn, version);
  if (version === 5 || transitioning) {
    const base = { users: ['id','name','username','password','role'], insumos: ['id','name'], sessions: ['id','user_id','token','policy','expires_at','absolute_expires_at'], action_logs: ['id','user_id','user_name','action','entity','entity_id','created_at'] };
    for (const [table, names] of Object.entries(base)) {
      if (!existingTables.has(table)) throw new Error('Estrutura de base incompatível.');
      const actual = await columns(conn, table);
      if (!names.every(name => actual.has(name))) throw new Error('Estrutura de base incompatível.');
    }
    const baseTables = Object.keys(base);
    const [baseEngines] = await conn.execute(`SELECT engine FROM information_schema.tables WHERE table_schema=? AND table_name IN (${baseTables.map(() => '?').join(',')})`, [database, ...baseTables]);
    if (baseEngines.length !== baseTables.length || baseEngines.some(row => String(row.ENGINE ?? row.engine).toLowerCase() !== 'innodb')) throw new Error('Tabelas de base precisam usar InnoDB.');
    if (version === 5 && (!existingTables.has('schema_upgrade_progress') || ['customers','formulas','formula_items','formula_budget_items','saved_formulas','saved_formula_items','saved_formula_budget_items','budget_number_registry'].some(name => existingTables.has(name)))) throw new Error('Estrutura anterior ainda presente.');
  }
  if (version > 0) {
    const sessionColumns = await columns(conn, 'sessions');
    if (!['policy','expires_at','absolute_expires_at'].every(name => sessionColumns.has(name))) throw new Error('Estrutura de sessões incompatível.');
  }
  if (version >= 2 && version < 5 && !transitioning) {
    const [indexes] = await conn.query("SHOW INDEX FROM formulas WHERE Key_name='idx_formulas_created_id'");
    if (indexes.length !== 2 || indexes[0].Column_name !== 'created_at' || indexes[1].Column_name !== 'id') throw new Error('Índice de paginação incompatível.');
  }
  for (const table of (version < 5 && !transitioning ? ['formulas','saved_formulas'] : [])) {
    const column = (await columns(conn,table)).get('created_by_name');
    if ((version >= 3 && !column) || (column && String(column.COLUMN_TYPE ?? column.column_type).toLowerCase() !== 'varchar(255)')) throw new Error('Estrutura de autoria incompatível.');
  }
  for (const table of (version < 5 && !transitioning ? ['formula_budget_items','saved_formula_budget_items'] : [])) {
    const column = (await columns(conn,table)).get('unit');
    const type = String(column?.COLUMN_TYPE ?? column?.column_type).toLowerCase();
    if (!(version >= 3 ? ['varchar(16)'] : ['varchar(5)','varchar(16)']).includes(type)) throw new Error('Estrutura de unidades incompatível.');
  }
  {
    const required = {
      partner_pharmacies: ['id', 'name', 'created_at'],
      partner_memberships: ['user_id', 'pharmacy_id', 'active'],
      partner_patients: ['id', 'pharmacy_id', 'name', 'phone'],
      orders: ['id', 'pharmacy_id', ...(version < 5 && !transitioning ? ['legacy_formula_id'] : []), 'status', 'original_data', 'current_data', 'proposed_data', 'revision', 'created_at', 'updated_at'],
      order_events: ['id', 'order_id', 'user_id', 'actor_name', 'action', 'snapshot', 'note', 'created_at'],
    };
    const existing = await tableNames(conn);
    const present = Object.keys(required).filter(table => existing.has(table));
    if (version >= 4 && present.length !== Object.keys(required).length) throw new Error('Estrutura de pedidos incompatível.');
    for (const [table, names] of Object.entries(required)) {
      if (!existing.has(table)) continue;
      const actual = await columns(conn, table);
      if (!names.every(name => actual.has(name))) throw new Error('Estrutura de pedidos incompatível.');
      if (version === 5 && table === 'orders' && actual.has('legacy_formula_id')) throw new Error('Vínculo anterior ainda presente.');
    }
    if (present.length) {
      const [engines] = await conn.execute(`SELECT engine FROM information_schema.tables WHERE table_schema=? AND table_name IN (${present.map(() => '?').join(',')})`, [database, ...present]);
      if (engines.length !== present.length || engines.some(row => String(row.ENGINE ?? row.engine).toLowerCase() !== 'innodb')) throw new Error('Tabelas de pedidos precisam usar InnoDB.');
      const foreignKeys = {
        partner_memberships: [['user_id', 'users'], ['pharmacy_id', 'partner_pharmacies']],
        partner_patients: [['pharmacy_id', 'partner_pharmacies']],
        orders: [['pharmacy_id', 'partner_pharmacies'], ...(version < 5 && !transitioning ? [['legacy_formula_id', 'formulas']] : [])],
        order_events: [['order_id', 'orders'], ['user_id', 'users']],
      };
      for (const [table, expected] of Object.entries(foreignKeys)) {
        if (!existing.has(table)) continue;
        const [keys] = await conn.execute('SELECT column_name,referenced_table_name FROM information_schema.key_column_usage WHERE table_schema=? AND table_name=? AND referenced_table_name IS NOT NULL', [database, table]);
        if (!expected.every(([column, target]) => keys.some(key => (key.COLUMN_NAME ?? key.column_name) === column && (key.REFERENCED_TABLE_NAME ?? key.referenced_table_name) === target))) throw new Error('Vínculos de pedidos incompatíveis.');
      }
      for (const [table, index, columnsExpected] of [['partner_memberships', 'PRIMARY', ['user_id']], ['partner_patients', 'uq_partner_patient', ['pharmacy_id', 'name', 'phone']], ...(version < 5 && !transitioning ? [['orders', 'uq_order_legacy_formula', ['legacy_formula_id']]] : [])]) {
        if (!existing.has(table)) continue;
        const [keys] = await conn.execute('SELECT column_name,non_unique FROM information_schema.statistics WHERE table_schema=? AND table_name=? AND index_name=? ORDER BY seq_in_index', [database, table, index]);
        if (keys.length !== columnsExpected.length || keys.some((key, i) => Number(key.NON_UNIQUE ?? key.non_unique) !== 0 || (key.COLUMN_NAME ?? key.column_name) !== columnsExpected[i])) throw new Error('Índices de pedidos incompatíveis.');
      }
    }
  }
  return transitioning;
}

async function createMetadata(conn, version, source, digest) {
  await conn.query(`CREATE TABLE IF NOT EXISTS schema_version (
    singleton TINYINT NOT NULL PRIMARY KEY,
    version INT NOT NULL,
    source ENUM('bootstrap','upgrade') NOT NULL,
    checksum CHAR(64) NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT chk_schema_version_singleton CHECK (singleton = 1)
  ) ENGINE=InnoDB`);
  await conn.query(`CREATE TABLE IF NOT EXISTS schema_upgrade_history (
    version INT NOT NULL PRIMARY KEY,
    checksum CHAR(64) NOT NULL,
    completed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);
  await conn.execute(
    'INSERT INTO schema_version (singleton, version, source, checksum) VALUES (1, ?, ?, ?) ON DUPLICATE KEY UPDATE version=VALUES(version), source=VALUES(source), checksum=VALUES(checksum)',
    [version, source, digest],
  );
}

async function lock(conn) {
  const lockName = `magisform-schema-${checksum(database).slice(0, 32)}`;
  const timeout = Math.max(1, Math.min(60, Number(process.env.MAGISFORM_DB_LOCK_TIMEOUT_SECONDS || 30)));
  const [rows] = await conn.execute('SELECT GET_LOCK(?, ?) AS acquired', [lockName, timeout]);
  if (Number(rows[0].acquired) !== 1) throw new Error(`Não foi possível obter o lock exclusivo do schema em ${timeout} segundo(s).`);
  return lockName;
}

async function unlock(conn, lockName) {
  if (lockName) await conn.execute('SELECT RELEASE_LOCK(?)', [lockName]);
}

async function runBootstrap() {
  const conn = await connect(false);
  let lockName;
  try {
    lockName = await lock(conn);
    const [rows] = await conn.execute('SELECT table_name FROM information_schema.tables WHERE table_schema = ?', [database]);
    if (rows.length) throw new Error(`Bootstrap recusado: o banco ${database} já contém tabelas. Use o comando explícito de upgrade após preflight.`);
    await conn.query(`CREATE DATABASE IF NOT EXISTS ${assertSafeName(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.changeUser({ database });
    const schema = await fs.readFile(path.join(root, 'database.sql'), 'utf8');
    for (const statement of statements(schema)) await conn.query(statement);
    await createMetadata(conn, 5, 'bootstrap', checksum(schema));
    console.log(`Bootstrap concluído: ${database}, schema v5. Nenhuma conta administrativa foi criada.`);
  } finally {
    try { await unlock(conn, lockName); } finally { await conn.end(); }
  }
}

async function runPreflight() {
  const conn = await connect();
  try {
    const tables = await tableNames(conn);
    if (!tables.size) {
      console.log(`Preflight: banco ${database} vazio; elegível para bootstrap explícito.`);
      return;
    }
    if (!tables.has('schema_version')) {
      await assertKnownLegacy(conn);
      console.log(`Preflight: legado suportado detectado em ${database}; upgrade explícito para v1 disponível.`);
      return;
    }
    const [rows] = await conn.execute('SELECT version, source, checksum FROM schema_version WHERE singleton = 1');
    if (rows.length !== 1) throw new Error('Preflight recusado: registro de versão ausente ou duplicado.');
    const transitioning = await validateVersion(conn, rows[0]);
    console.log(transitioning ? 'Preflight: upgrade v5 interrompido; retomada explícita disponível.' : `Preflight: schema v${rows[0].version} válido (${rows[0].source}).`);
  } finally {
    await conn.end();
  }
}

async function runUpgrade() {
  const conn = await connect();
  let lockName;
  try {
    lockName = await lock(conn);
    const tables = await tableNames(conn);
    if (!tables.size) throw new Error('Upgrade recusado: banco vazio; use bootstrap explícito.');
    const migration = await fs.readFile(path.join(root, 'database/upgrades/001-password-session-expansion.sql'), 'utf8');
    const migrationChecksum = checksum(migration);
    if (!tables.has('schema_version')) {
      await assertKnownLegacy(conn);
      await createMetadata(conn, 0, 'upgrade', migrationChecksum);
    }
    const [versions] = await conn.execute('SELECT version, source, checksum FROM schema_version WHERE singleton = 1');
    if (versions.length !== 1) throw new Error('Upgrade recusado: metadados de versão inconsistentes.');
    await validateVersion(conn, versions[0], true);
    let current = Number(versions[0].version);
    if (current === 5) {
      console.log(`Upgrade ignorado: ${database} já está no schema v5 com checksum válido.`);
      return;
    }
    for (let version = current + 1; version <= 5; version++) {
      const sql = await fs.readFile(path.join(root, 'database/upgrades', upgrades[version-1]), 'utf8');
      const digest = checksum(sql);
      if (version === 5) {
        await conn.query('CREATE TABLE IF NOT EXISTS schema_upgrade_progress (version INT NOT NULL PRIMARY KEY, checksum CHAR(64) NOT NULL, started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB');
        await conn.execute('INSERT INTO schema_upgrade_progress(version,checksum) VALUES(?,?) ON DUPLICATE KEY UPDATE version=version', [version, digest]);
        const [progress] = await conn.execute('SELECT checksum FROM schema_upgrade_progress WHERE version=?', [version]);
        if (progress.length !== 1 || progress[0].checksum !== digest) throw new Error('Checksum de upgrade interrompido divergente.');
      }
      console.log(`Upgrade v${version} iniciado em ${database}; mantenha a aplicação em manutenção.`);
      for (const statement of statements(sql)) await conn.query(statement);
      // DDL e recuperacao sao idempotentes; metadados de conclusao usam transacao.
      await conn.beginTransaction();
      try {
        await conn.execute('INSERT INTO schema_upgrade_history (version, checksum) VALUES (?, ?) ON DUPLICATE KEY UPDATE checksum=VALUES(checksum), completed_at=CURRENT_TIMESTAMP', [version, digest]);
        await conn.execute("UPDATE schema_version SET version=?, source='upgrade', checksum=? WHERE singleton=1 AND version=?", [version, digest, version-1]);
        if (version === 5) await conn.execute('DELETE FROM schema_upgrade_progress WHERE version=?', [version]);
        await conn.commit();
      } catch (error) { await conn.rollback(); throw error; }
    }
    const [finalRows] = await conn.execute('SELECT version,source,checksum FROM schema_version WHERE singleton=1');
    await validateVersion(conn, finalRows[0]);
    console.log(`Upgrade concluído: ${database} agora está no schema v5.`);
  } finally {
    try { await unlock(conn, lockName); } finally { await conn.end(); }
  }
}

async function main() {
  assertSafeName(database);
  const command = process.argv[2];
  if (!['bootstrap', 'preflight', 'upgrade'].includes(command)) throw new Error(usage);
  if (command === 'bootstrap') return runBootstrap();
  if (command === 'preflight') return runPreflight();
  return runUpgrade();
}

main().catch((error) => {
  console.error(`Falha no schema: ${error.message}`);
  process.exitCode = 1;
});
