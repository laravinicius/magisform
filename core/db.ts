import crypto from 'crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { AsyncLocalStorage } from 'node:async_hooks';
import mysql from 'mysql2/promise';
import type { FormulaListQueryDto, FormulaListPageDto, FormulaSummaryDto, FormulaDto, FormulaPaymentUpdate, SummaryPaymentStatus } from '../shared/contracts.js';
import { BusinessRuleError, formatDbError, isUnsupportedAuthPluginError } from './dbError.js';
import { getDeliveryTimestamp } from './deliveryTime.js';

interface AdminVerifyResult {
  success: boolean;
  user?: { id: number; name: string; username: string; role: string };
  error?: string;
}

interface SessionUserResult {
  user?: { id: number; name: string; username: string; role: string };
  error?: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const passwordHash = (s: string) => argonHash(s, {
  algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1,
});
const legacyHash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const sessionTokenDigest = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const contexts = new AsyncLocalStorage<{
  kind: 'system' | 'session';
  user?: { id: number; name: string; username: string; role: string };
  connection?: mysql.PoolConnection;
}>();

// Avaliar antes de atribuir delivery_status preserva a data apenas da mesma entrega.
const deliveredAtUpdate = `delivered_at=CASE WHEN ?='entregue'
  THEN CASE WHEN delivery_status='entregue' THEN delivered_at ELSE ? END
  ELSE NULL END`;

interface SqlMetrics {
  queryCount: number;
  totalDurationMs: number;
  recordsReturned: number;
  lastQuery: string | null;
  lastDurationMs: number;
  lastError: string | null;
}

const sqlMetrics: SqlMetrics = {
  queryCount: 0,
  totalDurationMs: 0,
  recordsReturned: 0,
  lastQuery: null,
  lastDurationMs: 0,
  lastError: null,
};

export function getSqlMetrics(): SqlMetrics {
  return { ...sqlMetrics };
}

export function resetSqlMetrics(): void {
  sqlMetrics.queryCount = 0;
  sqlMetrics.totalDurationMs = 0;
  sqlMetrics.recordsReturned = 0;
  sqlMetrics.lastQuery = null;
  sqlMetrics.lastDurationMs = 0;
  sqlMetrics.lastError = null;
}

const logQuery = async <T>(sql: string, params: any[], fn: () => Promise<T>): Promise<T> => {
  const start = performance.now();
  sqlMetrics.queryCount++;
  sqlMetrics.lastQuery = sql;
  try {
    const result = await fn();
    const duration = performance.now() - start;
    sqlMetrics.totalDurationMs += duration;
    sqlMetrics.lastDurationMs = duration;
    sqlMetrics.lastError = null;
    if (Array.isArray(result)) {
      sqlMetrics.recordsReturned += result.length;
    }
    return result;
  } catch (e: any) {
    sqlMetrics.lastError = e.message ?? 'Erro desconhecido';
    throw e;
  }
};

// Erros de conectividade (servidor fora do ar) ≠ erros de dados
const isConnectionError = (e: any): boolean => {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|PROTOCOL_CONNECTION_LOST|EHOSTUNREACH|EAI_AGAIN/.test(msg);
};

// Converte erros do driver em mensagens amigáveis em PT-BR
const friendlyError = (e: any): string => {
  if (isConnectionError(e)) {
    return 'Servidor indisponível. Verifique a conexão com o banco de dados e tente novamente.';
  }
  if (isUnsupportedAuthPluginError(e)) return formatDbError(e);
  if (e instanceof Error && e.message) return e.message;
  return 'Erro ao acessar o banco de dados.';
};

const isDuplicateBudgetNumber = (e: any): boolean =>
  e?.code === 'ER_DUP_ENTRY' && (
    /budget_number_registry|uq_budget_number_source/.test(String(e?.message ?? '')) ||
    /for key 'PRIMARY'/.test(String(e?.message ?? ''))
  );

// O app é online-first: todo dado é lido/gravado direto no MariaDB,
// sem cache local nem sincronização offline.

export class Db {
  private pool: mysql.Pool | null = null;
  private authenticationEnforced = false;

  enforceAuthentication() { this.authenticationEnforced = true; }

  async withSessionContext<T>(token: string | undefined, callback: () => Promise<T>): Promise<T> {
    if (!token) throw new Error('Sessão obrigatória.');
    return contexts.run({ kind: 'system' }, async () => {
      const result = await this.getSessionUser(token);
      if (!result.user) throw new Error(result.error ?? 'Sessão inválida ou expirada.');
      if (!this.pool) throw new Error('Sem conexão com o servidor.');
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        const value = await contexts.run({ kind: 'session', user: result.user, connection }, callback);
        if (value && typeof value === 'object' && 'success' in value && (value as any).success === false) await connection.rollback();
        else await connection.commit();
        return value;
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    });
  }

  private withSystemContext<T>(callback: () => Promise<T>): Promise<T> {
    const current = contexts.getStore();
    return contexts.run({ ...current, kind: 'system' }, callback);
  }

  private assertOperationContext(): void {
    if (!this.authenticationEnforced) return;
    const context = contexts.getStore();
    if (!context) throw new Error('Sessão obrigatória.');
  }

  setPool(pool: mysql.Pool | null) {
    this.pool = pool;
  }

  private async q<T = any>(sql: string, params?: any[]): Promise<T> {
    this.assertOperationContext();
    if (!this.pool) throw new Error('Sem conexão com o servidor');
    return logQuery(sql, params ?? [], async () => {
      const connection = contexts.getStore()?.connection;
      const [rows] = connection
        ? await connection.query(sql, params)
        : await this.pool!.query(sql, params);
      return rows as T;
    });
  }

  private async operationConnection(): Promise<{ connection: mysql.PoolConnection; owned: boolean }> {
    const current = contexts.getStore()?.connection;
    if (current) return { connection: current, owned: false };
    if (!this.pool) throw new Error('Sem conexão com o servidor');
    return { connection: await this.pool.getConnection(), owned: true };
  }

  // ── Sessões (login único) ──────────────────────────────────────────────────────

  // Sessão considerada morta se o último heartbeat passar deste limite
  static HOSTED_SESSION_TTL_SECONDS = 28_800;
  static HOSTED_ABSOLUTE_TTL_SECONDS = 86_400;

  static configureHostedSession(idleSeconds: number, absoluteSeconds: number): void {
    if (!Number.isInteger(idleSeconds) || idleSeconds < 3600 || idleSeconds > 28_800 || !Number.isInteger(absoluteSeconds) || absoluteSeconds < idleSeconds || absoluteSeconds > 86_400) {
      throw new Error('Política de sessão hospedada inválida.');
    }
    Db.HOSTED_SESSION_TTL_SECONDS = idleSeconds;
    Db.HOSTED_ABSOLUTE_TTL_SECONDS = absoluteSeconds;
  }

  async revokeSession(token: string): Promise<void> {
    if (!this.pool) return;
    await this.withSystemContext(async () => {
      const conn = await this.pool!.getConnection();
      try {
        await conn.beginTransaction();
        const digest = sessionTokenDigest(token);
        const [rows]: any = await conn.query('SELECT u.id, u.name FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token=? FOR UPDATE', [digest]);
        await conn.query('DELETE FROM sessions WHERE token=?', [digest]);
        if (rows.length) await conn.query('INSERT INTO action_logs (user_id,user_name,action,entity,entity_id,details) VALUES (?,?,?,?,?,?)',
          [rows[0].id, rows[0].name, 'logout', 'system', rows[0].id, 'Sessão encerrada (logout).']);
        await conn.commit();
      } catch (error) { await conn.rollback(); throw error; }
      finally { conn.release(); }
    });
  }

