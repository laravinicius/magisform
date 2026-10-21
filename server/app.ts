import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import mysql from 'mysql2/promise';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z, ZodError } from 'zod';
import { BusinessRuleError } from '../core/dbError.js';
import { Db } from '../core/db.js';
import type { DataEnvelopeDto } from '../shared/contracts.js';
import type { ServerConfig } from './config.js';

const id = z.coerce.number().int().positive();
const credentials = z.object({ username: z.string().trim().min(1).max(100), password: z.string().min(1).max(255) });
const userInput = z.object({ name: z.string().trim().min(1).max(255), username: z.string().trim().min(1).max(100), password: z.string().min(1).max(255), role: z.enum(['employee','pharmacist','manager','admin']) });
const userPatch = userInput.partial().refine((v) => Object.keys(v).length > 0);
const customerInput = z.object({ name: z.string().trim().min(1).max(255), phone: z.string().max(30).nullable(), responsible_customer_id: id.nullable().optional() });
const customerPatch = z.object({ name: customerInput.shape.name, phone: customerInput.shape.phone }).partial().refine((v) => Object.keys(v).length > 0);
const insumoInput = z.union([z.string().trim().min(1).max(255), z.object({ name: z.string().trim().min(1).max(255) })]);
const item = z.object({ insumo_id: id, quantity: z.coerce.number().positive(), unit: z.string().max(40).optional() });
const budgetItem = z.object({ quantity: z.coerce.number().positive(), unit: z.string().trim().min(1).max(40), value: z.coerce.number().min(0), is_selected: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional() });
const formulaInput = z.object({ customer_id: id, attendant_name: z.string().trim().min(1).max(255), items: z.array(item).min(1).max(200), budget_number: z.string().max(20).optional(), budget_items: z.array(budgetItem).max(50).optional(), delivery_date: z.string().nullable().optional(), payment_status: z.string().max(30).optional(), partial_payment_amount: z.coerce.number().min(0).nullable().optional(), payment_method: z.string().max(40).nullable().optional(), delivery_status: z.string().max(40).optional(), cancel_reason: z.string().max(2000).nullable().optional(), status: z.enum(['pending','confirmed','cancelled','delivered']).optional() });
const savedInput = z.object({ name: z.string().trim().min(1).max(255), budget_number: z.string().max(20).optional(), items: z.array(item).min(1).max(200), budget_items: z.array(budgetItem).max(50) });
const admin = z.object({ username: z.string().trim().min(1).max(100), password: z.string().min(1).max(255) });
const idParams = z.object({ id });
const statusBody = z.object({ status: z.string().trim().min(1).max(40) });
const deliveryBatch = z.object({ ids: z.array(id).min(1).max(500), status: z.string().trim().min(1).max(40) });
const logQuery = z.object({ userId: z.string().regex(/^[1-9]\d*$/).optional(), action: z.string().max(100).optional(), entity: z.string().max(100).optional(), from: z.string().max(30).optional(), to: z.string().max(30).optional(), search: z.string().max(200).optional(), page: z.string().regex(/^\d+$/).optional(), pageSize: z.string().regex(/^\d+$/).optional() });
const formulaQuery = z.object({ cursor: z.string().max(512).optional(), limit: z.string().regex(/^[1-9]\d*$/).refine((value) => Number(value) <= 100).optional(), statuses: z.string().max(100).optional(), deliveryStatus: z.string().max(40).optional(), search: z.string().max(100).optional() });
const paymentUpdate = z.object({ payment_status: z.enum(['pago','parcial','pagar_na_retirada']), partial_payment_amount: z.number().nullable() });
const formulaSummaryQuery = z.object({ paymentStatus: z.enum(['pago','parcial','pagar_na_retirada','nao_pago']).default('pago'), month: z.string().regex(/^(0|[1-9]|1[01])$/), year: z.string().regex(/^\d{4}$/) });

type AppOptions = { config: ServerConfig; db?: Db; pool?: mysql.Pool; closePool?: boolean };

