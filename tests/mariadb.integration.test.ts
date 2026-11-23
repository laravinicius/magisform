import mysql from 'mysql2/promise';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../core/db';

const config = {
  host: process.env.MARIADB_HOST ?? '127.0.0.1',
  port: Number(process.env.MARIADB_PORT ?? 3306),
  user: process.env.MARIADB_USER ?? 'root',
  password: process.env.MARIADB_PASSWORD ?? '',
  database: process.env.MARIADB_DATABASE ?? 'magisform_contract',
};
let connection: mysql.Connection;

beforeAll(async () => {
  connection = await mysql.createConnection(config);
  await connection.query('CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL, username VARCHAR(100) NOT NULL UNIQUE, password VARCHAR(255) NOT NULL, role VARCHAR(30) NOT NULL) ENGINE=InnoDB');
  await connection.query('CREATE TABLE partner_pharmacies (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL) ENGINE=InnoDB');
  await connection.query('CREATE TABLE partner_memberships (user_id INT PRIMARY KEY, pharmacy_id INT NOT NULL, active TINYINT NOT NULL DEFAULT 1, FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(pharmacy_id) REFERENCES partner_pharmacies(id)) ENGINE=InnoDB');
  await connection.query("CREATE TABLE sessions (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL UNIQUE, token VARCHAR(64) NOT NULL UNIQUE, policy ENUM('desktop_local','hosted') NOT NULL DEFAULT 'desktop_local', last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME NULL, absolute_expires_at DATETIME NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) ENGINE=InnoDB");
  await connection.query('CREATE TABLE insumos (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB');
  await connection.query('CREATE TABLE action_logs (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NULL, user_name VARCHAR(255) NOT NULL, action VARCHAR(100) NOT NULL, entity VARCHAR(100) NOT NULL, entity_id INT NULL, details TEXT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB');
}, 15_000);

afterAll(async () => {
  if (connection) {
    await connection.query('DROP TABLE IF EXISTS action_logs');
    await connection.query('DROP TABLE IF EXISTS insumos');
    await connection.query('DROP TABLE IF EXISTS sessions');
    await connection.query('DROP TABLE IF EXISTS partner_memberships');
    await connection.query('DROP TABLE IF EXISTS partner_pharmacies');
    await connection.query('DROP TABLE IF EXISTS users');
    await connection.end();
  }
});