  // Renova last_seen e informa se a sessão ainda existe (foi derrubada por outro login)
  async heartbeat(token: string): Promise<{ valid: boolean }> {
    try {
      const r: any = await this.withSystemContext(() => this.q(
        `UPDATE sessions SET last_seen=NOW(), expires_at=LEAST(absolute_expires_at,
         DATE_ADD(NOW(), INTERVAL ? SECOND))
         WHERE token=? AND policy='hosted' AND expires_at>NOW() AND absolute_expires_at>NOW()`,
        [Db.HOSTED_SESSION_TTL_SECONDS, sessionTokenDigest(token)]));
      return { valid: (r?.affectedRows ?? 0) > 0 };
    } catch (e) {
      return { valid: false };
    }
  }

  async cleanupStaleSessions(): Promise<void> {
    await this.withSystemContext(() => this.q(`DELETE FROM sessions
      WHERE expires_at<=NOW() OR absolute_expires_at<=NOW()
        OR policy<>'hosted'
        OR (policy='hosted' AND last_seen<NOW()-INTERVAL ? SECOND)`,
      [Db.HOSTED_SESSION_TTL_SECONDS]));
  }

  // ── Logs de auditoria ────────────────────────────────────────────────────────

  // Resolve o ator da operação a partir da sessão validada.
  private async resolveActor(token?: string): Promise<{ id: number | null; name: string }> {
    const context = contexts.getStore();
    if (context?.kind === 'session' && context.user) return { id: context.user.id, name: context.user.name };
    if (!token || !this.pool) return { id: null, name: 'Configuração' };
    try {
      const rows = await this.q<any[]>(
        'SELECT u.id, u.name FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ?',
        [sessionTokenDigest(token)]
      );
      if (rows.length === 0) return { id: null, name: 'Configuração' };
      return { id: rows[0].id, name: rows[0].name };
    } catch {
      return { id: null, name: 'Configuração' };
    }
  }

  // Em contexto transacional, grava auditoria com ator derivado da sessão validada.
  async logAction(
    actor: { id: number | null; name: string } | string | undefined,
    action: string,
    entity: string,
    entityId?: number | null,
    details?: string
  ): Promise<void> {
    try {
      const operationContext = contexts.getStore();
      if (!operationContext && this.authenticationEnforced) throw new Error('Contexto autenticado obrigatório para auditoria.');
      let userId: number | null = null;
      let userName = '';
      const context = operationContext;
      if (context?.kind === 'session' && context.user) {
        userId = context.user.id;
        userName = context.user.name;

      } else if (typeof actor === 'string') {
        userName = actor;
      } else if (actor) {
        userId = actor.id ?? null;
        userName = actor.name;
      }
      await this.withSystemContext(() => this.q(
        'INSERT INTO action_logs (user_id, user_name, action, entity, entity_id, details) VALUES (?,?,?,?,?,?)',
        [userId, userName, action, entity, entityId ?? null, details ?? '']
      ));
    } catch { throw new Error('Não foi possível registrar a auditoria; operação cancelada.'); }
  }

