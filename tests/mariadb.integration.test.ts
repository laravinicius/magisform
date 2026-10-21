import mysql from 'mysql2/promise';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureCustomer, fixtureFormula, fixtureUser } from './fixtures/contracts';
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
  await connection.query("CREATE TABLE sessions (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL UNIQUE, token VARCHAR(64) NOT NULL UNIQUE, policy ENUM('desktop_local','hosted') NOT NULL DEFAULT 'desktop_local', last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME NULL, absolute_expires_at DATETIME NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) ENGINE=InnoDB");
  await connection.query('CREATE TABLE customers (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL, phone VARCHAR(30) NULL, responsible_id INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT fk_customer_responsible FOREIGN KEY (responsible_id) REFERENCES customers(id)) ENGINE=InnoDB');
  await connection.query('CREATE TABLE action_logs (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NULL, user_name VARCHAR(255) NOT NULL, action VARCHAR(100) NOT NULL, entity VARCHAR(100) NOT NULL, entity_id INT NULL, details TEXT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB');
  await connection.query('CREATE TABLE formulas (id INT AUTO_INCREMENT PRIMARY KEY, customer_id INT NOT NULL, customer_phone VARCHAR(30) NOT NULL DEFAULT "", attendant_name VARCHAR(255) NOT NULL, created_by_name VARCHAR(255) NULL, budget_number VARCHAR(20) NOT NULL DEFAULT "", delivery_date DATE NULL, delivered_at DATETIME NULL, payment_status VARCHAR(30) NOT NULL DEFAULT "", partial_payment_amount DECIMAL(10,2) NULL, payment_method VARCHAR(40) NULL, delivery_status VARCHAR(40) NOT NULL DEFAULT "", cancel_reason TEXT NULL, status VARCHAR(40) NOT NULL DEFAULT "pending", manager_verified TINYINT NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT fk_formula_customer FOREIGN KEY (customer_id) REFERENCES customers(id)) ENGINE=InnoDB');
  await connection.query('CREATE TABLE budget_number_registry (budget_number VARCHAR(20) PRIMARY KEY, source_type VARCHAR(30) NOT NULL, source_id INT NOT NULL) ENGINE=InnoDB');
  await connection.query('CREATE TABLE formula_items (id INT AUTO_INCREMENT PRIMARY KEY, formula_id INT NOT NULL, insumo_id INT NOT NULL, quantity DECIMAL(10,3) NOT NULL, unit VARCHAR(40) NOT NULL, CONSTRAINT fk_fixture_formula_item_formula FOREIGN KEY (formula_id) REFERENCES formulas(id) ON DELETE CASCADE) ENGINE=InnoDB');
  await connection.query('CREATE TABLE formula_budget_items (id INT AUTO_INCREMENT PRIMARY KEY, formula_id INT NOT NULL, quantity INT NOT NULL, unit VARCHAR(40) NOT NULL, value DECIMAL(10,2) NOT NULL, is_selected TINYINT NOT NULL DEFAULT 0, CONSTRAINT fk_fixture_budget_item_formula FOREIGN KEY (formula_id) REFERENCES formulas(id) ON DELETE CASCADE) ENGINE=InnoDB');
}, 15_000);

afterAll(async () => {
  if (connection) {
    await connection.query('DROP TABLE IF EXISTS formula_budget_items');
    await connection.query('DROP TABLE IF EXISTS formula_items');
    await connection.query('DROP TABLE IF EXISTS budget_number_registry');
    await connection.query('DROP TABLE IF EXISTS formulas');
    await connection.query('DROP TABLE IF EXISTS action_logs');
    await connection.query('DROP TABLE IF EXISTS customers');
    await connection.query('DROP TABLE IF EXISTS sessions');
    await connection.query('DROP TABLE IF EXISTS users');
    await connection.end();
  }
});

