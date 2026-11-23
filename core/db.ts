import crypto from 'crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { AsyncLocalStorage } from 'node:async_hooks';
import mysql from 'mysql2/promise';
import type { OrderDataDto, OrderDto, OrderAction, PartnerPharmacyDto } from '../shared/contracts.js';
import { BusinessRuleError, formatDbError, isUnsupportedAuthPluginError } from './dbError.js';

interface AdminVerifyResult {
  success: boolean;
  user?: { id: number; name: string; username: string; role: string };
  error?: string;
}

interface SessionUserResult {
  user?: SessionActor;
  error?: string;
}

type SessionActor = { id: number; name: string; username: string; role: string; pharmacy_id?: number | null; pharmacy_name?: string | null };

// ─── Helpers ───────────────────────────────────────────────────────────────────

const passwordHash = (s: string) => argonHash(s, {
  algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1,
});
const legacyHash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const sessionTokenDigest = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const parseSnapshot = (value: any): OrderDataDto => {
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8'));
  return typeof value === 'string' ? JSON.parse(value) : value;
};
const serializeSnapshot = (value: any): string => JSON.stringify(parseSnapshot(value));
const contexts = new AsyncLocalStorage<{
  kind: 'system' | 'session';
  user?: SessionActor;
  connection?: mysql.PoolConnection;
}>();

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
    const connection = contexts.getStore()?.connection ?? this.pool;
    const [rows] = await connection.query(sql, params);
    return rows as T;
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

  // Em contexto transacional, grava auditoria com ator derivado da sessão validada.
  private async logAction(action: string, entity: string, entityId: number, details: string): Promise<void> {
    try {
      const context = contexts.getStore();
      if (!context && this.authenticationEnforced) throw new Error('Contexto autenticado obrigatório para auditoria.');
      const actor = context?.kind === 'session' ? context.user : undefined;
      await this.withSystemContext(() => this.q(
        'INSERT INTO action_logs (user_id, user_name, action, entity, entity_id, details) VALUES (?,?,?,?,?,?)',
        [actor?.id ?? null, actor?.name ?? 'Configuração', action, entity, entityId, details]
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
    if (filters.userId === 0) where.push('user_id IS NULL');
    else if (filters.userId) { where.push('user_id = ?'); params.push(filters.userId); }
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
        "SELECT id, name, username, role, password FROM users WHERE username = ? AND role IN ('admin', 'manager', 'pharmacist') AND NOT EXISTS (SELECT 1 FROM partner_memberships m WHERE m.user_id=users.id)",
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
        `SELECT u.id, u.name, u.username, u.role, m.pharmacy_id, p.name AS pharmacy_name
         FROM sessions s
         JOIN users u ON s.user_id = u.id
         LEFT JOIN partner_memberships m ON m.user_id=u.id
         LEFT JOIN partner_pharmacies p ON p.id=m.pharmacy_id
         WHERE s.token = ? AND s.expires_at>NOW() AND s.absolute_expires_at>NOW()
           AND s.policy='hosted' AND s.last_seen >= NOW() - INTERVAL ? SECOND
           AND (m.user_id IS NULL OR m.active=1)`,
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
      const [rows]: any = await conn.query(`SELECT u.id,u.name,u.username,u.role,u.password,m.pharmacy_id,m.active AS membership_active,p.name AS pharmacy_name
        FROM users u LEFT JOIN partner_memberships m ON m.user_id=u.id
        LEFT JOIN partner_pharmacies p ON p.id=m.pharmacy_id WHERE u.username=? FOR UPDATE`, [username]);
      if (!rows.length || !(await this.verifyStoredPassword(password, rows[0].password))) {
        await conn.rollback(); conn.release(); conn = null;
        return { success: false, error: 'Usuário ou senha inválidos.' };
      }
      const storedPassword = rows[0].password;
      if (rows[0].pharmacy_id != null && !rows[0].membership_active) {
        await conn.rollback(); conn.release(); conn = null;
        return { success: false, error: 'Usuário ou senha inválidos.' };
      }
      if (!['admin', 'manager', 'pharmacist', 'employee'].includes(rows[0].role)) {
        await conn.rollback(); conn.release(); conn = null;
        return { success: false, error: 'Acesso negado. Este sistema é exclusivo para funcionários.' };
      }
      const user = { id: rows[0].id, name: rows[0].name, username: rows[0].username, role: rows[0].role, pharmacy_id: rows[0].pharmacy_id, pharmacy_name: rows[0].pharmacy_name };
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


  async assertPrivilegedSession(): Promise<void> {
    const context = contexts.getStore();
    if (context?.kind !== 'session' || !context.user || context.user.pharmacy_id != null || !['admin', 'manager', 'pharmacist'].includes(context.user.role)) {
      throw new Error('Acesso restrito à administração.');
    }
  }

  private sessionActor(): SessionActor {
    const context = contexts.getStore();
    if (context?.kind !== 'session' || !context.user) throw new Error('Sessão obrigatória.');
    return context.user;
  }

  assertInternalSession(): void {
    if (this.sessionActor().pharmacy_id != null) throw new Error('Acesso não autorizado.');
  }

  async listPartnerPharmacies(): Promise<PartnerPharmacyDto[]> {
    await this.assertPrivilegedSession();
    const pharmacies = await this.q<any[]>('SELECT id,name,created_at FROM partner_pharmacies ORDER BY name,id');
    const users = await this.q<any[]>(`SELECT m.pharmacy_id,u.id,u.name,u.username,m.active
      FROM partner_memberships m JOIN users u ON u.id=m.user_id ORDER BY u.name,u.id`);
    return pharmacies.map(p => ({ ...p, users: users.filter(u => u.pharmacy_id === p.id).map(({ pharmacy_id: _id, active, ...u }) => ({ ...u, active: !!active })) }));
  }

  async addPartnerPharmacy(name: string) {
    await this.assertPrivilegedSession();
    const result: any = await this.q('INSERT INTO partner_pharmacies(name) VALUES (?)', [name]);
    await this.logAction('add', 'partner_pharmacies', result.insertId, `Farmácia cadastrada: ${name}.`);
    return { success: true, id: result.insertId };
  }

  async addPartnerUser(pharmacyId: number, input: { name: string; username: string; password: string }) {
    await this.assertPrivilegedSession();
    const pharmacies = await this.q<any[]>('SELECT id FROM partner_pharmacies WHERE id=?', [pharmacyId]);
    if (!pharmacies.length) throw new BusinessRuleError('Farmácia não encontrada.', 404);
    let result: any;
    try {
      result = await this.q('INSERT INTO users(name,username,password,role) VALUES (?,?,?,?)', [input.name, input.username, await passwordHash(input.password), 'employee']);
    } catch (error: any) {
      if (error?.code === 'ER_DUP_ENTRY') throw new BusinessRuleError('Este usuário já está cadastrado.', 409);
      throw error;
    }
    await this.q('INSERT INTO partner_memberships(user_id,pharmacy_id) VALUES (?,?)', [result.insertId, pharmacyId]);
    await this.logAction('add', 'partner_memberships', result.insertId, `Acesso criado para farmácia ${pharmacyId}.`);
    return { success: true, id: result.insertId };
  }

  async updatePartnerUser(userId: number, input: { active?: boolean; password?: string }) {
    await this.assertPrivilegedSession();
    const rows = await this.q<any[]>('SELECT user_id FROM partner_memberships WHERE user_id=? FOR UPDATE', [userId]);
    if (!rows.length) throw new BusinessRuleError('Usuário não encontrado.', 404);
    if (input.active !== undefined) await this.q('UPDATE partner_memberships SET active=? WHERE user_id=?', [input.active ? 1 : 0, userId]);
    if (input.password !== undefined) await this.q('UPDATE users SET password=? WHERE id=?', [await passwordHash(input.password), userId]);
    if (input.active === false || input.password !== undefined) await this.q('DELETE FROM sessions WHERE user_id=?', [userId]);
    await this.logAction('update', 'partner_memberships', userId, 'Acesso da farmácia atualizado.');
    return { success: true };
  }

  async listPartnerPatients() {
    const actor = this.sessionActor();
    if (actor.pharmacy_id == null) throw new Error('Acesso não autorizado.');
    return this.q('SELECT id,name,phone FROM partner_patients WHERE pharmacy_id=? ORDER BY name,id', [actor.pharmacy_id]);
  }

  private orderFromRow(row: any): OrderDto {
    const { created_at_epoch, updated_at_epoch, ...fields } = row;
    return {
      ...fields,
      created_at: new Date(Number(created_at_epoch) * 1000).toISOString(),
      updated_at: new Date(Number(updated_at_epoch) * 1000).toISOString(),
      original_data: parseSnapshot(row.original_data),
      current_data: parseSnapshot(row.current_data),
      proposed_data: row.proposed_data ? parseSnapshot(row.proposed_data) : null,
      revision: Number(row.revision),
      events: [],
    };
  }

  async listOrders(): Promise<OrderDto[]> {
    const actor = this.sessionActor();
    const where = actor.pharmacy_id != null ? 'WHERE o.pharmacy_id=?' : '';
    const rows = await this.q<any[]>(`SELECT o.*,p.name AS pharmacy_name,UNIX_TIMESTAMP(o.created_at) AS created_at_epoch,UNIX_TIMESTAMP(o.updated_at) AS updated_at_epoch FROM orders o JOIN partner_pharmacies p ON p.id=o.pharmacy_id ${where} ORDER BY o.created_at DESC,o.id DESC`, actor.pharmacy_id != null ? [actor.pharmacy_id] : []);
    return rows.map(row => this.orderFromRow(row));
  }

  async getOrder(id: number): Promise<OrderDto> {
    const actor = this.sessionActor();
    const rows = await this.q<any[]>(`SELECT o.*,p.name AS pharmacy_name,UNIX_TIMESTAMP(o.created_at) AS created_at_epoch,UNIX_TIMESTAMP(o.updated_at) AS updated_at_epoch FROM orders o JOIN partner_pharmacies p ON p.id=o.pharmacy_id WHERE o.id=?${actor.pharmacy_id != null ? ' AND o.pharmacy_id=?' : ''}`, actor.pharmacy_id != null ? [id, actor.pharmacy_id] : [id]);
    if (!rows.length) throw new BusinessRuleError('Pedido não encontrado.', 404);
    const order = this.orderFromRow(rows[0]);
    const events = await this.q<any[]>('SELECT id,actor_name,action,snapshot,note,UNIX_TIMESTAMP(created_at) AS created_at_epoch FROM order_events WHERE order_id=? ORDER BY id', [id]);
    order.events = events.map(({ created_at_epoch, ...event }) => ({ ...event, created_at: new Date(Number(created_at_epoch) * 1000).toISOString(), snapshot: event.snapshot ? parseSnapshot(event.snapshot) : null }));
    return order;
  }

  private async validateOrderItems(items: OrderDataDto['items'], previousItems: OrderDataDto['items'] = []) {
    const names = [...new Set(items.map(item => item.name))];
    const catalog = await this.q<Array<{ name: string }>>(
      'SELECT name FROM insumos WHERE name IN (?) LOCK IN SHARE MODE', [names],
    );
    const registered = new Set(catalog.map(item => item.name));
    const remaining = [...previousItems];

    for (const item of items) {
      if (registered.has(item.name)) continue;
      const previous = remaining.findIndex(old => old.name === item.name && old.quantity === item.quantity && old.unit === item.unit);
      if (previous === -1) throw new BusinessRuleError(`Selecione um insumo cadastrado para substituir "${item.name}".`);
      remaining.splice(previous, 1);
    }
  }

  async addOrder(data: OrderDataDto) {
    const actor = this.sessionActor();
    if (actor.pharmacy_id == null) throw new Error('Acesso não autorizado.');
    await this.validateOrderItems(data.items);
    const snapshot = JSON.stringify(data);
    const result: any = await this.q('INSERT INTO orders(pharmacy_id,original_data,current_data) VALUES (?,?,?)', [actor.pharmacy_id, snapshot, snapshot]);
    await this.q('INSERT IGNORE INTO partner_patients(pharmacy_id,name,phone) VALUES (?,?,?)', [actor.pharmacy_id, data.patient_name, data.patient_phone]);
    await this.q('INSERT INTO order_events(order_id,user_id,actor_name,action,snapshot) VALUES (?,?,?,?,?)', [result.insertId, actor.id, actor.name, 'submitted', snapshot]);
    await this.logAction('add', 'orders', result.insertId, 'Pedido enviado pela farmácia.');
    return { success: true, id: result.insertId };
  }

  async transitionOrder(id: number, action: Exclude<OrderAction, 'submitted' | 'imported'>, revision: number, proposed?: OrderDataDto, note?: string) {
    const actor = this.sessionActor();
    const isPartner = actor.pharmacy_id != null;
    const partnerAction = action === 'approved' || action === 'rejected';
    if (partnerAction !== isPartner) throw new Error('Acesso não autorizado.');
    const rows = await this.q<any[]>(`SELECT * FROM orders WHERE id=?${isPartner ? ' AND pharmacy_id=?' : ''} FOR UPDATE`, isPartner ? [id, actor.pharmacy_id] : [id]);
    if (!rows.length) throw new BusinessRuleError('Pedido não encontrado.', 404);
    const order = rows[0];
    if (Number(order.revision) !== revision) throw new BusinessRuleError('O pedido foi atualizado. Recarregue e confira os dados.', 409);
    if (partnerAction ? order.status !== 'awaiting_approval' : !['submitted', 'under_review'].includes(order.status)) throw new BusinessRuleError('Esta ação não está disponível no estado atual do pedido.', 409);
    let status: string;
    let current = serializeSnapshot(order.current_data);
    let proposal: string | null = order.proposed_data ? serializeSnapshot(order.proposed_data) : null;
    let snapshot: string | null = null;
    if (action === 'reviewed') status = 'under_review';
    else if (action === 'accepted') status = 'accepted';
    else if (action === 'proposed') {
      if (!proposed) throw new BusinessRuleError('Informe a alteração proposta.');
      await this.validateOrderItems(proposed.items, parseSnapshot(current).items);
      proposal = JSON.stringify(proposed);
      if (JSON.stringify(JSON.parse(current)) === proposal) throw new BusinessRuleError('Altere pelo menos um campo antes de enviar a proposta.');
      snapshot = proposal;
      status = 'awaiting_approval';
    } else {
      if (!proposal) throw new BusinessRuleError('Proposta indisponível.', 409);
      snapshot = proposal;
      if (action === 'approved') {
        current = proposal; status = 'accepted';
        const approved = parseSnapshot(proposal);
        await this.q('INSERT IGNORE INTO partner_patients(pharmacy_id,name,phone) VALUES (?,?,?)', [order.pharmacy_id, approved.patient_name, approved.patient_phone]);
      }
      else status = 'under_review';
      proposal = null;
    }
    await this.q('UPDATE orders SET status=?,current_data=?,proposed_data=?,revision=revision+1 WHERE id=?', [status, current, proposal, id]);
    await this.q('INSERT INTO order_events(order_id,user_id,actor_name,action,snapshot,note) VALUES (?,?,?,?,?,?)', [id, actor.id, actor.name, action, snapshot, note || null]);
    await this.logAction(action, 'orders', id, `Pedido ${id}: ${action}.`);
    return { success: true };
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
    return this.assertPrivilegedSession().then(() => this.q('SELECT u.id, u.name, u.username, u.role FROM users u WHERE NOT EXISTS (SELECT 1 FROM partner_memberships m WHERE m.user_id=u.id) ORDER BY u.name'));
  }

  async addUser(user: { name: string; username: string; password: string; role: string }) {
    this.assertOperationContext();
    try {
      const access = await this.checkAdminAccess();
      if (!access.success) return { success: false, error: access.error };
      if (!['admin', 'manager', 'pharmacist', 'employee'].includes(user.role)) {
        return { success: false, error: 'Perfil inválido.' };
      }
      if (!this.pool) throw new Error('Sem conexão com o servidor');
      const actor = access.user!;
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

  async updateUser(id: number, user: { name: string; username: string; password?: string; role: string }) {
    this.assertOperationContext();
    try {
      const access = await this.checkAdminAccess();
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

  async deleteUser(id: number, adminCreds?: { username: string; password: string }) {
    try {
      const adminCheck = await this.checkAdminAccess(adminCreds);
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

  private async checkAdminAccess(adminCreds?: { username: string; password: string }) {
    const context = contexts.getStore();
    const actor = context?.kind === 'session' ? context.user : undefined;
    if (!actor) return { success: false, error: 'Sessão obrigatória.' };
    if (actor.pharmacy_id != null) return { success: false, error: 'Acesso não autorizado.' };
    if (adminCreds?.username && adminCreds?.password) {
      const reauth = await this.verifyAdmin(adminCreds.username, adminCreds.password);
      if (!reauth.success) return reauth;
      return { success: true, user: actor };
    }
    if (!['admin', 'manager', 'pharmacist'].includes(actor.role)) return { success: false, error: 'Credenciais de administrador inválidas' };
    return { success: true, user: actor };
  }

  // ── Insumos ─────────────────────────────────────────────────────────────────

  listInsumos() {
    return this.q('SELECT id, name, created_at FROM insumos ORDER BY name');
  }

  async addInsumo(name: string) {
    try {
      const r: any = await this.q('INSERT INTO insumos (name) VALUES (?)', [name]);
      await this.logAction('add', 'insumos', r.insertId, `Insumo adicionado: ${name}.`);
      return { success: true, id: r.insertId };
    } catch (e) {
      return { success: false, error: friendlyError(e) };
    }
  }

  async updateInsumo(id: number, name: string) {
    try {
      await this.q('UPDATE insumos SET name=? WHERE id=?', [name, id]);
      await this.logAction('update', 'insumos', id, `Insumo atualizado: ${name}.`);
      return { success: true };
    } catch (e) {
      return { success: false, error: friendlyError(e) };
    }
  }

  async deleteInsumo(id: number, adminCreds?: { username: string; password: string }) {
    try {
      const adminCheck = await this.checkAdminAccess(adminCreds);
      if (!adminCheck.success) return { success: false, error: adminCheck.error };

      const target = await this.q<any[]>('SELECT name FROM insumos WHERE id = ?', [id]);
      await this.q('DELETE FROM insumos WHERE id=?', [id]);
      await this.logAction('delete', 'insumos', id, `Insumo excluído: ${target[0]?.name ?? id}.`);
      return { success: true };
    } catch (e) {
      return { success: false, error: friendlyError(e) };
    }
  }


}