describe.skipIf(!process.env.MARIADB_HOST)('autenticação e autorização comuns', () => {
  const pool = mysql.createPool({ ...config, dateStrings: true });
  const db = new Db();
  db.setPool(pool);
  db.enforceAuthentication();

  afterAll(async () => { await pool.end(); });

  async function user(username: string, role = 'employee', password = 'senha-qa') {
    const legacy = crypto.createHash('sha256').update(password).digest('hex');
    const [result] = await connection.execute<mysql.ResultSetHeader>(
      'INSERT INTO users (name, username, password, role) VALUES (?, ?, ?, ?)', [username, username, legacy, role]);
    return result.insertId;
  }

  it('nega operações sem sessão', async () => {
    await expect(db.listInsumos()).rejects.toThrow('Sessão obrigatória');
    await expect(db.withSessionContext(undefined, () => db.listInsumos())).rejects.toThrow('Sessão obrigatória');
    const [rows] = await connection.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS total FROM insumos');
    expect(Number(rows[0].total)).toBe(0);
  });

  it('faz rehash SHA-256 para Argon2id no login e cria política hospedada', async () => {
    const id = await user('rehash-qa');
    const result = await db.login('rehash-qa', 'senha-qa');
    expect(result.success).toBe(true);
    const [rows] = await connection.execute<mysql.RowDataPacket[]>('SELECT password FROM users WHERE id=?', [id]);
    expect(rows[0].password).toMatch(/^\$argon2id\$/);
    const [sessions] = await connection.execute<mysql.RowDataPacket[]>('SELECT policy, expires_at, absolute_expires_at FROM sessions WHERE user_id=?', [id]);
    expect(sessions[0].policy).toBe('hosted');
    expect(sessions[0].expires_at).toBeTruthy();
    expect(sessions[0].absolute_expires_at).toBeTruthy();
  });

  it('cria política hospedada com janela ociosa e duração absoluta próprias', async () => {
    const id = await user('hosted-qa');
    const result = await db.login('hosted-qa', 'senha-qa');
    expect(result.success).toBe(true);
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT policy,
      TIMESTAMPDIFF(SECOND,NOW(),expires_at) AS idle_seconds,
      TIMESTAMPDIFF(SECOND,NOW(),absolute_expires_at) AS absolute_seconds FROM sessions WHERE user_id=?`, [id]);
    expect(rows[0].policy).toBe('hosted');
    expect(Number(rows[0].idle_seconds)).toBeGreaterThan(890);
    expect(Number(rows[0].absolute_seconds)).toBeGreaterThan(43190);
  });

  it('rejeita e limpa sessões legadas sem alterar o schema', async () => {
    const id = await user('legacy-session-qa');
    const login = await db.login('legacy-session-qa', 'senha-qa');
    expect(login.success).toBe(true);
    await connection.execute("UPDATE sessions SET policy='desktop_local' WHERE user_id=?", [id]);
    expect((await db.getSessionUser(login.sessionToken!)).user).toBeUndefined();
    expect((await db.heartbeat(login.sessionToken!)).valid).toBe(false);
    await db.cleanupStaleSessions();
    const [rows] = await connection.execute<mysql.RowDataPacket[]>('SELECT id FROM sessions WHERE user_id=?', [id]);
    expect(rows).toHaveLength(0);
    expect((await db.login('legacy-session-qa', 'senha-qa')).success).toBe(true);
  });

  it('impede rebaixar o último acesso administrativo', async () => {
    const id = await user('last-admin-qa', 'admin');
    const login = await db.login('last-admin-qa', 'senha-qa');
    const result = await db.withSessionContext(login.sessionToken, () => db.updateUser(id,
      { name: 'last-admin-qa', username: 'last-admin-qa', role: 'employee' }));
    expect(result.success).toBe(false);
    const [rows] = await connection.execute<mysql.RowDataPacket[]>('SELECT role FROM users WHERE id=?', [id]);
    expect(rows[0].role).toBe('admin');
  });

  it('preserva a reautenticação administrativa nas exclusões e audita o usuário da sessão', async () => {
    const adminId = await user('reauth-admin-qa', 'admin');
    const employeeId = await user('reauth-employee-qa');
    await db.login('reauth-admin-qa', 'senha-qa');
    const employee = await db.login('reauth-employee-qa', 'senha-qa');
    const [insumo] = await connection.execute<mysql.ResultSetHeader>('INSERT INTO insumos(name) VALUES (?)', ['Reauth QA']);
    const result = await db.withSessionContext(employee.sessionToken, () => db.deleteInsumo(insumo.insertId,
      { username: 'reauth-admin-qa', password: 'senha-qa' }));
    expect(result.success).toBe(true);
    const [logs] = await connection.execute<mysql.RowDataPacket[]>('SELECT user_id,user_name FROM action_logs WHERE entity="insumos" AND entity_id=? AND action="delete"', [insumo.insertId]);
    expect(logs[0]).toMatchObject({ user_id: employeeId, user_name: 'reauth-employee-qa' });
    await connection.execute('DELETE FROM sessions WHERE user_id=?', [adminId]);
    await connection.execute('DELETE FROM sessions WHERE user_id=?', [employeeId]);
  });

  it('serializa logins concorrentes, nega conflito e permite force auditado', async () => {
    const id = await user('race-qa');
    const results = await Promise.all([db.login('race-qa', 'senha-qa'), db.login('race-qa', 'senha-qa')]);
    expect(results.filter(result => result.success)).toHaveLength(1);
    expect(results.filter(result => result.conflict)).toHaveLength(1);
    const previous = results.find(result => result.success)!.sessionToken!;
    const forced = await db.login('race-qa', 'senha-qa', true);
    expect(forced.success).toBe(true);
    expect((await db.getSessionUser(previous)).user).toBeUndefined();
    const [logs] = await connection.execute<mysql.RowDataPacket[]>('SELECT action,details FROM action_logs WHERE user_id=? ORDER BY id', [id]);
    expect(logs.some(log => log.action === 'logout' && String(log.details).includes('forçado'))).toBe(true);
  });

  it('revoga sessão expirada e protege a administração', async () => {
    const employeeId = await user('employee-qa');
    const managerId = await user('manager-qa', 'manager');
    const employee = await db.login('employee-qa', 'senha-qa');
    const manager = await db.login('manager-qa', 'senha-qa');
    await expect(db.withSessionContext(employee.sessionToken, () => db.listUsers())).rejects.toThrow('Acesso restrito');
    expect(await db.withSessionContext(manager.sessionToken, () => db.listUsers())).toBeDefined();
    await connection.execute('UPDATE sessions SET expires_at=DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE user_id=?', [employeeId]);
    expect((await db.getSessionUser(employee.sessionToken!)).user).toBeUndefined();
    expect((await db.heartbeat(employee.sessionToken!)).valid).toBe(false);
    await db.cleanupStaleSessions();
    const [sessions] = await connection.execute<mysql.RowDataPacket[]>('SELECT id FROM sessions WHERE user_id=?', [employeeId]);
    expect(sessions).toHaveLength(0);
    await connection.execute('DELETE FROM sessions WHERE user_id=?', [managerId]);
  });

});