describe.skipIf(!process.env.MARIADB_HOST)('harness MariaDB isolado', () => {
  it('cria dependente em transação e grava auditoria da mesma entidade', async () => {
    const db = new Db();
    const pool = mysql.createPool({ ...config, dateStrings: true });
    db.setPool(pool);
    try {
      const [parent] = await connection.execute<mysql.ResultSetHeader>('INSERT INTO customers (name, phone) VALUES (?, ?)', [fixtureCustomer.name, fixtureCustomer.phone]);
      const result = await db.addCustomer({ name: 'QA Dependente', phone: null, responsible_customer_id: parent.insertId });
      expect(result.success).toBe(true);
      const [rows] = await connection.execute<mysql.RowDataPacket[]>('SELECT name, phone, responsible_id FROM customers WHERE id = ?', [result.id]);
      expect(rows[0]).toMatchObject({ name: 'QA Dependente', phone: null, responsible_id: parent.insertId });
      const [logs] = await connection.execute<mysql.RowDataPacket[]>('SELECT action, entity, entity_id, user_name FROM action_logs');
      expect(logs[0]).toMatchObject({ action: 'add', entity: 'customers', entity_id: result.id, user_name: 'Configuração' });
    } finally {
      await pool.end();
    }
  });

  it('faz rollback da fórmula quando o orçamento já foi reservado', async () => {
    const db = new Db();
    const pool = mysql.createPool({ ...config, dateStrings: true });
    db.setPool(pool);
    try {
      const [customer] = await connection.execute<mysql.ResultSetHeader>('INSERT INTO customers (name, phone) VALUES (?, ?)', [fixtureCustomer.name, fixtureCustomer.phone]);
      const formula = { customer_id: customer.insertId, attendant_name: fixtureUser.name, items: [{ insumo_id: 70001, quantity: 1, unit: 'mg' }], budget_number: fixtureFormula.budget_number, budget_items: [{ quantity: 30, unit: 'caps', value: 12.5, is_selected: 1 }], payment_status: 'pendente', status: 'pending' };
      await connection.execute('INSERT INTO users(name,username,password,role) VALUES(?,?,?,?)', ['Criador rollback','rollback-qa',crypto.createHash('sha256').update('qa').digest('hex'),'employee']);
      const login = await db.login('rollback-qa','qa');
      const first = await db.withSessionContext(login.sessionToken, () => db.addFormula(formula));
      expect(first.success).toBe(true);
      await expect(db.withSessionContext(login.sessionToken, () => db.addFormula(formula))).rejects.toThrow('Número de orçamento já utilizado.');
      const [rows] = await connection.execute<mysql.RowDataPacket[]>('SELECT id FROM formulas');
      const [items] = await connection.execute<mysql.RowDataPacket[]>('SELECT formula_id FROM formula_items');
      expect(rows).toHaveLength(1);
      expect(items).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it('permite entrega parcial, preserva a data em repeticao e limpa ao reabrir', async () => {
    const db = new Db();
    const pool = mysql.createPool({ ...config, dateStrings: true, timezone: '-03:00' });
    db.setPool(pool);
    try {
      const [customer] = await connection.execute<mysql.ResultSetHeader>('INSERT INTO customers (name, phone) VALUES (?, ?)', [fixtureCustomer.name, fixtureCustomer.phone]);
      const [formula] = await connection.execute<mysql.ResultSetHeader>('INSERT INTO formulas (customer_id, attendant_name, payment_status) VALUES (?, ?, ?)', [customer.insertId, fixtureUser.name, 'parcial']);
      await db.updateFormulaDeliveryStatus(formula.insertId, 'entregue');
      const [initial] = await pool.execute<mysql.RowDataPacket[]>('SELECT delivered_at FROM formulas WHERE id=?', [formula.insertId]);
      await db.updateFormulaDeliveryStatus(formula.insertId, 'entregue');
      const [first] = await pool.execute<mysql.RowDataPacket[]>('SELECT delivered_at, delivery_status FROM formulas WHERE id = ?', [formula.insertId]);
      expect(first[0].delivery_status).toBe('entregue');
      expect(first[0].delivered_at).toBe(initial[0].delivered_at);
      expect(first[0].delivered_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      await db.updateFormulaDeliveryStatus(formula.insertId, 'em_reentrega');
      const [reopened] = await pool.execute<mysql.RowDataPacket[]>('SELECT delivered_at FROM formulas WHERE id = ?', [formula.insertId]);
      expect(reopened[0].delivered_at).toBeNull();
      await db.updateFormulaDeliveryStatus(formula.insertId, 'entregue');
      const [second] = await pool.execute<mysql.RowDataPacket[]>('SELECT delivered_at FROM formulas WHERE id = ?', [formula.insertId]);
      expect(second[0].delivered_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    } finally {
      await pool.end();
    }
  });
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

  it('nega leitura e mutação sem sessão sem alterar registros', async () => {
    await expect(db.listCustomers()).rejects.toThrow('Sessão obrigatória');
    await expect(db.addCustomer({ name: 'Negado', phone: null })).rejects.toThrow('Sessão obrigatória');
    const [rows] = await connection.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS total FROM customers WHERE name="Negado"');
    expect(rows[0].total).toBe(0);
    const [customer] = await connection.execute<mysql.ResultSetHeader>('INSERT INTO customers (name, phone) VALUES (?, ?)', ['Sem sessão', '557']);
    await expect(db.updateCustomer(customer.insertId, { name: 'Alterado sem sessão', phone: '558' })).rejects.toThrow('Sessão obrigatória');
    const [unchanged] = await connection.execute<mysql.RowDataPacket[]>('SELECT name,phone FROM customers WHERE id=?', [customer.insertId]);
    expect(unchanged[0]).toMatchObject({ name: 'Sem sessão', phone: '557' });
    await connection.execute('DELETE FROM customers WHERE id=?', [customer.insertId]);
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
      { name: 'last-admin-qa', username: 'last-admin-qa', role: 'employee' }, login.sessionToken));
    expect(result.success).toBe(false);
    const [rows] = await connection.execute<mysql.RowDataPacket[]>('SELECT role FROM users WHERE id=?', [id]);
    expect(rows[0].role).toBe('admin');
  });

  it('preserva a reautenticação administrativa nas exclusões e audita o usuário da sessão', async () => {
    const adminId = await user('reauth-admin-qa', 'admin');
    const employeeId = await user('reauth-employee-qa');
    await db.login('reauth-admin-qa', 'senha-qa');
    const employee = await db.login('reauth-employee-qa', 'senha-qa');
    const [customer] = await connection.execute<mysql.ResultSetHeader>('INSERT INTO customers (name, phone) VALUES (?, ?)', ['Reauth QA', '556']);
    const result = await db.withSessionContext(employee.sessionToken, () => db.deleteCustomer(customer.insertId,
      { username: 'reauth-admin-qa', password: 'senha-qa' }, employee.sessionToken));
    expect(result.success).toBe(true);
    const [logs] = await connection.execute<mysql.RowDataPacket[]>('SELECT user_id,user_name FROM action_logs WHERE entity="customers" AND entity_id=? AND action="delete"', [customer.insertId]);
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

  it('revoga sessão expirada e restringe a verificação de fórmula ao gerente', async () => {
    const employeeId = await user('employee-qa');
    const managerId = await user('manager-qa', 'manager');
    const employee = await db.login('employee-qa', 'senha-qa');
    const manager = await db.login('manager-qa', 'senha-qa');
    const [customer] = await connection.execute<mysql.ResultSetHeader>('INSERT INTO customers (name, phone) VALUES (?, ?)', ['Auth QA', '555']);
    const [formula] = await connection.execute<mysql.ResultSetHeader>('INSERT INTO formulas (customer_id, attendant_name) VALUES (?, ?)', [customer.insertId, 'QA']);
    await expect(db.withSessionContext(employee.sessionToken, () => db.verifyFormula(formula.insertId))).rejects.toThrow('Apenas o perfil Gerente');
    await db.withSessionContext(manager.sessionToken, () => db.verifyFormula(formula.insertId));
    const [verified] = await connection.execute<mysql.RowDataPacket[]>('SELECT manager_verified FROM formulas WHERE id=?', [formula.insertId]);
    expect(verified[0].manager_verified).toBe(1);
    const [audit] = await connection.execute<mysql.RowDataPacket[]>('SELECT user_id,user_name FROM action_logs WHERE entity="formulas" AND entity_id=? AND action="verify"', [formula.insertId]);
    expect(audit[0]).toMatchObject({ user_id: managerId, user_name: 'manager-qa' });
    await expect(db.withSessionContext(employee.sessionToken, () => db.unverifyFormula(formula.insertId))).rejects.toThrow('Apenas o perfil Gerente');
    await expect(db.unverifyFormula(formula.insertId)).rejects.toThrow('Apenas o perfil Gerente');
    await db.withSessionContext(manager.sessionToken, () => db.unverifyFormula(formula.insertId));
    const [unverified] = await connection.execute<mysql.RowDataPacket[]>('SELECT manager_verified FROM formulas WHERE id=?', [formula.insertId]);
    expect(unverified[0].manager_verified).toBe(0);
    const [removalAudit] = await connection.execute<mysql.RowDataPacket[]>('SELECT user_id,user_name FROM action_logs WHERE entity="formulas" AND entity_id=? AND action="unverify"', [formula.insertId]);
    expect(removalAudit).toHaveLength(1);
    expect(removalAudit[0]).toMatchObject({ user_id: managerId, user_name: 'manager-qa' });
    await db.withSessionContext(manager.sessionToken, () => db.verifyFormula(formula.insertId));
    const [reverified] = await connection.execute<mysql.RowDataPacket[]>('SELECT manager_verified FROM formulas WHERE id=?', [formula.insertId]);
    expect(reverified[0].manager_verified).toBe(1);
    await expect(db.withSessionContext(manager.sessionToken, () => db.unverifyFormula(2147483647))).rejects.toThrow('Fórmula não encontrada.');
    await connection.execute('UPDATE sessions SET expires_at=DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE user_id=?', [employeeId]);
    expect((await db.getSessionUser(employee.sessionToken!)).user).toBeUndefined();
    expect((await db.heartbeat(employee.sessionToken!)).valid).toBe(false);
    await db.cleanupStaleSessions();
    const [sessions] = await connection.execute<mysql.RowDataPacket[]>('SELECT id FROM sessions WHERE user_id=?', [employeeId]);
    expect(sessions).toHaveLength(0);
    await connection.execute('DELETE FROM formulas WHERE id=?', [formula.insertId]);
    await connection.execute('DELETE FROM customers WHERE id=?', [customer.insertId]);
    await connection.execute('DELETE FROM sessions WHERE user_id=?', [managerId]);
  });
});