function codeFor(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof BusinessRuleError) return { status: error.status, code: error.status === 400 ? 'VALIDATION_ERROR' : error.status === 404 ? 'NOT_FOUND' : 'CONFLICT', message: error.message };
  const message = error instanceof Error ? error.message : '';
  if (/Sessão obrigatória|Sessão inválida|expirada|revogada/i.test(message)) return { status: 401, code: 'UNAUTHENTICATED', message: 'Sessão inválida ou expirada.' };
  if (/permiss|autorizad|manager|gerente|privilégio|credenciais administrativas|restrito à administração/i.test(message)) return { status: 403, code: 'FORBIDDEN', message: 'Acesso não autorizado.' };
  if (/não encontrado|não existe|inexistente/i.test(message)) return { status: 404, code: 'NOT_FOUND', message: 'Registro não encontrado.' };
  if (/conflito|já utilizado|duplicad|último|referência|em uso|só pode|não pode/i.test(message)) return { status: 409, code: 'CONFLICT', message: 'A operação não pode ser concluída por conflito com os dados atuais.' };
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|PROTOCOL_CONNECTION_LOST|EHOSTUNREACH|EAI_AGAIN|Sem conexão/i.test(message)) return { status: 503, code: 'UNAVAILABLE', message: 'Serviço temporariamente indisponível.' };
  return { status: 500, code: 'UNAVAILABLE', message: 'Erro interno do servidor.' };
}