  async listLogs(filters: {
    userId?: number; action?: string; entity?: string;
    from?: string; to?: string; search?: string;
    page?: number; pageSize?: number;
  } = {}): Promise<{ rows: any[]; total: number }> {
    await this.assertPrivilegedSession();
    const where: string[] = [];
    const params: any[] = [];
    if (filters.userId) { where.push('user_id = ?'); params.push(filters.userId); }
    if (filters.action) { where.push('action = ?'); params.push(filters.action); }
    if (filters.entity) { where.push('entity = ?'); params.push(filters.entity); }
    if (filters.from) { where.push('DATE(created_at) >= ?'); params.push(filters.from); }
    if (filters.to) { where.push('DATE(created_at) <= ?'); params.push(filters.to); }
    if (filters.search && filters.search.trim() !== '') {
      where.push("CONCAT(COALESCE(user_name,''), ' ', COALESCE(details,'')) LIKE ?");
      params.push(`%${filters.search.trim()}%`);
    }
    const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 50));
    const offset = (page - 1) * pageSize;
    const countRows: any = await this.q('SELECT COUNT(*) AS c FROM action_logs ' + whereSql, params);
    const total = Number(countRows[0]?.c ?? 0);
    const rows = await this.q(
      'SELECT * FROM action_logs ' + whereSql + ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
      [...params, pageSize, offset]
    );
    return { rows, total };
  }

  // ── Admin Verification ──────────────────────────────────────────────────────────

  async verifyAdmin(username: string, password: string): Promise<AdminVerifyResult> {
    try {
      const rows = await this.withSystemContext(() => this.q<any[]>(
        "SELECT id, name, username, role, password FROM users WHERE username = ? AND role IN ('admin', 'manager', 'pharmacist')",
        [username]
      ));
      if (rows.length === 0 || !(await this.verifyStoredPassword(password, rows[0].password))) {
        return { success: false, error: 'Credenciais de administrador inválidas' };
      }
      if (!rows[0].password.startsWith('$argon2id$')) {
        const upgraded = await passwordHash(password);
        await this.withSystemContext(() => this.q('UPDATE users SET password=? WHERE id=? AND password=?',
          [upgraded, rows[0].id, rows[0].password]));
      }
      delete rows[0].password;
      return { success: true, user: rows[0] };
    } catch (e) {
      return { success: false, error: friendlyError(e) };
    }
  }

  async getSessionUser(token: string): Promise<SessionUserResult> {
    if (!this.pool) return { error: 'Sem conexão com o servidor' };
    try {
      const rows = await this.withSystemContext(() => this.q<any[]>(
        `SELECT u.id, u.name, u.username, u.role
         FROM sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.token = ? AND s.expires_at>NOW() AND s.absolute_expires_at>NOW()
           AND s.policy='hosted' AND s.last_seen >= NOW() - INTERVAL ? SECOND`,
        [sessionTokenDigest(token), Db.HOSTED_SESSION_TTL_SECONDS]
      ));
      if (rows.length === 0) {
        return { error: 'Sessão inválida ou expirada' };
      }
      return { user: rows[0] };
    } catch (e) {
      return { error: friendlyError(e) };
    }
  }

  // ── Auth ──────────────────────────────────────────────────────────────────────

  async login(username: string, password: string, force = false): Promise<{
    success: boolean; user?: any; sessionToken?: string; conflict?: boolean; error?: string;
  }> {
    return this.withSystemContext(async () => {
    if (!this.pool) return { success: false, error: 'Sem conexão com o servidor' };
    let conn;
    try {
      conn = await this.pool.getConnection();
      await conn.beginTransaction();
      const [rows]: any = await conn.query('SELECT id,name,username,role,password FROM users WHERE username=? FOR UPDATE', [username]);
      if (!rows.length || !(await this.verifyStoredPassword(password, rows[0].password))) {
        await conn.rollback(); conn.release(); conn = null;
        return { success: false, error: 'Usuário ou senha inválidos.' };
      }
      const storedPassword = rows[0].password;
      if (!['admin', 'manager', 'pharmacist', 'employee'].includes(rows[0].role)) {
        await conn.rollback(); conn.release(); conn = null;
        return { success: false, error: 'Acesso negado. Este sistema é exclusivo para funcionários.' };
      }
      const user = { id: rows[0].id, name: rows[0].name, username: rows[0].username, role: rows[0].role };
      await conn.query(`DELETE FROM sessions WHERE user_id=? AND (expires_at<=NOW() OR absolute_expires_at<=NOW()
        OR policy<>'hosted'
        OR (policy='hosted' AND last_seen<NOW()-INTERVAL ? SECOND))`,
        [user.id, Db.HOSTED_SESSION_TTL_SECONDS]);
      const [active]: any = await conn.query(
        'SELECT id FROM sessions WHERE user_id = ? FOR UPDATE', [user.id]);
      if (active.length > 0 && !force) {
        await conn.rollback();
        conn.release();
        conn = null;
        return { success: false, conflict: true };
      }
      if (active.length > 0) {
        if (active.length) await conn.query('INSERT INTO action_logs (user_id,user_name,action,entity,entity_id,details) VALUES (?,?,?,?,?,?)',
          [user.id, user.name, 'logout', 'system', user.id, 'Sessão anterior encerrada por login forçado.']);
        await conn.query('DELETE FROM sessions WHERE user_id = ?', [user.id]);
      }
      const policy = 'hosted';
      const idle = Db.HOSTED_SESSION_TTL_SECONDS;
      const absolute = Db.HOSTED_ABSOLUTE_TTL_SECONDS;
      const token = crypto.randomBytes(32).toString('hex');
      await conn.query(`UPDATE users SET password=? WHERE id=? AND password=?`, [
        storedPassword.startsWith('$argon2id$') ? storedPassword : await passwordHash(password), user.id, storedPassword,
      ]);
      await conn.query(`INSERT INTO sessions (user_id,token,policy,expires_at,absolute_expires_at)
        VALUES (?,?,?,DATE_ADD(NOW(),INTERVAL ? SECOND),DATE_ADD(NOW(),INTERVAL ? SECOND))`,
        [user.id, sessionTokenDigest(token), policy, idle, absolute]);
      await conn.query('INSERT INTO action_logs (user_id,user_name,action,entity,entity_id,details) VALUES (?,?,?,?,?,?)',
        [user.id, user.name, 'login', 'system', user.id, `Login de ${user.name} (${user.username}).`]);
      await conn.commit();
      conn.release();
      conn = null;
      return { success: true, user, sessionToken: token };
    } catch (e) {
      if (conn) { await conn.rollback(); conn.release(); }
      return { success: false, error: friendlyError(e) };
    }
    });
  }


  async assertPrivilegedSession(): Promise<{ id: number; name: string; username: string; role: string }> {
    const context = contexts.getStore();
    if (context?.kind !== 'session' || !context.user || !['admin', 'manager', 'pharmacist'].includes(context.user.role)) {
      throw new Error('Acesso restrito à administração.');
    }
    return context.user;
  }

  private async verifyStoredPassword(password: string, encoded: string): Promise<boolean> {
    try {
      if (encoded.startsWith('$argon2id$')) return await argonVerify(encoded, password);
      const candidate = Buffer.from(legacyHash(password), 'hex');
      const expected = Buffer.from(encoded, 'hex');
      return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
    } catch { return false; }
  }

  // ── Usuários ──────────────────────────────────────────────────────────────────

  listUsers() {
    return this.assertPrivilegedSession().then(() => this.q('SELECT id, name, username, role FROM users ORDER BY name'));
  }

  async addUser(user: { name: string; username: string; password: string; role: string }, sessionToken?: string) {
    this.assertOperationContext();
    try {
      const access = await this.checkAdminAccess(undefined, sessionToken);
      if (!access.success) return { success: false, error: access.error };
      if (!['admin', 'manager', 'pharmacist', 'employee'].includes(user.role)) {
        return { success: false, error: 'Perfil inválido.' };
      }
      if (!this.pool) throw new Error('Sem conexão com o servidor');
      const actor = await this.resolveActor(sessionToken);
      const encodedPassword = await passwordHash(user.password);
      const conn = await this.pool.getConnection();
      try {
        await conn.beginTransaction();
        const [r]: any = await conn.query('INSERT INTO users (name,username,password,role) VALUES (?,?,?,?)',
          [user.name, user.username, encodedPassword, user.role]);
        await conn.query('INSERT INTO action_logs (user_id,user_name,action,entity,entity_id,details) VALUES (?,?,?,?,?,?)',
          [actor.id, actor.name, 'add', 'users', r.insertId, `Usuário criado: ${user.name} (${user.username}).`]);
        await conn.commit();
        return { success: true, id: r.insertId };
      } catch (error) { await conn.rollback(); throw error; }
      finally { conn.release(); }
    } catch (e) {
      return { success: false, error: friendlyError(e) };
    }
  }

  async updateUser(id: number, user: { name: string; username: string; password?: string; role: string }, sessionToken?: string) {
    this.assertOperationContext();
    try {
      const access = await this.checkAdminAccess(undefined, sessionToken);
      if (!access.success) return { success: false, error: access.error };
      const actor = { id: access.user!.id, name: access.user!.name };
      if (!['admin', 'manager', 'pharmacist', 'employee'].includes(user.role)) {
        return { success: false, error: 'Perfil inválido.' };
      }
      const { connection: conn, owned } = await this.operationConnection();
      try {
        if (owned) await conn.beginTransaction();
        const [admins]: any = await conn.query("SELECT id FROM users WHERE role IN ('admin','manager','pharmacist') FOR UPDATE");
        const [target]: any = await conn.query('SELECT role FROM users WHERE id=? FOR UPDATE', [id]);
        if (!target.length) { if (owned) await conn.rollback(); return { success: false, error: 'Usuário não encontrado.' }; }
        const remainsAdmin = ['admin','manager','pharmacist'].includes(user.role);
        if (['admin','manager','pharmacist'].includes(target[0].role) && !remainsAdmin && admins.length <= 1) {
          if (owned) await conn.rollback();
          return { success: false, error: 'Não é possível remover o último acesso administrativo.' };
        }
        if (user.password?.trim()) {
          await conn.query('UPDATE users SET name=?,username=?,password=?,role=? WHERE id=?',
            [user.name, user.username, await passwordHash(user.password), user.role, id]);
        } else {
          await conn.query('UPDATE users SET name=?,username=?,role=? WHERE id=?', [user.name, user.username, user.role, id]);
        }
        await conn.query('INSERT INTO action_logs (user_id,user_name,action,entity,entity_id,details) VALUES (?,?,?,?,?,?)',
          [actor.id, actor.name, 'update', 'users', id, `Usuário atualizado: ${user.name} (${user.username}).`]);
        if (owned) await conn.commit();
      } catch (error) { if (owned) await conn.rollback(); throw error; }
      finally { if (owned) conn.release(); }
      return { success: true };
    } catch (e) {
      return { success: false, error: friendlyError(e) };
    }
  }

  async deleteUser(id: number, adminCreds?: { username: string; password: string }, sessionToken?: string) {
    try {
      const adminCheck = await this.checkAdminAccess(adminCreds, sessionToken);
      if (!adminCheck.success) return { success: false, error: adminCheck.error };
      const { connection: conn, owned } = await this.operationConnection();
      try {
        if (owned) await conn.beginTransaction();
        const [admins]: any = await conn.query("SELECT id FROM users WHERE role IN ('admin','manager','pharmacist') FOR UPDATE");
        const [target]: any = await conn.query('SELECT id,name,username,role FROM users WHERE id=? FOR UPDATE', [id]);
        if (!target.length) { if (owned) await conn.rollback(); return { success: false, error: 'Usuário não encontrado.' }; }
        if (target[0].id === adminCheck.user!.id) { if (owned) await conn.rollback(); return { success: false, error: 'Você não pode excluir seu próprio usuário.' }; }
        if (['admin','manager','pharmacist'].includes(target[0].role) && admins.length <= 1) {
          if (owned) await conn.rollback();
          return { success: false, error: 'Não é possível remover o último acesso administrativo.' };
        }
        await conn.query('DELETE FROM users WHERE id=?', [id]);
        await conn.query('INSERT INTO action_logs (user_id,user_name,action,entity,entity_id,details) VALUES (?,?,?,?,?,?)',
          [adminCheck.user!.id, adminCheck.user!.name, 'delete', 'users', id, `Usuário excluído: ${target[0].name}.`]);
        if (owned) await conn.commit();
        return { success: true };
      } catch (error) { if (owned) await conn.rollback(); throw error; }
      finally { if (owned) conn.release(); }
    } catch (e) {
      return { success: false, error: friendlyError(e) };
    }
  }

  private async checkAdminAccess(adminCreds?: { username: string; password: string }, sessionToken?: string) {
    const context = contexts.getStore();
    const actor = context?.kind === 'session' ? context.user : undefined;
    if (!actor) return { success: false, error: 'Sessão obrigatória.' };
    if (adminCreds?.username && adminCreds?.password) {
      const reauth = await this.verifyAdmin(adminCreds.username, adminCreds.password);
      if (!reauth.success) return reauth;
      return { success: true, user: actor };
    }
    if (!['admin', 'manager', 'pharmacist'].includes(actor.role)) return { success: false, error: 'Credenciais de administrador inválidas' };
    return { success: true, user: actor };
  }

  // ── Clientes ──────────────────────────────────────────────────────────────────

  listCustomers() {
    return this.q(`SELECT c.id, c.name, c.phone, c.responsible_id, r.name AS responsible_name,
                          r.phone AS responsible_phone, c.created_at
                   FROM customers c LEFT JOIN customers r ON r.id = c.responsible_id
                   ORDER BY c.name`);
  }

  async addCustomer(c: { name: string; phone: string | null; responsible_customer_id?: number | null }, sessionToken?: string) {
    this.assertOperationContext();
    if (c.responsible_customer_id) {
      if (c.phone || !c.name.trim()) return { success: false, error: 'Dependente deve ter nome e não pode ter celular próprio.' };
      const { connection: conn, owned } = await this.operationConnection();
      try {
        if (owned) await conn.beginTransaction();
        const [selected]: any = await conn.query(
          'SELECT id, responsible_id, phone FROM customers WHERE id=? FOR UPDATE', [c.responsible_customer_id]
        );
        if (!selected.length || selected[0].responsible_id || !selected[0].phone) {
          if (owned) await conn.rollback();
          return { success: false, error: 'Selecione um responsável cadastrado com celular.' };
        }
        const [r]: any = await conn.query(
          'INSERT INTO customers (name, phone, responsible_id) VALUES (?,NULL,?)', [c.name, c.responsible_customer_id]
        );
        if (owned) await conn.commit();
        const actor = await this.resolveActor(sessionToken);
        await this.logAction(actor, 'add', 'customers', r.insertId, `Dependente cadastrado: ${c.name} (responsável id ${c.responsible_customer_id}).`);
        return { success: true, id: r.insertId };
      } catch (e) {
        if (owned) await conn.rollback();
        return { success: false, error: friendlyError(e) };
      } finally { if (owned) conn.release(); }
    }
    try {
      const r: any = await this.q('INSERT INTO customers (name, phone) VALUES (?,?)', [c.name, c.phone]);
      const actor = await this.resolveActor(sessionToken);
      await this.logAction(actor, 'add', 'customers', r.insertId, `Cliente adicionado: ${c.name} (tel: ${c.phone}).`);
      return { success: true, id: r.insertId };
    } catch (e) {
      return { success: false, error: 'Celular já cadastrado no servidor.' };
    }
  }

  async updateCustomer(id: number, c: { name: string; phone: string }, sessionToken?: string) {
    this.assertOperationContext();
    const { connection: conn, owned } = await this.operationConnection();
    try {
      if (owned) await conn.beginTransaction();
      const [current]: any = await conn.query('SELECT responsible_id FROM customers WHERE id=? FOR UPDATE', [id]);
      if (current[0]?.responsible_id) {
        await conn.query('UPDATE customers SET name=?, phone=NULL WHERE id=?', [c.name, id]);
      } else {
        await conn.query('UPDATE customers SET name=?, phone=? WHERE id=?', [c.name, c.phone, id]);
        await conn.query(`UPDATE formulas SET customer_phone=? WHERE customer_id=? OR customer_id IN
                          (SELECT id FROM customers WHERE responsible_id=?)`, [c.phone, id, id]);
      }
      if (owned) await conn.commit();
      const actor = await this.resolveActor(sessionToken);
      await this.logAction(actor, 'update', 'customers', id, `Cliente atualizado: ${c.name} (tel: ${c.phone}).`);
      return { success: true };
    } catch (e) {
      if (owned) await conn.rollback();
      return { success: false, error: 'Celular já cadastrado no servidor.' };
    } finally {
      if (owned) conn.release();
    }
  }

  private async reserveBudgetNumber(
    conn: mysql.PoolConnection,
    budgetNumber: string | null | undefined,
    sourceType: 'formula' | 'saved_formula',
    sourceId: number
  ): Promise<void> {
    const number = budgetNumber?.trim() ?? '';
    if (!number) return;
    try {
      await conn.query(
        'INSERT INTO budget_number_registry (budget_number, source_type, source_id) VALUES (?,?,?)',
        [number, sourceType, sourceId]
      );
    } catch (e) {
      if (isDuplicateBudgetNumber(e)) throw new Error('Número de orçamento já utilizado.');
      throw e;
    }
  }

  async deleteCustomer(id: number, adminCreds?: { username: string; password: string }, sessionToken?: string) {
    try {
      const adminCheck = await this.checkAdminAccess(adminCreds, sessionToken);
      if (!adminCheck.success) return { success: false, error: adminCheck.error };

      const dependents = await this.q<any[]>('SELECT id FROM customers WHERE responsible_id=? LIMIT 1', [id]);
      if (dependents.length) return { success: false, error: 'Não é possível excluir um responsável com clientes vinculados.' };
      const target = await this.q<any[]>('SELECT name, phone FROM customers WHERE id = ?', [id]);
      await this.q('DELETE FROM customers WHERE id = ?', [id]);
      const actor = adminCheck.user
        ? { id: adminCheck.user.id, name: adminCheck.user.name }
        : (adminCreds?.username ?? 'Configuração');
      await this.logAction(actor, 'delete', 'customers', id, `Cliente excluído: ${target[0]?.name ?? id} (tel: ${target[0]?.phone ?? ''}).`);
      return { success: true };
    } catch (e) {
      return { success: false, error: friendlyError(e) };
    }
  }

  // ── Insumos ─────────────────────────────────────────────────────────────────

  listInsumos() {
    return this.q('SELECT id, name, created_at FROM insumos ORDER BY name');
  }

  async addInsumo(name: string, sessionToken?: string) {
    try {
      const r: any = await this.q('INSERT INTO insumos (name) VALUES (?)', [name]);
      const actor = await this.resolveActor(sessionToken);
      await this.logAction(actor, 'add', 'insumos', r.insertId, `Insumo adicionado: ${name}.`);
      return { success: true, id: r.insertId };
    } catch (e) {
      return { success: false, error: friendlyError(e) };
    }
  }

  async updateInsumo(id: number, name: string, sessionToken?: string) {
    try {
      await this.q('UPDATE insumos SET name=? WHERE id=?', [name, id]);
      const actor = await this.resolveActor(sessionToken);
      await this.logAction(actor, 'update', 'insumos', id, `Insumo atualizado: ${name}.`);
      return { success: true };
    } catch (e) {
      return { success: false, error: friendlyError(e) };
    }
  }

  async deleteInsumo(id: number, adminCreds?: { username: string; password: string }, sessionToken?: string) {
    try {
      const adminCheck = await this.checkAdminAccess(adminCreds, sessionToken);
      if (!adminCheck.success) return { success: false, error: adminCheck.error };

      const inUse = await this.q<any[]>('SELECT 1 FROM formula_items WHERE insumo_id=? LIMIT 1', [id]);
      const inSaved = await this.q<any[]>('SELECT 1 FROM saved_formula_items WHERE insumo_id=? LIMIT 1', [id]);
      if (inUse.length > 0 || inSaved.length > 0) {
        return { success: false, error: 'Insumo em uso por fórmulas cadastradas. Não é possível excluir.' };
      }
      const target = await this.q<any[]>('SELECT name FROM insumos WHERE id = ?', [id]);
      await this.q('DELETE FROM insumos WHERE id=?', [id]);
      const actor = adminCheck.user
        ? { id: adminCheck.user.id, name: adminCheck.user.name }
        : (adminCreds?.username ?? 'Configuração');
      await this.logAction(actor, 'delete', 'insumos', id, `Insumo excluído: ${target[0]?.name ?? id}.`);
      return { success: true };
    } catch (e) {
      return { success: false, error: friendlyError(e) };
    }
  }

  // ── Fórmulas ──────────────────────────────────────────────────────────────────

  async listFormulas(query: FormulaListQueryDto): Promise<FormulaListPageDto> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new Error('Informe um limite explícito de 1 a 100 fórmulas por página.');
    const limit = query.limit;
    const search = (query.search ?? '').trim().slice(0, 100);
    const statuses = [...new Set(query.statuses ?? [])];
    const conditions: string[] = [];
    const params: unknown[] = [];
    let fence: { createdAt: string; id: number } | null = null;
    let before: { createdAt: string; id: number } | null = null;
    if (query.cursor) {
      try {
        if (query.cursor.length > 512) throw new Error();
        const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
        if (decoded?.v !== 1 || typeof decoded?.f?.d !== 'string' || !Number.isInteger(decoded?.f?.i) || decoded.f.i < 1 || typeof decoded?.b?.d !== 'string' || !Number.isInteger(decoded?.b?.i) || decoded.b.i < 1) throw new Error();
        fence = { createdAt: decoded.f.d, id: decoded.f.i };
        before = { createdAt: decoded.b.d, id: decoded.b.i };
      } catch { throw Object.assign(new Error('Cursor de fórmulas inválido. Reinicie a navegação.'), { statusCode: 400 }); }
      conditions.push('(f.created_at < ? OR (f.created_at = ? AND f.id <= ?))');
      params.push(fence.createdAt, fence.createdAt, fence.id);
      conditions.push('(f.created_at < ? OR (f.created_at = ? AND f.id < ?))');
      params.push(before.createdAt, before.createdAt, before.id);
    }
    if (statuses.length) {
      conditions.push(`f.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    if (query.deliveryStatus) { conditions.push('f.delivery_status = ?'); params.push(query.deliveryStatus); }
    if (search) {
      const like = `%${search}%`;
      conditions.push(`(CAST(f.id AS CHAR) LIKE ? OR c.name LIKE ? OR COALESCE(f.customer_phone,'') LIKE ? OR CONCAT_WS(' ',f.attendant_name,f.created_by_name) LIKE ? OR COALESCE(f.budget_number,'') LIKE ? OR COALESCE(CAST(f.delivery_date AS CHAR),'') LIKE ? OR DATE_FORMAT(f.created_at,'%d/%m/%Y') LIKE ? OR DATE_FORMAT(f.delivered_at,'%d/%m/%Y') LIKE ? OR f.status LIKE ? OR CASE f.status WHEN 'cancelled' THEN 'Cancelada' WHEN 'delivered' THEN 'Entregue' ELSE f.status END LIKE ? OR COALESCE(f.payment_status,'') LIKE ? OR CASE f.payment_status WHEN 'pago' THEN 'Pago' WHEN 'parcial' THEN 'Parcial' WHEN 'pagar_na_retirada' THEN 'Pagar na retirada' ELSE COALESCE(f.payment_status,'') END LIKE ? OR CASE WHEN f.manager_verified=1 THEN 'Verificado' ELSE 'Não verificado' END LIKE ? OR COALESCE(f.cancel_reason,'') LIKE ? OR EXISTS (SELECT 1 FROM formula_items fi JOIN insumos m ON m.id=fi.insumo_id WHERE fi.formula_id=f.id AND (m.name LIKE ? OR CAST(fi.quantity AS CHAR) LIKE ? OR fi.unit LIKE ?)) OR EXISTS (SELECT 1 FROM formula_budget_items bi WHERE bi.formula_id=f.id AND (bi.unit LIKE ? OR CAST(bi.quantity AS CHAR) LIKE ? OR CAST(bi.value AS CHAR) LIKE ? OR REPLACE(CAST(bi.value AS CHAR),'.',',') LIKE ?) AND bi.is_selected=1))`);
      params.push(...Array(21).fill(like));
    }
    if (!fence) {
      const [latest] = await this.q<any[]>(`SELECT CAST(created_at AS CHAR) AS created_at, id FROM formulas ORDER BY created_at DESC, id DESC LIMIT 1`);
      if (!latest) return { rows: [], nextCursor: null, total: 0, limit };
      fence = { createdAt: latest.created_at, id: latest.id };
      conditions.unshift('(f.created_at < ? OR (f.created_at = ? AND f.id <= ?))');
      params.unshift(fence.createdAt, fence.createdAt, fence.id);
    }
    const finalWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countConditions = query.cursor ? conditions.filter((_, index) => index !== 1) : conditions;
    const countParams = query.cursor ? [...params.slice(0, 3), ...params.slice(6)] : params;
    const countWhere = countConditions.length ? `WHERE ${countConditions.join(' AND ')}` : '';
    const totalRows = await this.q<any[]>(`SELECT COUNT(*) AS total FROM formulas f JOIN customers c ON c.id=f.customer_id ${countWhere}`, countParams);
    const formulas = await this.q<any[]>(`
      SELECT f.id, f.customer_id, c.name AS customer_name,
             r.name AS responsible_name,
             COALESCE(f.customer_phone,'') AS customer_phone,
             COALESCE(f.attendant_name,'') AS attendant_name, f.created_by_name,
             COALESCE(f.budget_number,'') AS budget_number,
             f.delivery_date, f.delivered_at, COALESCE(f.payment_status,'') AS payment_status,
             f.partial_payment_amount,
             f.payment_method, COALESCE(f.delivery_status,'') AS delivery_status,
             f.manager_verified,
             f.cancel_reason, f.status, f.created_at, CAST(f.created_at AS CHAR) AS cursor_created_at
      FROM formulas f JOIN customers c ON f.customer_id = c.id
      LEFT JOIN customers r ON r.id = c.responsible_id
      ${finalWhere}
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT ?
    `, [...params, limit + 1]);

    const hasMore = formulas.length > limit;
    if (hasMore) formulas.pop();
    if (formulas.length === 0) return { rows: [], nextCursor: null, total: Number(totalRows[0]?.total ?? 0), limit };

    const formulaIds = formulas.map(f => f.id);
    const placeholders = formulaIds.map(() => '?').join(',');

    const items = await this.q<any[]>(
      `SELECT fi.formula_id, fi.insumo_id, m.name AS insumo_name, fi.quantity, fi.unit
       FROM formula_items fi JOIN insumos m ON fi.insumo_id = m.id
       WHERE fi.formula_id IN (${placeholders})`,
      formulaIds
    );

    const budgetItems = await this.q<any[]>(
      `SELECT formula_id, quantity, unit, value, is_selected
       FROM formula_budget_items
       WHERE formula_id IN (${placeholders})`,
      formulaIds
    );

    const itemsByFormula: Record<number, any[]> = {};
    for (const item of items) {
      (itemsByFormula[item.formula_id] ??= []).push(item);
    }

    const budgetByFormula: Record<number, any[]> = {};
    for (const bi of budgetItems) {
      (budgetByFormula[bi.formula_id] ??= []).push(bi);
    }

    for (const f of formulas) {
      f.items = itemsByFormula[f.id] ?? [];
      f.budget_items = budgetByFormula[f.id] ?? [];
    }

    const last = formulas[formulas.length - 1];
    const nextCursor = hasMore ? Buffer.from(JSON.stringify({ v: 1, f: { d: fence.createdAt, i: Number(fence.id) }, b: { d: last.cursor_created_at, i: Number(last.id) } })).toString('base64url') : null;
    return { rows: formulas, nextCursor, total: Number(totalRows[0]?.total ?? 0), limit };
  }

  async getFormula(id: number): Promise<FormulaDto | null> {
    const direct = await this.q<any[]>(`SELECT f.id FROM formulas f WHERE f.id=?`, [id]);
    if (!direct.length) return null;
    const result = await this.loadFormulaRows([id]);
    return result[0] ?? null;
  }

  async getFormulaSummary(month: number, year: number, paymentStatus: SummaryPaymentStatus = 'pago'): Promise<FormulaSummaryDto> {
    const [counts] = await this.q<any[]>(`SELECT COUNT(*) AS total, SUM(status='pending') AS pending, SUM(status='confirmed') AS confirmed FROM formulas`);
    if (!Number.isInteger(month) || month < 0 || month > 11 || !Number.isInteger(year) || year < 1900 || year > 9999 || !['pago', 'parcial', 'pagar_na_retirada', 'nao_pago'].includes(paymentStatus)) throw new Error('Filtro de resumo inválido.');
    const [monthly] = await this.q<any[]>(`SELECT COALESCE(SUM(CASE WHEN ?='parcial' THEN COALESCE(f.partial_payment_amount,0)
      ELSE (SELECT COALESCE(SUM(bi.value),0) FROM formula_budget_items bi WHERE bi.formula_id=f.id AND bi.is_selected=1) END),0) AS total
      FROM formulas f WHERE (f.payment_status=? OR (?='nao_pago' AND COALESCE(f.payment_status,'')=''))
      AND f.delivery_status='entregue' AND YEAR(f.delivered_at)=? AND MONTH(f.delivered_at)=?`, [paymentStatus, paymentStatus, paymentStatus, year, month + 1]);
    const years = await this.q<any[]>(`SELECT DISTINCT YEAR(delivered_at) AS year FROM formulas WHERE delivered_at IS NOT NULL ORDER BY year DESC`);
    return { total: Number(counts?.total ?? 0), pending: Number(counts?.pending ?? 0), confirmed: Number(counts?.confirmed ?? 0), deliveredMonthlyTotal: Number(monthly?.total ?? 0), deliveredYears: years.map((row: any) => Number(row.year)).filter((value: number) => value > 1900) };
  }

  private async loadFormulaRows(ids: number[]) {
    const placeholders = ids.map(() => '?').join(',');
    const formulas = await this.q<any[]>(`SELECT f.id, f.customer_id, c.name AS customer_name, r.name AS responsible_name, COALESCE(f.customer_phone,'') AS customer_phone, COALESCE(f.attendant_name,'') AS attendant_name, f.created_by_name, COALESCE(f.budget_number,'') AS budget_number, f.delivery_date, f.delivered_at, COALESCE(f.payment_status,'') AS payment_status, f.partial_payment_amount, f.payment_method, COALESCE(f.delivery_status,'') AS delivery_status, f.manager_verified, f.cancel_reason, f.status, f.created_at FROM formulas f JOIN customers c ON f.customer_id=c.id LEFT JOIN customers r ON r.id=c.responsible_id WHERE f.id IN (${placeholders})`, ids);
    const [items, budgetItems] = await Promise.all([
      this.q<any[]>(`SELECT fi.formula_id, fi.insumo_id, m.name AS insumo_name, fi.quantity, fi.unit FROM formula_items fi JOIN insumos m ON m.id=fi.insumo_id WHERE fi.formula_id IN (${placeholders})`, ids),
      this.q<any[]>(`SELECT formula_id, quantity, unit, value, is_selected FROM formula_budget_items WHERE formula_id IN (${placeholders})`, ids),
    ]);
    for (const formula of formulas) {
      formula.items = items.filter((item: any) => item.formula_id === formula.id);
      formula.budget_items = budgetItems.filter((item: any) => item.formula_id === formula.id);
    }
    return formulas;
  }

  async addFormula(formula: {
    customer_id: number;
    attendant_name: string;
    items: Array<{ insumo_id: number; quantity: number; unit?: string }>;
    budget_number?: string;
    budget_items?: Array<{ quantity: number; unit: string; value: number; is_selected?: number | boolean }>;
    delivery_date?: string | null;
    payment_status?: string;
    partial_payment_amount?: number | null;
    payment_method?: string | null;
    delivery_status?: string;
    cancel_reason?: string | null;
    status?: string;
  }, sessionToken?: string) {
    this.assertOperationContext();
    const creator = contexts.getStore()?.user;
    if (contexts.getStore()?.kind !== 'session' || !creator) throw new Error('Sessão obrigatória para criar a fórmula.');
    if (!this.pool) throw new Error('Sem conexão com o servidor');
    const deliveryStatus = formula.status === 'confirmed' ? 'em_producao' : (formula.delivery_status ?? '');
    const { connection: conn, owned } = await this.operationConnection();
    try {
      if (owned) await conn.beginTransaction();
      const customer = await this.q<any[]>(`SELECT COALESCE(c.phone, r.phone, '') AS phone
        FROM customers c LEFT JOIN customers r ON r.id=c.responsible_id WHERE c.id=?`, [formula.customer_id]);
      const customerPhone = customer[0]?.phone ?? '';
const [r]: any = await conn.query(
        `INSERT INTO formulas (customer_id, customer_phone, attendant_name, created_by_name, budget_number, delivery_date, delivered_at, payment_status, partial_payment_amount, payment_method, delivery_status, cancel_reason, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [formula.customer_id, customerPhone, formula.attendant_name, creator.name, formula.budget_number ?? '',
         formula.delivery_date ?? null, deliveryStatus === 'entregue' ? getDeliveryTimestamp() : null, formula.payment_status ?? '',
         formula.payment_status === 'parcial' ? formula.partial_payment_amount ?? null : null,
         formula.payment_method ?? null, deliveryStatus,
         formula.cancel_reason ?? null,
         formula.status ?? 'pending']
      );
      await this.reserveBudgetNumber(conn, formula.budget_number, 'formula', r.insertId);
      for (const item of formula.items) {
        await conn.query('INSERT INTO formula_items (formula_id, insumo_id, quantity, unit) VALUES (?,?,?,?)',
          [r.insertId, item.insumo_id, item.quantity, item.unit ?? 'mg']);
      }
      for (const bi of formula.budget_items ?? []) {
        await conn.query('INSERT INTO formula_budget_items (formula_id, quantity, unit, value, is_selected) VALUES (?,?,?,?,?)',
          [r.insertId, bi.quantity, bi.unit ?? 'caps', bi.value ?? 0, bi.is_selected ? 1 : 0]);
      }
      if (owned) await conn.commit();
      const actor = await this.resolveActor(sessionToken);
      await this.logAction(actor, 'add', 'formulas', r.insertId, `Fórmula criada (id ${r.insertId}).`);
      return { success: true, id: r.insertId };
    } catch (e) {
      if (owned) await conn.rollback();
      throw e;
    } finally {
      if (owned) conn.release();
    }
  }

  async updateFormula(id: number, formula: {
    customer_id: number;
    attendant_name: string;
    items: Array<{ insumo_id: number; quantity: number; unit?: string }>;
    budget_number?: string;
    budget_items?: Array<{ quantity: number; unit: string; value: number; is_selected?: number | boolean }>;
    delivery_date?: string | null;
    payment_status?: string;
    partial_payment_amount?: number | null;
    payment_method?: string | null;
    delivery_status?: string;
    cancel_reason?: string | null;
    status?: string;
  }, sessionToken?: string) {
    this.assertOperationContext();
    if (!this.pool) throw new Error('Sem conexão com o servidor');
    const current = await this.q<Array<{ delivery_status: string; payment_status: string; partial_payment_amount: number | string | null }>>(
      'SELECT delivery_status, payment_status, partial_payment_amount FROM formulas WHERE id=?', [id]
    );
    const deliveryStatus = formula.status === 'confirmed'
      ? (formula.delivery_status || 'em_producao')
      : (formula.delivery_status || current[0]?.delivery_status || '');
    const paymentStatus = formula.payment_status ?? current[0]?.payment_status ?? '';
    const partialPaymentAmount = paymentStatus === 'parcial'
      ? formula.partial_payment_amount ?? current[0]?.partial_payment_amount ?? null
      : null;
    const { connection: conn, owned } = await this.operationConnection();
    try {
      if (owned) await conn.beginTransaction();
      const customer = await this.q<any[]>(`SELECT COALESCE(c.phone, r.phone, '') AS phone
        FROM customers c LEFT JOIN customers r ON r.id=c.responsible_id WHERE c.id=?`, [formula.customer_id]);
      const customerPhone = customer[0]?.phone ?? '';
      await conn.query(
        `UPDATE formulas SET customer_id=?, customer_phone=?, attendant_name=?, budget_number=?, delivery_date=?, payment_status=?, partial_payment_amount=?, payment_method=?, ${deliveredAtUpdate}, delivery_status=?, cancel_reason=?, status=? WHERE id=?`,
        [formula.customer_id, customerPhone, formula.attendant_name, formula.budget_number ?? '',
         formula.delivery_date ?? null, paymentStatus,
         partialPaymentAmount,
         formula.payment_method ?? null, deliveryStatus, getDeliveryTimestamp(), deliveryStatus, formula.cancel_reason ?? null,
         formula.status ?? 'pending', id]
      );
      await conn.query('DELETE FROM budget_number_registry WHERE source_type=? AND source_id=?', ['formula', id]);
      await this.reserveBudgetNumber(conn, formula.budget_number, 'formula', id);
      await conn.query('DELETE FROM formula_items WHERE formula_id=?', [id]);
      for (const item of formula.items) {
        await conn.query('INSERT INTO formula_items (formula_id, insumo_id, quantity, unit) VALUES (?,?,?,?)',
          [id, item.insumo_id, item.quantity, item.unit ?? 'mg']);
      }
      await conn.query('DELETE FROM formula_budget_items WHERE formula_id=?', [id]);
      for (const bi of formula.budget_items ?? []) {
        await conn.query('INSERT INTO formula_budget_items (formula_id, quantity, unit, value, is_selected) VALUES (?,?,?,?,?)',
          [id, bi.quantity, bi.unit ?? 'caps', bi.value ?? 0, bi.is_selected ? 1 : 0]);
      }
      if (owned) await conn.commit();
      const actor = await this.resolveActor(sessionToken);
      await this.logAction(actor, 'update', 'formulas', id, `Fórmula atualizada (id ${id}).`);
      return { success: true };
    } catch (e) {
      if (owned) await conn.rollback();
      throw e;
    } finally {
      if (owned) conn.release();
    }
  }

  async updateFormulaStatus(id: number, status: string, sessionToken?: string) {
    if (status === 'confirmed') {
      await this.q('UPDATE formulas SET status=?, delivery_status=?, delivered_at=NULL WHERE id=?', [status, 'em_producao', id]);
    } else {
      await this.q('UPDATE formulas SET status=? WHERE id=?', [status, id]);
    }
    const actor = await this.resolveActor(sessionToken);
    await this.logAction(actor, 'update_status', 'formulas', id, `Status da fórmula ${id} alterado para ${status}.`);
    return { success: true };
  }

  async updateFormulaDeliveryStatus(id: number, deliveryStatus: string, sessionToken?: string) {
    await this.q(
      `UPDATE formulas SET ${deliveredAtUpdate}, delivery_status=?, status=CASE WHEN ?='entregue' THEN 'delivered' WHEN status='delivered' THEN 'confirmed' ELSE status END WHERE id=?`,
      [deliveryStatus, getDeliveryTimestamp(), deliveryStatus, deliveryStatus, id]
    );
    const actor = await this.resolveActor(sessionToken);
    await this.logAction(actor, 'update_delivery_status', 'formulas', id, `Andamento da fórmula ${id} alterado para ${deliveryStatus}.`);
    return { success: true };
  }

  async updateFormulaPayment(id: number, payment: FormulaPaymentUpdate, sessionToken?: string) {
    if (!this.pool) throw new Error('Sem conexão com o servidor');
    const actor = contexts.getStore()?.user;
    if (contexts.getStore()?.kind !== 'session' || !actor) throw new Error('Sessão obrigatória para editar o pagamento.');
    if (!payment || !['pago', 'parcial', 'pagar_na_retirada'].includes(payment.payment_status)) {
      throw new BusinessRuleError('Status de pagamento inválido.');
    }
    const { connection: conn, owned } = await this.operationConnection();
    try {
      if (owned) await conn.beginTransaction();
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        'SELECT status, delivery_status, payment_status, partial_payment_amount FROM formulas WHERE id=? FOR UPDATE', [id]
      );
      const formula = rows[0];
      if (!formula) throw new BusinessRuleError('Fórmula não encontrada.', 404);
      if (formula.status !== 'delivered' || formula.delivery_status !== 'entregue') {
        throw new BusinessRuleError('Somente fórmulas entregues podem ter o pagamento editado no histórico.', 409);
      }
      if (formula.payment_status === 'pago') {
        throw new BusinessRuleError('O pagamento desta fórmula já está como Pago e não pode ser alterado.', 409);
      }
      let partialAmount: number | null = null;
      if (payment.payment_status === 'parcial') {
        const [budgets] = await conn.query<mysql.RowDataPacket[]>(
          'SELECT value FROM formula_budget_items WHERE formula_id=? AND is_selected=1 FOR UPDATE', [id]
        );
        if (budgets.length !== 1) throw new BusinessRuleError('Selecione uma única opção de orçamento para validar o limite.');
        const amount = payment.partial_payment_amount;
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
          throw new BusinessRuleError('Informe uma quantia maior que zero.');
        }
        partialAmount = Math.round(amount * 100) / 100;
        if (Math.abs(amount - partialAmount) > 1e-8 || partialAmount <= 0) {
          throw new BusinessRuleError('Informe uma quantia válida com até duas casas decimais.');
        }
        if (partialAmount > Number(budgets[0].value)) {
          throw new BusinessRuleError('A quantia paga não pode ser maior que o valor do orçamento selecionado.');
        }
      }
      await conn.query('UPDATE formulas SET payment_status=?, partial_payment_amount=? WHERE id=?',
        [payment.payment_status, partialAmount, id]);
      if (owned) await conn.commit();
      await this.logAction({ id: actor.id, name: actor.name }, 'update', 'formulas', id,
        `Pagamento da fórmula ${id} alterado de ${formula.payment_status} para ${payment.payment_status}. Quantia parcial: ${formula.partial_payment_amount ?? 'não informada'} → ${partialAmount ?? 'não se aplica'}.`);
      return { success: true };
    } catch (e) {
      if (owned) await conn.rollback();
      throw e;
    } finally {
      if (owned) conn.release();
    }
  }

  async verifyFormula(id: number, sessionToken?: string) {
    const actor = contexts.getStore()?.user;
    if (contexts.getStore()?.kind !== 'session' || actor?.role !== 'manager') throw new Error('Apenas o perfil Gerente pode verificar fórmulas.');
    const result: any = await this.q('UPDATE formulas SET manager_verified=1 WHERE id=?', [id]);
    if (!result?.affectedRows) {
      const existing = await this.q<any[]>('SELECT id FROM formulas WHERE id=?', [id]);
      if (!existing.length) throw new Error('Fórmula não encontrada.');
    }
    await this.logAction({ id: actor.id, name: actor.name }, 'verify', 'formulas', id, `Fórmula ${id} marcada como verificada no Histórico.`);
    return { success: true };
  }

  async unverifyFormula(id: number) {
    const actor = contexts.getStore()?.user;
    if (contexts.getStore()?.kind !== 'session' || actor?.role !== 'manager') throw new Error('Apenas o perfil Gerente pode desverificar fórmulas.');
    const result: any = await this.q('UPDATE formulas SET manager_verified=0 WHERE id=?', [id]);
    if (!result?.affectedRows) {
      const existing = await this.q<any[]>('SELECT id FROM formulas WHERE id=?', [id]);
      if (!existing.length) throw new Error('Fórmula não encontrada.');
    }
    await this.logAction({ id: actor.id, name: actor.name }, 'unverify', 'formulas', id, `Verificação da fórmula ${id} removida no Histórico.`);
    return { success: true };
  }

  async updateFormulasDeliveryStatus(ids: number[], deliveryStatus: string, sessionToken?: string) {
    if (!ids.length) return { success: true };
    const actor = await this.resolveActor(sessionToken);
    const deliveredAt = getDeliveryTimestamp();
    for (const id of ids) {
      await this.q(`UPDATE formulas SET ${deliveredAtUpdate}, delivery_status=?, status=CASE WHEN ?='entregue' THEN 'delivered' WHEN status='delivered' THEN 'confirmed' ELSE status END WHERE id=?`, [deliveryStatus, deliveredAt, deliveryStatus, deliveryStatus, id]);
      await this.logAction(actor, 'update_delivery_status', 'formulas', id, `Andamento da fórmula ${id} alterado para ${deliveryStatus}.`);
    }
    return { success: true };
  }

  async deleteFormula(id: number, adminCreds?: { username: string; password: string }, sessionToken?: string) {
    try {
      const adminCheck = await this.checkAdminAccess(adminCreds, sessionToken);
      if (!adminCheck.success) return { success: false, error: adminCheck.error };

      await this.q('DELETE FROM budget_number_registry WHERE source_type=? AND source_id=?', ['formula', id]);
      await this.q('DELETE FROM formulas WHERE id=?', [id]);
      const actor = adminCheck.user
        ? { id: adminCheck.user.id, name: adminCheck.user.name }
        : (adminCreds?.username ?? 'Configuração');
      await this.logAction(actor, 'delete', 'formulas', id, `Fórmula excluída (id ${id}).`);
      return { success: true };
    } catch (e) {
      return { success: false, error: friendlyError(e) };
    }
  }

  // ── Fórmulas Salvas ──────────────────────────────────────────────────────────

  async listSavedFormulas() {
    await this.assertPrivilegedSession();
    const formulas = await this.q<any[]>(
      'SELECT id, name, created_by_name, budget_number, created_at FROM saved_formulas ORDER BY name'
    );

    if (formulas.length === 0) return formulas;

    const formulaIds = formulas.map(f => f.id);
    const placeholders = formulaIds.map(() => '?').join(',');

    const items = await this.q<any[]>(
      `SELECT sfi.saved_formula_id, sfi.insumo_id, m.name AS insumo_name, sfi.quantity, sfi.unit
       FROM saved_formula_items sfi JOIN insumos m ON sfi.insumo_id = m.id
       WHERE sfi.saved_formula_id IN (${placeholders})`,
      formulaIds
    );

    const budgetItems = await this.q<any[]>(
      `SELECT id, saved_formula_id, quantity, unit, value
       FROM saved_formula_budget_items
       WHERE saved_formula_id IN (${placeholders})`,
      formulaIds
    );

    const itemsByFormula: Record<number, any[]> = {};
    for (const item of items) {
      (itemsByFormula[item.saved_formula_id] ??= []).push(item);
    }

    const budgetItemsByFormula: Record<number, any[]> = {};
    for (const item of budgetItems) {
      (budgetItemsByFormula[item.saved_formula_id] ??= []).push({
        quantity: Number(item.quantity),
        unit: item.unit,
        value: Number(item.value),
      });
    }

    for (const f of formulas) {
      f.items = itemsByFormula[f.id] ?? [];
      f.budget_items = budgetItemsByFormula[f.id] ?? [];
    }

    return formulas;
  }

  async addSavedFormula(formula: {
    name: string;
    budget_number?: string;
    items: Array<{ insumo_id: number; quantity: number; unit?: string }>;
    budget_items: Array<{ quantity: number; unit: string; value: number }>;
  }, sessionToken?: string) {
    this.assertOperationContext();
    const creator = contexts.getStore()?.user;
    if (contexts.getStore()?.kind !== 'session' || !creator) throw new Error('Sessão obrigatória para criar a fórmula.');
    if (!this.pool) throw new Error('Sem conexão com o servidor');
    const { connection: conn, owned } = await this.operationConnection();
    try {
      if (owned) await conn.beginTransaction();
      const [r]: any = await conn.query('INSERT INTO saved_formulas (name, budget_number, created_by_name) VALUES (?,?,?)', [formula.name, formula.budget_number ?? null, creator.name]);
      await this.reserveBudgetNumber(conn, formula.budget_number, 'saved_formula', r.insertId);
      for (const item of formula.items) {
        await conn.query('INSERT INTO saved_formula_items (saved_formula_id, insumo_id, quantity, unit) VALUES (?,?,?,?)',
          [r.insertId, item.insumo_id, item.quantity, item.unit ?? 'mg']);
      }
      for (const b of formula.budget_items) {
        await conn.query('INSERT INTO saved_formula_budget_items (saved_formula_id, quantity, unit, value) VALUES (?,?,?,?)',
          [r.insertId, b.quantity, b.unit, b.value]);
      }
      if (owned) await conn.commit();
      const actor = await this.resolveActor(sessionToken);
      await this.logAction(actor, 'add', 'saved_formulas', r.insertId, `Fórmula salva adicionada: ${formula.name}.`);
      return { success: true, id: r.insertId };
    } catch (e) {
      if (owned) await conn.rollback();
      return { success: false, error: friendlyError(e) };
    } finally {
      if (owned) conn.release();
    }
  }

  async updateSavedFormula(id: number, formula: {
    name: string;
    budget_number?: string;
    items: Array<{ insumo_id: number; quantity: number; unit?: string }>;
    budget_items: Array<{ quantity: number; unit: string; value: number }>;
  }, sessionToken?: string) {
    this.assertOperationContext();
    if (!this.pool) throw new Error('Sem conexão com o servidor');
    const { connection: conn, owned } = await this.operationConnection();
    try {
      if (owned) await conn.beginTransaction();
      await conn.query('UPDATE saved_formulas SET name=?, budget_number=? WHERE id=?', [formula.name, formula.budget_number ?? null, id]);
      await conn.query('DELETE FROM budget_number_registry WHERE source_type=? AND source_id=?', ['saved_formula', id]);
      await this.reserveBudgetNumber(conn, formula.budget_number, 'saved_formula', id);
      await conn.query('DELETE FROM saved_formula_items WHERE saved_formula_id=?', [id]);
      for (const item of formula.items) {
        await conn.query('INSERT INTO saved_formula_items (saved_formula_id, insumo_id, quantity, unit) VALUES (?,?,?,?)',
          [id, item.insumo_id, item.quantity, item.unit ?? 'mg']);
      }
      await conn.query('DELETE FROM saved_formula_budget_items WHERE saved_formula_id=?', [id]);
      for (const b of formula.budget_items) {
        await conn.query('INSERT INTO saved_formula_budget_items (saved_formula_id, quantity, unit, value) VALUES (?,?,?,?)',
          [id, b.quantity, b.unit, b.value]);
      }
      if (owned) await conn.commit();
      const actor = await this.resolveActor(sessionToken);
      await this.logAction(actor, 'update', 'saved_formulas', id, `Fórmula salva atualizada: ${formula.name}.`);
      return { success: true };
    } catch (e) {
      if (owned) await conn.rollback();
      return { success: false, error: friendlyError(e) };
    } finally {
      if (owned) conn.release();
    }
  }

  async deleteSavedFormula(id: number, adminCreds?: { username: string; password: string }, sessionToken?: string) {
    try {
      const adminCheck = await this.checkAdminAccess(adminCreds, sessionToken);
      if (!adminCheck.success) return { success: false, error: adminCheck.error };

      const target = await this.q<any[]>('SELECT name FROM saved_formulas WHERE id = ?', [id]);
      await this.q('DELETE FROM budget_number_registry WHERE source_type=? AND source_id=?', ['saved_formula', id]);
      await this.q('DELETE FROM saved_formulas WHERE id=?', [id]);
      const actor = adminCheck.user
        ? { id: adminCheck.user.id, name: adminCheck.user.name }
        : (adminCreds?.username ?? 'Configuração');
      await this.logAction(actor, 'delete', 'saved_formulas', id, `Fórmula salva excluída: ${target[0]?.name ?? id}.`);
      return { success: true };
    } catch (e) {
      return { success: false, error: friendlyError(e) };
    }
  }
}
