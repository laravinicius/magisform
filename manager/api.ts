import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { verify as verifyPassword } from '@node-rs/argon2';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { matchingTotpStep } from './totp.js';
import type { CreateTenantInput, TenantAction, TenantControl } from './contracts.js';

type Operator = { username: string; passwordHash: string; totpSecret: string };
type ApiConfig = { origin: string; secure: boolean; allowHostWithoutPort?: boolean; trustProxy: false | string[]; agentOrigin: string; agentToken: string; port: number; operatorFile: string; approvedImages: string[]; testDomainSuffix?: string; originPortSuffix?: string; publicMode?: boolean; webRoot?: string };
type BuildOptions = { config: ApiConfig; control?: TenantControl; operator?: Operator };
const loginBody = z.object({ username: z.string().trim().min(1).max(100), password: z.string().min(1).max(255), totp: z.string().regex(/^\d{6}$/) });
const createBody = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/), host: z.string().trim().toLowerCase().min(4).max(253), name: z.string().trim().regex(/^[\p{L}\p{N}][\p{L}\p{N} .,'()&-]{0,79}$/u), adminName: z.string().trim().min(1).max(120), adminUsername: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,50}$/), image: z.string().regex(/^(?:[a-z0-9][a-z0-9._/:@-]*@sha256:[a-f0-9]{64}|magisform:git-[a-f0-9]{7,40})$/) });
const actionBody = z.object({ action: z.enum(['start', 'stop', 'restart']) });
const cookieOpts = (secure: boolean) => ({ path: '/', httpOnly: false, secure, sameSite: 'strict' as const });
const safeEqual = (a: string, b: string) => { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export async function buildManagerApi({ config, control, operator: suppliedOperator }: BuildOptions): Promise<FastifyInstance> {
  const operator = suppliedOperator ?? JSON.parse(await readFile(config.operatorFile, 'utf8')) as Operator;
  if (!operator.username || !operator.passwordHash.startsWith('$argon2id$') || !operator.totpSecret) throw new Error('Arquivo de operador inválido.');
  const sessions = new Map<string, { username: string; createdAt: number; lastSeen: number }>();
  let lastTotpStep = -1;
  const app = Fastify({
    logger: { level: 'info', redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["set-cookie"]', 'req.body', 'res.headers["set-cookie"]'], censor: '[REDACTED]' }, serializers: { req: (request) => ({ method: request.method, url: request.url.split('?')[0] }) } },
    bodyLimit: 64 * 1024, genReqId: () => randomBytes(12).toString('hex'), trustProxy: config.trustProxy,
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });
  const sessionCookie = config.secure ? '__Host-mf_manager_session' : 'mf_manager_dev_session';
  const csrfCookie = config.secure ? '__Host-mf_manager_csrf' : 'mf_manager_dev_csrf';
  const allowedOrigin = new URL(config.origin).origin;

  app.addHook('onRequest', async (request, reply) => {
    const remoteAddress = request.raw.socket.remoteAddress?.replace(/^::ffff:/, '');
    if (request.url.split('?')[0] === '/health/live' && (remoteAddress === '::1' || remoteAddress === '127.0.0.1' || Boolean(remoteAddress?.startsWith('127.')))) return;
    const canonicalOrigin = new URL(config.origin);
    const hostMatches = request.headers.host === canonicalOrigin.host || (config.allowHostWithoutPort && request.headers.host === canonicalOrigin.hostname);
    if (config.secure && (!hostMatches || request.protocol !== 'https')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Recurso não encontrado.', requestId: request.id } });
    if (request.method === 'POST' && request.url.startsWith('/api/')) {
      if (request.headers.origin !== allowedOrigin) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Origem inválida.', requestId: request.id } });
      const csrf = request.cookies[csrfCookie]; const header = request.headers['x-csrf-token'];
      if (!csrf || typeof header !== 'string' || !safeEqual(csrf, header)) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Validação CSRF inválida.', requestId: request.id } });
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const err = error as Error & { statusCode?: number };
    const status = err.statusCode ?? (error instanceof z.ZodError ? 400 : 500);
    const message = error instanceof z.ZodError ? 'Confira os campos: identificador, domínio, empresa, administrador e versão aprovada.' : status >= 500 ? 'Serviço temporariamente indisponível.' : err.message;
    if (status >= 500) request.log.error({ requestId: request.id, operation: `${request.method} ${request.url.split('?')[0]}`, errorType: err.name }, 'Falha no painel de gestão');
    return reply.code(status).send({ error: { code: status === 400 ? 'VALIDATION_ERROR' : status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT' : 'UNAVAILABLE', message, requestId: request.id } });
  });

  const authenticated = async (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const token = request.cookies[sessionCookie];
    if (!token) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Autenticação necessária.', requestId: request.id } });
    const key = digest(token); const session = sessions.get(key); const now = Date.now();
    if (!session || now - session.lastSeen > 4 * 60 * 60_000 || now - session.createdAt > 8 * 60 * 60_000) {
      sessions.delete(key);
      reply.clearCookie(sessionCookie, { path: '/', secure: config.secure, sameSite: 'strict' });
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Sessão expirada.', requestId: request.id } });
    }
    session.lastSeen = now;
    (request as typeof request & { managerOperator?: string }).managerOperator = session.username;
  };
  const operatorFor = (request: import('fastify').FastifyRequest) => (request as typeof request & { managerOperator?: string }).managerOperator ?? 'operador';
  const remote = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(`${config.agentOrigin}${path}`, { method, headers: { authorization: `Bearer ${config.agentToken}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10 * 60_000) });
    const result = await response.json() as { data?: T; error?: string };
    if (!response.ok || result.data === undefined) throw Object.assign(new Error(response.ok ? 'Resposta inválida do executor.' : (result.error ?? 'Executor indisponível.')), { statusCode: response.status === 401 ? 503 : response.status });
    return result.data;
  };

  app.get('/api/manager/v1/auth/csrf', async (_request, reply) => {
    const token = randomBytes(32).toString('base64url'); reply.setCookie(csrfCookie, token, cookieOpts(config.secure)); return { data: { csrfToken: token } };
  });
  app.post('/api/manager/v1/auth/login', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const input = loginBody.parse(request.body);
    let passwordOk = false;
    try { passwordOk = await verifyPassword(operator.passwordHash, input.password); } catch { passwordOk = false; }
    const totpStep = matchingTotpStep(operator.totpSecret, input.totp);
    if (input.username.toLowerCase() !== operator.username.toLowerCase() || !passwordOk || totpStep === null || totpStep <= lastTotpStep) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Credenciais inválidas.', requestId: request.id } });
    lastTotpStep = totpStep;
    const token = randomBytes(32).toString('base64url'); const now = Date.now(); sessions.set(digest(token), { username: operator.username, createdAt: now, lastSeen: now });
    reply.setCookie(sessionCookie, token, { path: '/', httpOnly: true, secure: config.secure, sameSite: 'strict' });
    request.log.info({ requestId: request.id, action: 'login_succeeded' }, 'Operador autenticado');
    return { data: { username: operator.username } };
  });
  app.get('/api/manager/v1/auth/me', { preHandler: authenticated }, async (request) => ({ data: { username: (request as typeof request & { managerOperator?: string }).managerOperator } }));
  app.post('/api/manager/v1/auth/logout', { preHandler: authenticated }, async (request, reply) => {
    const token = request.cookies[sessionCookie]; if (token) sessions.delete(digest(token));
    reply.clearCookie(sessionCookie, { path: '/', secure: config.secure, sameSite: 'strict' });
    request.log.info({ requestId: request.id, action: 'logout' }, 'Operador encerrou sessão');
    return { data: { success: true } };
  });
  app.get('/api/manager/v1/installations', { preHandler: authenticated }, async () => ({ data: control ? await control.list() : await remote('/internal/installations') }));
  app.post('/api/manager/v1/installations', { preHandler: authenticated }, async (request, reply) => {
    const input = createBody.parse(request.body) as CreateTenantInput;
    try {
      const result = control ? await control.create(input) : await remote<{ admin: { name: string; username: string; password: string } }>('/internal/installations', 'POST', input);
      request.log.info({ requestId: request.id, operator: operatorFor(request), action: 'installation_created', tenant: input.id, outcome: 'success' }, 'Instalação provisionada');
      reply.code(201); return { data: result };
    } catch (error) {
      request.log.warn({ requestId: request.id, operator: operatorFor(request), action: 'installation_created', tenant: input.id, outcome: 'failure', errorType: error instanceof Error ? error.name : 'UnknownError' }, 'Falha ao provisionar instalação');
      throw error;
    }
  });
  app.post('/api/manager/v1/installations/:id/actions', { preHandler: authenticated }, async (request) => {
    const params = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/) }).parse(request.params); const { action } = actionBody.parse(request.body) as { action: TenantAction };
    try {
      if (control) await control.action(params.id, action); else await remote(`/internal/installations/${params.id}/actions`, 'POST', { action });
      request.log.info({ requestId: request.id, operator: operatorFor(request), action: `tenant_${action}`, tenant: params.id, outcome: 'success' }, 'Operação de instalação concluída');
      return { data: { success: true } };
    } catch (error) {
      request.log.warn({ requestId: request.id, operator: operatorFor(request), action: `tenant_${action}`, tenant: params.id, outcome: 'failure', errorType: error instanceof Error ? error.name : 'UnknownError' }, 'Falha na operação da instalação');
      throw error;
    }
  });
  app.post('/api/manager/v1/installations/package', { preHandler: authenticated }, async (request) => {
    const input = createBody.parse(request.body) as CreateTenantInput;
    const result = control ? await control.generate(input) : await remote('/internal/installations/package', 'POST', input);
    request.log.info({ requestId: request.id, operator: operatorFor(request), action: 'tenant_package_generated', tenant: input.id }, 'Pacote Docker gerado');
    return { data: result };
  });
  app.get('/api/manager/v1/config', { preHandler: authenticated }, async () => ({ data: { approvedImages: config.approvedImages, testDomainSuffix: config.testDomainSuffix ?? '.magisform.test', originPortSuffix: config.originPortSuffix ?? '', publicMode: config.publicMode ?? false } }));
  app.get('/health/live', async () => ({ data: { status: 'ok' } }));
  const webRoot = path.resolve(config.webRoot ?? 'dist-manager');
  const serveFile = async (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Recurso não encontrado.', requestId: request.id } });
    let requested = decodeURIComponent(request.url.split('?')[0]).replace(/^\/+/, '');
    if (!requested || requested.endsWith('/')) requested += 'index.html';
    let file = path.resolve(webRoot, requested);
    if (!file.startsWith(`${webRoot}${path.sep}`)) return reply.code(404).send();
    try { await readFile(file); } catch { file = path.join(webRoot, 'index.html'); }
    const content = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    const type = ext === '.js' ? 'text/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : ext === '.svg' ? 'image/svg+xml' : ext === '.woff' ? 'font/woff' : ext === '.png' ? 'image/png' : ext === '.ico' ? 'image/x-icon' : 'text/html; charset=utf-8';
    return reply.header('cache-control', file.endsWith('index.html') ? 'no-store' : 'public, max-age=3600').type(type).send(content);
  };
  app.get('/', serveFile);
  app.get('/*', serveFile);
  return app;
}