const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export async function buildApp({ config, db: providedDb, pool: providedPool, closePool = true }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: 'info',
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["set-cookie"]', 'req.body', 'res.headers["set-cookie"]'], censor: '[REDACTED]' },
      serializers: { req: (request) => ({ method: request.method, url: new URL(request.url, 'http://localhost').pathname }) },
    },
    trustProxy: config.trustProxy, bodyLimit: 1024 * 1024, genReqId: () => randomBytes(12).toString('hex'),
  });
  const pool = providedPool ?? mysql.createPool({ ...config.db, waitForConnections: true, connectionLimit: config.db.connectionLimit, dateStrings: true, timezone: '-03:00', charset: 'utf8mb4' });
  const db = providedDb ?? new Db();
  Db.configureHostedSession(config.sessionIdleHours * 3600, config.sessionAbsoluteHours * 3600);
  db.setPool(pool);
  db.enforceAuthentication();
  const sessionCookie = config.secure ? '__Host-magisform_session' : 'magisform_dev_session';
  const csrfCookie = config.secure ? '__Host-magisform_csrf' : 'magisform_dev_csrf';
  const cookieOpts = { path: '/', httpOnly: false, secure: config.secure, sameSite: 'lax' as const };
  const loginIpWindows = new Map<string, { count: number; resetAt: number }>();
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(swagger, { openapi: {
    info: { title: 'MagisForm API', version: config.version }, servers: [{ url: config.origin }], tags: [{ name: 'auth' }, { name: 'data' }, { name: 'health' }],
    components: { securitySchemes: {
      CookieAuth: { type: 'apiKey', in: 'cookie', name: '__Host-magisform_session' },
    }, schemas: {
      UserDto: { type: 'object', required: ['id','name','username','role'], properties: { id: { type: 'integer' }, name: { type: 'string' }, username: { type: 'string' }, role: { type: 'string', enum: ['employee','pharmacist','manager','admin'] } } },
      CustomerDto: { type: 'object', required: ['id','name','phone'], properties: { id: { type: 'integer' }, name: { type: 'string' }, phone: { type: 'string', nullable: true }, responsible_id: { type: 'integer', nullable: true }, responsible_name: { type: 'string', nullable: true }, responsible_phone: { type: 'string', nullable: true }, created_at: { type: 'string' } } },
      InsumoDto: { type: 'object', required: ['id','name'], properties: { id: { type: 'integer' }, name: { type: 'string' }, created_at: { type: 'string' } } },
      FormulaDto: { type: 'object', required: ['id','customer_id','attendant_name','status','created_at'], properties: { id: { type: 'integer' }, customer_id: { type: 'integer' }, customer_name: { type: 'string' }, customer_phone: { type: 'string' }, attendant_name: { type: 'string' }, status: { type: 'string', enum: ['pending','confirmed','cancelled','delivered'] }, created_at: { type: 'string' }, items: { type: 'array', items: { type: 'object' } }, budget_items: { type: 'array', items: { type: 'object' } }, delivered_at: { type: 'string', nullable: true } } },
      SavedFormulaDto: { type: 'object', required: ['id','name','items'], properties: { id: { type: 'integer' }, name: { type: 'string' }, items: { type: 'array', items: { type: 'object' } }, budget_items: { type: 'array', items: { type: 'object' } } } },
      AuditLogDto: { type: 'object', required: ['id','action','entity','created_at'], properties: { id: { type: 'integer' }, user_id: { type: 'integer', nullable: true }, user_name: { type: 'string' }, action: { type: 'string' }, entity: { type: 'string' }, entity_id: { type: 'integer', nullable: true }, details: { type: 'string' }, created_at: { type: 'string' } } },
      PublicConfigDto: { type: 'object', required: ['installationName','brand','brandTheme','version','capabilities'], properties: { installationName: { type: 'string' }, brand: { type: 'string' }, brandTheme: { type: 'object', required: ['primary','secondary','background','surface','ink','muted'], properties: { primary: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, secondary: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, background: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, surface: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, ink: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, muted: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } } }, version: { type: 'string' }, capabilities: { type: 'array', items: { type: 'string' } } } },
      DataEnvelope: { type: 'object', required: ['data'], properties: { data: {} } },
      ErrorEnvelope: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code','message','requestId'], properties: { code: { type: 'string', enum: ['VALIDATION_ERROR','UNAUTHENTICATED','FORBIDDEN','NOT_FOUND','SESSION_CONFLICT','CONFLICT','UNAVAILABLE'] }, message: { type: 'string' }, requestId: { type: 'string' }, fieldErrors: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } } } } } },
    } },
  } });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });
  app.addHook('onClose', async () => { if (closePool) await pool.end(); });
  app.addHook('onResponse', async (request, reply) => {
    request.log.info({ requestId: request.id, installation: config.installationName, operation: `${request.method} ${request.routeOptions.url ?? 'not-found'}`, statusCode: reply.statusCode }, 'Requisição concluída');
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'POST' || request.url.split('?')[0] !== '/api/v1/auth/login') return;
    const now = Date.now();
    const current = loginIpWindows.get(request.ip);
    if (!current || current.resetAt <= now) loginIpWindows.set(request.ip, { count: 1, resetAt: now + 15 * 60_000 });
    else if (++current.count > 40) return reply.code(429).send({ error: { code: 'CONFLICT', message: 'Muitas tentativas. Aguarde e tente novamente.', requestId: request.id } });
    if (loginIpWindows.size > 1024) for (const [ip, window] of loginIpWindows) if (window.resetAt <= now) loginIpWindows.delete(ip);
  });
  if (config.secure) app.addHook('onRequest', async (request, reply) => {
    const remoteAddress = request.raw.socket.remoteAddress?.replace(/^::ffff:/, '');
    const loopbackHealthProbe = request.url.split('?')[0] === '/health/live' && (remoteAddress === '::1' || remoteAddress === '127.0.0.1' || Boolean(remoteAddress?.startsWith('127.')));
    if (loopbackHealthProbe) return;
    const canonicalOrigin = new URL(config.origin);
    const hostMatches = request.headers.host === canonicalOrigin.host || (config.allowHostWithoutPort && request.headers.host === canonicalOrigin.hostname);
    if (!hostMatches || request.protocol !== 'https') return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Recurso não encontrado.', requestId: request.id } });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Dados inválidos.', requestId: request.id, fieldErrors: Object.fromEntries(error.issues.map((i) => [String(i.path[0] ?? 'body'), [i.message]])) } });
    if ((error as any).statusCode === 429) return reply.code(429).send({ error: { code: 'CONFLICT', message: 'Muitas tentativas. Aguarde e tente novamente.', requestId: request.id } });
    const httpStatus = (error as any).statusCode as number | undefined;
    if (httpStatus === 409 && String((error as any).message).includes('SESSION_CONFLICT')) return reply.code(409).send({ error: { code: 'SESSION_CONFLICT', message: 'Este usuário já possui uma sessão ativa.', requestId: request.id } });
    if (httpStatus === 401) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Credenciais inválidas ou sessão expirada.', requestId: request.id } });
    if (httpStatus === 403) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Acesso não autorizado.', requestId: request.id } });
    if (httpStatus === 400) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Requisição inválida.', requestId: request.id } });
    const mapped = codeFor(error);
    request.log.error({ requestId: request.id, installation: config.installationName, operation: `${request.method} ${request.routeOptions.url ?? 'unknown'}`, errorType: error instanceof Error ? error.name : 'UnknownError' }, 'Falha na requisição');
    return reply.code(mapped.status).send({ error: { code: mapped.code, message: mapped.message, requestId: request.id } });
  });

  app.addHook('onRequest', async request => {
    if (request.headers.authorization !== undefined) throw Object.assign(new Error('Authorization não é permitido na API web.'), { statusCode: 400 });
  });

  const originAndCsrf = (request: FastifyRequest, includeLogin = false) => {
    if (request.headers.origin !== config.origin) throw Object.assign(new Error('Origem inválida'), { statusCode: 403 });
    if (includeLogin || request.cookies[sessionCookie]) {
      const csrf = request.cookies[csrfCookie];
      const header = request.headers['x-csrf-token'];
      if (!csrf || typeof header !== 'string' || !safeEqual(csrf, header)) throw Object.assign(new Error('CSRF inválido'), { statusCode: 403 });
    }
  };
  const guardMutation = (request: FastifyRequest, url: string) => originAndCsrf(request, url === '/auth/login');
  const resolveToken = (request: FastifyRequest) => request.cookies[sessionCookie];
  const withSession = async <T>(request: FastifyRequest, fn: (token: string) => Promise<T>, activityEligible = false) => {
    const token = resolveToken(request);
    if (!token) throw Object.assign(new Error('Sessão obrigatória'), { statusCode: 401 });
    if (activityEligible && request.headers['x-magisform-activity'] === 'user' && !(await db.heartbeat(token)).valid) throw Object.assign(new Error('Sessão inválida ou expirada.'), { statusCode: 401 });
    return db.withSessionContext(token, () => fn(token));
  };
  const data = <T>(value: T): DataEnvelopeDto<T> => ({ data: value });
  const addRoute = (method: 'GET'|'POST'|'PATCH'|'DELETE', url: string, handler: (request: FastifyRequest, reply: any) => Promise<any>, opts: { mutating?: boolean; auth?: boolean; security?: boolean; schema?: any; validation?: z.ZodType<any>; queryValidation?: z.ZodType<any>; config?: any } = {}) => {
    const bodySchema = opts.validation ? z.toJSONSchema(opts.validation, { target: 'draft-7' }) : undefined;
    const querySchema = opts.queryValidation ? z.toJSONSchema(opts.queryValidation, { target: 'draft-7' }) : undefined;
    const paramsSchema = url.includes('/:id') ? { type: 'object', properties: { id: { type: 'string', pattern: '^[1-9]\\d*$' } }, required: ['id'] } : undefined;
    app.route({ method, url: `/api/v1${url}`, schema: {
      tags: [url.startsWith('/health') ? 'health' : url.startsWith('/auth') ? 'auth' : 'data'],
      ...((opts.auth || opts.security) ? { security: [{ CookieAuth: [] }] } : {}),
      ...(bodySchema ? { body: bodySchema } : {}), ...(querySchema ? { querystring: querySchema } : {}), ...(paramsSchema ? { params: paramsSchema } : {}),
      response: { 200: { type: 'object', properties: { data: {} }, required: ['data'] } }, ...opts.schema,
    }, config: opts.config, handler: async (request, reply) => {
      if (opts.mutating) guardMutation(request, url);
      if (opts.auth) return withSession(request, async () => handler(request, reply), !url.startsWith('/auth/'));
      return handler(request, reply);
    } });
  };
  const parsed = <T>(schema: z.ZodType<T>, input: unknown): T => schema.parse(input);
  const wrapped = (fn: (req: FastifyRequest, rep: any) => Promise<any>) => async (req: FastifyRequest, rep: any) => {
    const result = await fn(req, rep);
    if (result && typeof result === 'object' && result.success === false) {
      const message = String(result.error ?? 'Operação não concluída.');
      if (result.conflict || message.includes('SESSION_CONFLICT')) throw Object.assign(new Error('SESSION_CONFLICT'), { statusCode: 409 });
      throw new Error(message);
    }
    return data(result);
  };
  const paramId = (req: FastifyRequest) => parsed(idParams, req.params).id;
  const rate = { rateLimit: { hook: 'preHandler' as const, max: 8, timeWindow: '15 minutes', keyGenerator: (req: FastifyRequest) => `${req.ip}:${String((req.body as any)?.username ?? '').toLowerCase()}` } };

  addRoute('GET','/health/live', async () => ({ data: { status: 'ok' } }));
  addRoute('GET','/health/ready', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT version FROM schema_version WHERE singleton=1 LIMIT 1');
      if (!rows.length || Number(rows[0].version) !== 3) throw new Error('Schema ausente ou incompatível');
      return { data: { status: 'ready' } };
    }
    catch { return reply.code(503).send({ error: { code: 'UNAVAILABLE', message: 'Serviço temporariamente indisponível.', requestId: reply.request.id } }); }
  });
  addRoute('GET','/public-config', async () => data({ installationName: config.installationName, brand: config.brand, brandTheme: config.brandTheme, version: config.version, capabilities: ['web'] }));
  addRoute('GET','/auth/csrf', async (_req, reply) => { const token = randomBytes(32).toString('base64url'); reply.setCookie(csrfCookie, token, cookieOpts); return data({ csrfToken: token }); });
  addRoute('POST','/auth/login', async (req, reply) => {
    if (req.headers.authorization) throw Object.assign(new Error('Credenciais ambíguas'), { statusCode: 400 });
    const input = parsed(credentials.extend({ force: z.boolean().optional() }), req.body);
    const result = await db.login(input.username, input.password, input.force ?? false);
    if (!result.success) throw Object.assign(new Error(result.conflict ? 'SESSION_CONFLICT' : result.error ?? 'Credenciais inválidas'), { statusCode: result.conflict ? 409 : 401 });
    reply.setCookie(sessionCookie, result.sessionToken!, { path: '/', httpOnly: true, secure: config.secure, sameSite: 'lax' });
    return data({ user: result.user });
  }, { mutating: true, config: rate, validation: credentials.extend({ force: z.boolean().optional() }) });
  addRoute('GET','/auth/me', async (req) => withSession(req, async (token) => {
    const result = await db.getSessionUser(token);
    if (!result.user) throw new Error('Sessão inválida ou expirada.');
    return data({ authenticated: true, user: result.user });
  }), { security: true });
  addRoute('POST','/auth/heartbeat', async (req) => {
    const token = resolveToken(req)!;
    return data({ valid: !!(await db.getSessionUser(token)).user });
  }, { mutating: true, auth: true });
  addRoute('POST','/auth/logout', async (req, reply) => withSession(req, async (token) => {
    await db.revokeSession(token); reply.clearCookie(sessionCookie, { path: '/', secure: config.secure, sameSite: 'lax' }); return data({ success: true });
  }), { mutating: true, security: true });

  const common = { auth: true };
  const crud = (path: string, list: () => Promise<any>, create: (v: any) => Promise<any>, update: (id: number, v: any) => Promise<any>, remove: (id: number, creds?: any) => Promise<any>, schema: z.ZodType<any>, patchSchema: z.ZodType<any>) => {
    addRoute('GET', path, wrapped(async () => list()), common);
    addRoute('POST', path, wrapped(async (req) => create(parsed(schema, req.body))), { ...common, mutating: true, validation: schema });
    addRoute('PATCH', `${path}/:id`, wrapped(async (req) => update(paramId(req), parsed(patchSchema, req.body))), { ...common, mutating: true, validation: patchSchema });
    addRoute('DELETE', `${path}/:id`, wrapped(async (req) => remove(paramId(req), parsed(admin, req.body))), { ...common, mutating: true, validation: admin });
  };
  crud('/users', () => db.listUsers(), (v) => db.addUser(v), async (i,v) => {
    const current = (await db.listUsers()).find((entry: any) => entry.id === i);
    if (!current) return { success: false, error: 'Usuário não encontrado.' };
    return db.updateUser(i, { ...current, ...v });
  }, (i,v) => db.deleteUser(i,v), userInput, userPatch);
  crud('/customers', () => db.listCustomers(), (v) => db.addCustomer(v), async (i,v) => {
    const current = (await db.listCustomers()).find((entry: any) => entry.id === i);
    if (!current) return { success: false, error: 'Cliente não encontrado.' };
    return db.updateCustomer(i, { name: v.name ?? current.name, phone: v.phone === undefined ? current.phone : v.phone });
  }, (i,v) => db.deleteCustomer(i,v), customerInput, customerPatch);
  crud('/insumos', () => db.listInsumos(), (v) => db.addInsumo(typeof v === 'string' ? v : v.name), (i,v) => db.updateInsumo(i, typeof v === 'string' ? v : v.name), (i,v) => db.deleteInsumo(i,v), insumoInput, insumoInput);
  addRoute('GET', '/formulas', async (req, reply) => {
    const q = parsed(formulaQuery, req.query);
    if (!q.limit) return reply.code(426).send({ error: { code: 'CLIENT_UPDATE_REQUIRED', message: 'Atualize o MagisForm para a versão 0.2.3 ou superior para consultar fórmulas.' } });
    const statuses = q.statuses ? q.statuses.split(',') : [];
    if (statuses.some((status) => !['pending','confirmed','cancelled','delivered'].includes(status))) throw Object.assign(new Error('Filtro de status inválido.'), { statusCode: 400 });
    return data(await db.listFormulas({ cursor: q.cursor, limit: Number(q.limit), statuses: statuses as any, deliveryStatus: q.deliveryStatus, search: q.search }));
  }, { ...common, queryValidation: formulaQuery });
  addRoute('GET', '/formulas-summary', wrapped(async (req) => { const q = parsed(formulaSummaryQuery, req.query); return db.getFormulaSummary(Number(q.month), Number(q.year), q.paymentStatus); }), common);
  addRoute('GET', '/formulas/:id', wrapped(async (req) => db.getFormula(paramId(req))), common);
  addRoute('POST', '/formulas', wrapped(async (req) => db.addFormula(parsed(formulaInput, req.body))), { ...common, mutating: true, validation: formulaInput });
  addRoute('PATCH', '/formulas/:id', wrapped(async (req) => db.updateFormula(paramId(req), parsed(formulaInput, req.body))), { ...common, mutating: true, validation: formulaInput });
  addRoute('DELETE', '/formulas/:id', wrapped(async (req) => db.deleteFormula(paramId(req), parsed(admin, req.body))), { ...common, mutating: true, validation: admin });
  crud('/saved-formulas', () => db.listSavedFormulas(), (v) => db.addSavedFormula(v), async (i,v) => {
    const current = (await db.listSavedFormulas()).find((entry: any) => entry.id === i);
    if (!current) return { success: false, error: 'Modelo não encontrado.' };
    return db.updateSavedFormula(i, { ...current, ...v });
  }, (i,v) => db.deleteSavedFormula(i,v), savedInput, savedInput.partial().refine((v) => Object.keys(v).length > 0));
  addRoute('PATCH','/formulas/:id/status', wrapped(async (req) => db.updateFormulaStatus(paramId(req), parsed(statusBody,req.body).status)), { ...common, mutating: true, validation: statusBody });
  addRoute('PATCH','/formulas/:id/delivery-status', wrapped(async (req) => db.updateFormulaDeliveryStatus(paramId(req), parsed(statusBody,req.body).status)), { ...common, mutating: true, validation: statusBody });
  addRoute('PATCH','/formulas/:id/payment', wrapped(async (req) => db.updateFormulaPayment(paramId(req), (() => { const payment = parsed(paymentUpdate,req.body); return { payment_status: payment.payment_status, partial_payment_amount: payment.partial_payment_amount ?? null }; })())), { ...common, mutating: true, validation: paymentUpdate });
  addRoute('POST','/formulas/:id/verification', wrapped(async (req) => db.verifyFormula(paramId(req))), { ...common, mutating: true });
  addRoute('PATCH','/formulas/delivery-status-batch', wrapped(async (req) => { const b = parsed(deliveryBatch,req.body); return db.updateFormulasDeliveryStatus(b.ids,b.status); }), { ...common, mutating: true, validation: deliveryBatch });
  addRoute('GET','/logs', wrapped(async (req) => {
    const q = parsed(logQuery, req.query);
    return db.listLogs({ userId: q.userId ? Number(q.userId) : undefined, action: q.action, entity: q.entity, from: q.from, to: q.to, search: q.search, page: q.page ? Number(q.page) : undefined, pageSize: q.pageSize ? Number(q.pageSize) : undefined });
  }), { ...common, queryValidation: logQuery });

  const webRoot = path.resolve(process.cwd(), 'dist-web');
  if (existsSync(path.join(webRoot, 'index.html'))) {
    const contentTypes: Record<string, string> = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.webp': 'image/webp' };
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') return reply.code(404).send({ message: 'Recurso não encontrado.' });
      if (request.url.startsWith('/api/')) return reply.code(404).send({ message: 'Recurso não encontrado.' });
      let pathname: string;
      try { pathname = decodeURIComponent(new URL(request.url, config.origin).pathname); }
      catch { return reply.code(400).send({ message: 'Caminho inválido.' }); }
      const relativePath = pathname.replace(/^\/+/, '');
      const candidate = path.resolve(webRoot, relativePath || 'index.html');
      if (candidate !== webRoot && !candidate.startsWith(`${webRoot}${path.sep}`)) return reply.code(404).send({ message: 'Recurso não encontrado.' });
      const file = existsSync(candidate) ? candidate : path.join(webRoot, 'index.html');
      try {
        const contents = await readFile(file);
        reply.type(contentTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
        if (path.basename(file) === 'index.html') reply.header('Cache-Control', 'no-cache');
        return request.method === 'HEAD' ? reply.send() : reply.send(contents);
      } catch { return reply.code(404).send({ message: 'Recurso não encontrado.' }); }
    });
  }
  return app;
}
