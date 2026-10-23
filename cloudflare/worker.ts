/// <reference path="./worker-configuration.d.ts" />
type Tenant = { id: number; slug: string; name: string; status: string; brand: string; brand_theme: string };
type Identity = { issuer: string; subject: string; email: string; name: string };
type TenantUser = { id: number; name: string; username: string; role: string };

interface AccessClaims { iss: string; sub: string; aud: string[]; exp: number; email?: string; name?: string }
const encoder = new TextEncoder();
const accessKeys = new Map<string, { expiresAt: number; key: CryptoKey }>();
let accessKeysRefresh: Promise<Map<string, CryptoKey> | null> | null = null;
const json = (body: unknown, status = 200, init?: HeadersInit) => {
  const headers = new Headers(init);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers });
};

function decodeBase64Url(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function accessIdentity(request: Request, env: Env): Promise<Identity | null> {
  const jwt = request.headers.get('cf-access-jwt-assertion');
  if (!jwt) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = jwt.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedHeader))) as { alg?: string; kid?: string };
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedPayload))) as AccessClaims;
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== 'RS256' || !header.kid || claims.iss !== issuer || !claims.sub || !claims.aud?.includes(env.ACCESS_AUD) || !claims.exp || claims.exp <= now || (claims as AccessClaims & { nbf?: number }).nbf !== undefined && (claims as AccessClaims & { nbf?: number }).nbf! > now + 60) return null;
    const cacheKey = `${issuer}:${header.kid}`;
    let key = accessKeys.get(cacheKey);
    if (!key || key.expiresAt <= now) {
      if (!accessKeysRefresh) accessKeysRefresh = (async () => {
        const response = await fetch(`${issuer}/cdn-cgi/access/certs`, { headers: { accept: 'application/json' } });
        if (!response.ok) return null;
        const jwks = await response.json() as { keys: (JsonWebKey & { kid?: string })[] };
        const parsed = new Map<string, CryptoKey>();
        for (const jwk of jwks.keys.slice(0, 20)) {
          if (!jwk.kid || jwk.kty !== 'RSA' || jwk.alg && jwk.alg !== 'RS256') continue;
          try { parsed.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])); } catch { /* chave incompatível */ }
        }
        accessKeys.clear();
        for (const [kid, publicKey] of parsed) accessKeys.set(`${issuer}:${kid}`, { key: publicKey, expiresAt: now + 300 });
        return parsed;
      })().catch(() => null).finally(() => { accessKeysRefresh = null; });
      await accessKeysRefresh;
      key = accessKeys.get(cacheKey);
    }
    if (!key) return null;
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key.key, decodeBase64Url(encodedSignature), encoder.encode(`${encodedHeader}.${encodedPayload}`));
    return valid && claims.email ? {
      issuer: claims.iss,
      subject: claims.sub,
      email: claims.email.trim().toLowerCase(),
      name: claims.name?.trim() || claims.email.trim(),
    } : null;
  } catch { return null; }
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function databaseId(): number {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return (words[0] & 0x1fffff) * 0x100000000 + words[1];
}

function tenantPath(pathname: string): { slug: string; rest: string } | null {
  const match = pathname.match(/^\/t\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\/.*)?$/);
  return match ? { slug: match[1], rest: match[2] ?? '/' } : null;
}

const error = (code: string, message: string, status: number, requestId: string) =>
  json({ error: { code, message, requestId } }, status);

function cookies(request: Request): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of request.headers.get('cookie')?.split(';') ?? []) {
    const [name, ...value] = part.trim().split('=');
    if (!name || result.has(name)) throw new Error('Cabeçalho de cookie ambíguo.');
    result.set(name, decodeURIComponent(value.join('=')));
  }
  return result;
}

async function issueCsrf(tenant: Tenant): Promise<Response> {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const headers = new Headers();
  headers.append('set-cookie', `__Secure-magisform_csrf=${token}; Path=/t/${tenant.slug}; Secure; SameSite=Lax`);
  return json({ data: { csrfToken: token } }, 200, headers);
}

function verifyMutation(request: Request, tenant: Tenant, csrf: string | undefined, scopePath=`/t/${tenant.slug}/`): Response | null {
  if (request.headers.get('origin') !== new URL(request.url).origin) {
    return error('ORIGIN_INVALID', 'Origem da solicitação inválida.', 403, request.headers.get('cf-ray') ?? crypto.randomUUID());
  }
  const supplied = request.headers.get('x-csrf-token') ?? '';
  if (!csrf || !supplied || csrf !== supplied || !new URL(request.url).pathname.startsWith(scopePath)) {
    return error('CSRF_INVALID', 'Token de segurança inválido.', 403, request.headers.get('cf-ray') ?? crypto.randomUUID());
  }
  return null;
}

async function tenantUser(env: Env, tenant: Tenant, identity: Identity): Promise<TenantUser | null> {
  const linked = await env.DB.prepare(`SELECT u.id,u.name,u.username,u.role
    FROM users u JOIN identities i ON i.id=u.identity_id
    WHERE u.tenant_id=? AND i.access_issuer=? AND i.access_subject=? AND u.active=1`)
    .bind(tenant.id, identity.issuer, identity.subject).first<TenantUser>();
  if (linked) return linked;

  const invitation = await env.DB.prepare(`SELECT u.id FROM users u JOIN invitations v
    ON v.tenant_id=u.tenant_id AND v.user_id=u.id
    WHERE u.tenant_id=? AND lower(v.email)=? AND u.identity_id IS NULL AND u.active=0
      AND v.accepted_at IS NULL AND v.revoked_at IS NULL AND v.expires_at>CURRENT_TIMESTAMP`)
    .bind(tenant.id, identity.email).first<{ id: number }>();
  if (!invitation) return null;

  const identityId = databaseId();
  const auditId = databaseId();
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO identities(id,access_issuer,access_subject,current_email,display_name)
      VALUES(?,?,?,?,?) ON CONFLICT(access_issuer,access_subject) DO NOTHING`)
      .bind(identityId, identity.issuer, identity.subject, identity.email, identity.name),
    env.DB.prepare(`UPDATE users SET identity_id=(SELECT id FROM identities WHERE access_issuer=? AND access_subject=?),
      active=1,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=? AND id=? AND identity_id IS NULL AND active=0
      AND EXISTS(SELECT 1 FROM invitations WHERE tenant_id=? AND user_id=? AND lower(email)=?
        AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>CURRENT_TIMESTAMP)`)
      .bind(identity.issuer, identity.subject, tenant.id, invitation.id, tenant.id, invitation.id, identity.email),
    env.DB.prepare(`UPDATE invitations SET accepted_at=CURRENT_TIMESTAMP WHERE tenant_id=? AND user_id=?
      AND accepted_at IS NULL AND revoked_at IS NULL AND lower(email)=?
      AND EXISTS(SELECT 1 FROM users WHERE tenant_id=? AND id=? AND identity_id=(SELECT id FROM identities WHERE access_issuer=? AND access_subject=?))`)
      .bind(tenant.id, invitation.id, identity.email, tenant.id, invitation.id, identity.issuer, identity.subject),
    env.DB.prepare(`INSERT INTO action_logs(id,tenant_id,user_id,user_name,action,entity,entity_id,details)
      SELECT ?,u.tenant_id,u.id,u.name,'invite_accepted','users',u.id,NULL FROM users u
      WHERE changes()=1 AND u.tenant_id=? AND u.id=? AND u.identity_id=(SELECT id FROM identities WHERE access_issuer=? AND access_subject=?)`)
      .bind(auditId, tenant.id, invitation.id, identity.issuer, identity.subject),
  ]);
  if (!results[1]?.meta?.changes) return null;
  return env.DB.prepare(`SELECT u.id,u.name,u.username,u.role FROM users u JOIN identities i ON i.id=u.identity_id
    WHERE u.tenant_id=? AND i.access_issuer=? AND i.access_subject=? AND u.active=1`)
    .bind(tenant.id, identity.issuer, identity.subject).first<TenantUser>();
}

async function createSession(request: Request, env: Env, tenant: Tenant, user: TenantUser): Promise<Response> {
  let submittedCookies: Map<string, string>;
  try { submittedCookies = cookies(request); }
  catch { return error('COOKIE_INVALID', 'Cabeçalho de cookie ambíguo.', 400, crypto.randomUUID()); }
  const invalidMutation = verifyMutation(request, tenant, submittedCookies.get('__Secure-magisform_csrf'));
  if (invalidMutation) return invalidMutation;
  const force = (await request.clone().json().catch(() => ({})) as { force?: boolean }).force === true;
  const existing = await env.DB.prepare("SELECT id FROM sessions WHERE tenant_id=? AND user_id=? AND expires_at>CURRENT_TIMESTAMP AND absolute_expires_at>CURRENT_TIMESTAMP")
    .bind(tenant.id, user.id).first<{ id: number }>();
  if (existing && !force) return error('SESSION_CONFLICT', 'Já existe uma sessão ativa. Confirme a entrada para encerrá-la.', 409, crypto.randomUUID());

  const token = crypto.randomUUID() + crypto.randomUUID();
  const csrf = crypto.randomUUID() + crypto.randomUUID();
  await env.DB.prepare("INSERT INTO sessions(tenant_id,user_id,token_hash,csrf_hash,expires_at,absolute_expires_at) VALUES(?,?,?,?,datetime('now','+8 hours'),datetime('now','+24 hours')) ON CONFLICT(tenant_id,user_id) DO UPDATE SET token_hash=excluded.token_hash,csrf_hash=excluded.csrf_hash,created_at=CURRENT_TIMESTAMP,last_seen=CURRENT_TIMESTAMP,expires_at=excluded.expires_at,absolute_expires_at=excluded.absolute_expires_at")
    .bind(tenant.id, user.id, await digest(token), await digest(csrf)).run();

  const headers = new Headers();
  headers.append('set-cookie', `__Secure-magisform_session=${token}; Path=/t/${tenant.slug}; HttpOnly; Secure; SameSite=Lax`);
  headers.append('set-cookie', `__Secure-magisform_csrf=${csrf}; Path=/t/${tenant.slug}; Secure; SameSite=Lax`);
  return json({ data: { user, csrfToken: csrf } }, 200, headers);
}

async function handleApi(request: Request, env: Env, tenant: Tenant, path: string, identity: Identity | null): Promise<Response> {
  const requestId = request.headers.get('cf-ray') ?? crypto.randomUUID();
  if (path === '/health/live' && request.method === 'GET') return json({ data: { status: 'ok' } });
  if (path === '/public-config' && request.method === 'GET') {
    try { return json({ data: { installationName: tenant.name, brand: tenant.brand, brandTheme: JSON.parse(tenant.brand_theme), version: '0.2.8', capabilities: ['workers-pilot'] } }); }
    catch { return error('UNAVAILABLE', 'A marca desta instalação está inválida.', 503, requestId); }
  }
  if (tenant.status !== 'active') return error('TENANT_SUSPENDED', 'Esta instalação está suspensa.', 403, requestId);
  if (!identity) return error('UNAUTHENTICATED', 'Identidade Cloudflare Access obrigatória.', 401, requestId);
  if (path === '/auth/csrf' && request.method === 'GET') return issueCsrf(tenant);
  if (path === '/auth/login' && request.method === 'POST') {
    const invitedUser=await tenantUser(env,tenant,identity);
    if(!invitedUser)return error('FORBIDDEN','Identidade sem vínculo ou convite válido nesta farmácia.',403,requestId);
    return createSession(request,env,tenant,invitedUser);
  }
  const user = await tenantUser(env, tenant, identity);
  if (!user) return error('FORBIDDEN', 'Identidade sem vínculo nesta farmácia.', 403, requestId);
  let requestCookies: Map<string, string>;
  try { requestCookies = cookies(request); }
  catch { return error('COOKIE_INVALID', 'Cabeçalho de cookie ambíguo.', 400, requestId); }
  const sessionToken = requestCookies.get('__Secure-magisform_session');
  if (!sessionToken) return error('UNAUTHENTICATED', 'Sessão inválida ou expirada.', 401, requestId);
  const session = await env.DB.prepare('SELECT id,csrf_hash FROM sessions WHERE tenant_id=? AND user_id=? AND token_hash=? AND expires_at>CURRENT_TIMESTAMP AND absolute_expires_at>CURRENT_TIMESTAMP')
    .bind(tenant.id, user.id, await digest(sessionToken)).first<{ id: number; csrf_hash: string }>();
  if (!session) return error('UNAUTHENTICATED', 'Sessão inválida ou expirada.', 401, requestId);
  if (path === '/auth/me' && request.method === 'GET') return json({ data: { authenticated: true, user } });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const invalidMutation = verifyMutation(request, tenant, requestCookies.get('__Secure-magisform_csrf'));
    if (invalidMutation) return invalidMutation;
    const csrf = request.headers.get('x-csrf-token') ?? '';
    if (await digest(csrf) !== session.csrf_hash) return error('CSRF_INVALID', 'Token de segurança inválido.', 403, requestId);
  }
  if (path === '/auth/heartbeat' && request.method === 'POST') return json({ data: { valid: true } });
  if (path === '/auth/logout' && request.method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE id=?').bind(session.id).run();
    const headers = new Headers();
    headers.append('set-cookie', `__Secure-magisform_session=; Path=/t/${tenant.slug}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    headers.append('set-cookie', `__Secure-magisform_csrf=; Path=/t/${tenant.slug}; Secure; SameSite=Lax; Max-Age=0`);
    return json({ data: { success: true } }, 200, headers);
  }
  if (request.headers.get('x-magisform-activity') === 'user') {
    await env.DB.prepare("UPDATE sessions SET last_seen=CURRENT_TIMESTAMP, expires_at=datetime('now','+8 hours') WHERE id=? AND last_seen<datetime('now','-1 minute')").bind(session.id).run();
  }
  return handleBusiness(request, env, tenant, path, user, requestId);
}

function positiveId(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function encodeCursor(value: unknown): string {
  const bytes=encoder.encode(JSON.stringify(value));
  let binary=''; for (const byte of bytes) binary+=String.fromCharCode(byte);
  return btoa(binary).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

function decodeCursor(value: string): unknown {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

function deliveryTimestamp(): string {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(part=>[part.type,part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function formulaItemJson(items: unknown[]): string {
  return JSON.stringify(items.map((row:any)=>({id:databaseId(),insumo_id:Number(row.insumo_id),quantity:Number(row.quantity),unit:typeof row.unit==='string' ? row.unit : 'mg'})));
}

function budgetItemJson(items: unknown[]): string {
  return JSON.stringify(items.map((row:any)=>({id:databaseId(),quantity:Number(row.quantity),unit:String(row.unit ?? 'caps'),value:Number(row.value),is_selected:row.is_selected ? 1 : 0})));
}

function insertFormulaItems(env:Env,tenantId:number,formulaId:number,jsonValue:string) {
  return env.DB.prepare(`INSERT INTO formula_items(id,tenant_id,formula_id,insumo_id,quantity,unit)
    SELECT CAST(json_extract(value,'$.id') AS INTEGER),?, ?,CAST(json_extract(value,'$.insumo_id') AS INTEGER),CAST(json_extract(value,'$.quantity') AS REAL),json_extract(value,'$.unit') FROM json_each(?)`)
    .bind(tenantId,formulaId,jsonValue);
}

function insertBudgetItems(env:Env,tenantId:number,formulaId:number,jsonValue:string) {
  return env.DB.prepare(`INSERT INTO formula_budget_items(id,tenant_id,formula_id,quantity,unit,value,is_selected)
    SELECT CAST(json_extract(value,'$.id') AS INTEGER),?, ?,CAST(json_extract(value,'$.quantity') AS REAL),json_extract(value,'$.unit'),CAST(json_extract(value,'$.value') AS REAL),CAST(json_extract(value,'$.is_selected') AS INTEGER) FROM json_each(?)`)
    .bind(tenantId,formulaId,jsonValue);
}

function validateFormulaInput(body:Record<string,unknown> | null) {
  const items=Array.isArray(body?.items) ? body.items : [];
  const budgets=Array.isArray(body?.budget_items) ? body.budget_items : [];
  const customerId=positiveId(String(body?.customer_id ?? ''));
  const status=body?.status ?? 'pending';
  const validItems=items.length>0 && items.length<=200 && items.every((row:any)=>row && typeof row==='object' && positiveId(String(row.insumo_id)) && Number.isFinite(row.quantity) && row.quantity>0 && (row.unit===undefined || typeof row.unit==='string' && row.unit.length<=40));
  const validBudgets=budgets.length<=50 && budgets.every((row:any)=>row && typeof row==='object' && Number.isFinite(row.quantity) && row.quantity>0 && typeof row.unit==='string' && row.unit.length<=40 && Number.isFinite(row.value) && row.value>=0);
  if (!customerId || typeof body?.attendant_name!=='string' || !body.attendant_name.trim() || body.attendant_name.length>255 || !validItems || !validBudgets || !['pending','confirmed','cancelled','delivered'].includes(String(status))) return null;
  if (body.payment_status!==undefined && typeof body.payment_status!=='string') return null;
  if (body.partial_payment_amount!==undefined && body.partial_payment_amount!==null && (!Number.isFinite(body.partial_payment_amount) || Number(body.partial_payment_amount)<0)) return null;
  if (body.delivery_date!==undefined && body.delivery_date!==null && (typeof body.delivery_date!=='string' || body.delivery_date.length>40)) return null;
  return {customerId,attendant:body.attendant_name.trim(),items,budgets,status:String(status),budgetNumber:typeof body.budget_number==='string' ? body.budget_number.trim().slice(0,20) : '',paymentStatus:typeof body.payment_status==='string' ? body.payment_status.slice(0,30) : '',partialAmount:typeof body.partial_payment_amount==='number' ? body.partial_payment_amount : null,paymentMethod:typeof body.payment_method==='string' ? body.payment_method.slice(0,40) : null,deliveryStatus:typeof body.delivery_status==='string' ? body.delivery_status.slice(0,40) : '',delivery_date:typeof body.delivery_date==='string' ? body.delivery_date : null,cancel_reason:typeof body.cancel_reason==='string' ? body.cancel_reason.slice(0,2000) : null};
}

async function attachFormulaChildren(env:Env,tenantId:number,rows:any[]) {
  if (!rows.length) return rows;
  const ids=rows.map(row=>Number(row.id)); const placeholders=ids.map(()=>'?').join(',');
  const [items,budgets]=await Promise.all([
    env.DB.prepare(`SELECT fi.formula_id,fi.insumo_id,i.name AS insumo_name,fi.quantity,fi.unit FROM formula_items fi JOIN insumos i ON i.tenant_id=fi.tenant_id AND i.id=fi.insumo_id WHERE fi.tenant_id=? AND fi.formula_id IN (${placeholders}) ORDER BY fi.id`).bind(tenantId,...ids).all<any>(),
    env.DB.prepare(`SELECT formula_id,quantity,unit,value,is_selected FROM formula_budget_items WHERE tenant_id=? AND formula_id IN (${placeholders}) ORDER BY id`).bind(tenantId,...ids).all<any>(),
  ]);
  const byFormula=new Map<number,any[]>(); const byBudget=new Map<number,any[]>();
  for(const row of items.results){const list=byFormula.get(row.formula_id) ?? [];list.push(row);byFormula.set(row.formula_id,list);}
  for(const row of budgets.results){const list=byBudget.get(row.formula_id) ?? [];list.push({...row,quantity:Number(row.quantity),value:Number(row.value)});byBudget.set(row.formula_id,list);}
  for(const row of rows){row.items=byFormula.get(row.id) ?? [];row.budget_items=byBudget.get(row.id) ?? [];row.manager_verified=Boolean(row.manager_verified);}
  return rows;
}

async function loadFormula(env:Env,tenantId:number,id:number) {
  const row=await env.DB.prepare(`SELECT f.id,f.customer_id,c.name AS customer_name,r.name AS responsible_name,COALESCE(f.customer_phone,'') AS customer_phone,COALESCE(f.attendant_name,'') AS attendant_name,f.created_by_name,COALESCE(f.budget_number,'') AS budget_number,f.delivery_date,f.delivered_at,COALESCE(f.payment_status,'') AS payment_status,f.partial_payment_amount,f.payment_method,COALESCE(f.delivery_status,'') AS delivery_status,f.manager_verified,f.cancel_reason,f.status,f.created_at FROM formulas f JOIN customers c ON c.tenant_id=f.tenant_id AND c.id=f.customer_id LEFT JOIN customers r ON r.tenant_id=c.tenant_id AND r.id=c.responsible_id WHERE f.tenant_id=? AND f.id=?`).bind(tenantId,id).first<any>();
  if (!row) return null;
  await attachFormulaChildren(env,tenantId,[row]);
  return row;
}

async function bodyObject(request: Request): Promise<Record<string, unknown> | null> {
  const value: unknown = await request.json().catch(() => null);
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function canWrite(user: TenantUser): boolean { return user.role !== 'employee'; }
function canManageUsers(user: TenantUser): boolean { return user.role !== 'employee'; }
function canViewPrivileged(user: TenantUser): boolean { return ['admin','manager','pharmacist'].includes(user.role); }

async function audit(env: Env, tenant: Tenant, user: TenantUser, action: string, entity: string, entityId: number | null, details: string | null = null) {
  await env.DB.prepare('INSERT INTO action_logs(id,tenant_id,user_id,user_name,action,entity,entity_id,details) VALUES(?,?,?,?,?,?,?,?)')
    .bind(databaseId(), tenant.id, user.id, user.name, action, entity, entityId, details).run();
}

function auditInsert(env: Env, tenant: Tenant, user: TenantUser, action: string, entity: string, entityId: number, details: string | null = null) {
  return env.DB.prepare('INSERT INTO action_logs(id,tenant_id,user_id,user_name,action,entity,entity_id,details) VALUES(?,?,?,?,?,?,?,?)')
    .bind(databaseId(), tenant.id, user.id, user.name, action, entity, entityId, details);
}

async function handleBusiness(request: Request, env: Env, tenant: Tenant, path: string, user: TenantUser, requestId: string): Promise<Response> {
  const method = request.method;
  const [resource, idPart, action] = path.split('/').filter(Boolean);
  const id = positiveId(idPart);
  const notFound = () => error('NOT_FOUND', 'Registro não encontrado.', 404, requestId);
  const forbidden = () => error('FORBIDDEN', 'Seu perfil não pode realizar esta ação.', 403, requestId);
  const invalid = () => error('VALIDATION_ERROR', 'Os dados enviados são inválidos.', 400, requestId);

  if (resource === 'users') {
    if (!canManageUsers(user)) return forbidden();
    if (!id && method === 'GET') {
      const rows = await env.DB.prepare('SELECT id,name,email AS username,role FROM users WHERE tenant_id=? ORDER BY name LIMIT 500').bind(tenant.id).all();
      return json({ data: rows.results });
    }
    if (!id && method === 'POST') {
      const body = await bodyObject(request);
      const name = typeof body?.name === 'string' ? body.name.trim().slice(0,120) : '';
      const email = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
      const role = typeof body?.role === 'string' ? body.role : '';
      if (!name || !/^\S+@\S+\.\S+$/.test(email) || !['admin','manager','pharmacist','employee'].includes(role)) return invalid();
      if (user.role !== 'admin' && role === 'admin') return forbidden();
      const userId = databaseId();
      const invitationId = databaseId();
      const auditId = databaseId();
      try {
        const results = await env.DB.batch([
          env.DB.prepare("INSERT INTO users(id,tenant_id,email,name,username,role,active) VALUES(?,?,?,?,?,?,0)").bind(userId,tenant.id,email,name,email,role),
          env.DB.prepare("INSERT INTO invitations(id,tenant_id,user_id,email,expires_at) VALUES(?,?,?,?,datetime('now','+7 days'))").bind(invitationId,tenant.id,userId,email),
          env.DB.prepare("INSERT INTO action_logs(id,tenant_id,user_id,user_name,action,entity,entity_id,details) VALUES(?,?,?,?,'invite','users',?,?)").bind(auditId,tenant.id,user.id,user.name,userId,JSON.stringify({email,role})),
        ]);
        if (!results[0]?.success) return invalid();
      } catch { return error('CONFLICT','Este e-mail já está cadastrado nesta farmácia.',409,requestId); }
      return json({ data: { success: true, id: userId } }, 201);
    }
    if (id && method === 'PATCH') {
      const body = await bodyObject(request);
      if (!body || (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) || (body.role !== undefined && !['admin','manager','pharmacist','employee'].includes(String(body.role)))) return invalid();
      const target = await env.DB.prepare('SELECT id,role FROM users WHERE tenant_id=? AND id=?').bind(tenant.id,id).first<{id:number;role:string}>();
      if (!target) return notFound();
      if (user.role !== 'admin' && (target.role === 'admin' || body.role === 'admin')) return forbidden();
      const role = body.role === undefined ? target.role : String(body.role);
      const name = body.name === undefined ? undefined : String(body.name).trim().slice(0,120);
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET name=COALESCE(?,name),role=?,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=? AND id=?').bind(name ?? null,role,tenant.id,id),
        auditInsert(env,tenant,user,'update','users',id,JSON.stringify({role})),
      ]);
      return json({ data: { success: true,id } });
    }
    if (id && method === 'DELETE') {
      const target = await env.DB.prepare('SELECT id,role,active FROM users WHERE tenant_id=? AND id=?').bind(tenant.id,id).first<{id:number;role:string;active:number}>();
      if (!target) return notFound();
      if (id === user.id || (user.role !== 'admin' && target.role === 'admin')) return forbidden();
      if (target.role === 'admin' && target.active) {
        const admins = await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE tenant_id=? AND role='admin' AND active=1").bind(tenant.id).first<{count:number}>();
        if ((admins?.count ?? 0) <= 1) return error('CONFLICT','A farmácia precisa manter ao menos um administrador ativo.',409,requestId);
      }
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET active=0,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=? AND id=?').bind(tenant.id,id),
        env.DB.prepare('DELETE FROM sessions WHERE tenant_id=? AND user_id=?').bind(tenant.id,id),
        env.DB.prepare('UPDATE invitations SET revoked_at=CURRENT_TIMESTAMP WHERE tenant_id=? AND user_id=? AND accepted_at IS NULL').bind(tenant.id,id),
        env.DB.prepare("INSERT INTO action_logs(id,tenant_id,user_id,user_name,action,entity,entity_id) VALUES(?,?,?,?,'delete','users',?)").bind(databaseId(),tenant.id,user.id,user.name,id),
      ]);
      return json({ data: { success: true,id } });
    }
  }

  if (resource === 'customers' || resource === 'insumos') {
    const table = resource;
    const entity = resource;
    const label = resource === 'customers' ? 'Cliente' : 'Insumo';
    if (method === 'GET' && !id) {
      const rows = await env.DB.prepare(`SELECT * FROM ${table} WHERE tenant_id=? ORDER BY name LIMIT 1000`).bind(tenant.id).all();
      return json({ data: rows.results });
    }
    if (method === 'POST' && !id) {
      if (!canWrite(user)) return forbidden();
      const input = resource === 'insumos' ? await request.json().catch(()=>null) : await bodyObject(request);
      const nameValue = resource === 'insumos' ? input : (input as Record<string,unknown> | null)?.name;
      const name = typeof nameValue === 'string' ? nameValue.trim().slice(0,160) : '';
      if (!name) return invalid();
      const newId=databaseId();
      try {
        if (resource === 'customers') {
          const customer = input as Record<string,unknown>;
          const phone = typeof customer.phone === 'string' ? customer.phone.trim().slice(0,40) : null;
          const responsible = positiveId(String(customer.responsible_customer_id ?? ''));
          await env.DB.batch([
            env.DB.prepare('INSERT INTO customers(id,tenant_id,name,phone,responsible_id) VALUES(?,?,?,?,?)').bind(newId,tenant.id,name,phone,responsible),
            auditInsert(env,tenant,user,'add',entity,newId),
          ]);
        } else await env.DB.batch([
          env.DB.prepare('INSERT INTO insumos(id,tenant_id,name) VALUES(?,?,?)').bind(newId,tenant.id,name),
          auditInsert(env,tenant,user,'add',entity,newId),
        ]);
      } catch { return error('CONFLICT',`${label} duplicado ou referência inválida.`,409,requestId); }
      return json({data:{success:true,id:newId}},201);
    }
    if (id && method === 'PATCH') {
      if (!canWrite(user)) return forbidden();
      const input = resource === 'insumos' ? await request.json().catch(()=>null) : await bodyObject(request);
      const nameValue = resource === 'insumos' ? input : (input as Record<string,unknown> | null)?.name;
      const name = typeof nameValue === 'string' ? nameValue.trim().slice(0,160) : '';
      if (!name) return invalid();
      const row = await env.DB.prepare(`SELECT id FROM ${table} WHERE tenant_id=? AND id=?`).bind(tenant.id,id).first();
      if (!row) return notFound();
      try {
        if (resource === 'customers') {
          const customer = input as Record<string,unknown>;
          const phone = typeof customer.phone === 'string' ? customer.phone.trim().slice(0,40) : null;
          const responsible = positiveId(String(customer.responsible_customer_id ?? ''));
          await env.DB.batch([
            env.DB.prepare('UPDATE customers SET name=?,phone=?,responsible_id=?,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=? AND id=?').bind(name,phone,responsible,tenant.id,id),
            auditInsert(env,tenant,user,'update',entity,id),
          ]);
        } else await env.DB.batch([
          env.DB.prepare('UPDATE insumos SET name=?,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=? AND id=?').bind(name,tenant.id,id),
          auditInsert(env,tenant,user,'update',entity,id),
        ]);
      } catch { return error('CONFLICT',`${label} duplicado ou referência inválida.`,409,requestId); }
      return json({data:{success:true,id}});
    }
    if (id && method === 'DELETE') {
      if (user.role !== 'admin') return forbidden();
      try {
        const deletion = await env.DB.batch([
          env.DB.prepare(`DELETE FROM ${table} WHERE tenant_id=? AND id=?`).bind(tenant.id,id),
          auditInsert(env,tenant,user,'delete',entity,id),
        ]);
        if (!deletion[0]?.meta.changes) return notFound();
      } catch { return error('CONFLICT',`Não foi possível excluir: ${label.toLowerCase()} em uso.`,409,requestId); }
      return json({data:{success:true,id}});
    }
  }

  if (resource === 'formulas-summary' && method === 'GET') {
    const query=new URL(request.url).searchParams;
    const month=Number(query.get('month')); const year=Number(query.get('year'));
    const payment=query.get('paymentStatus') ?? 'pago';
    if (!Number.isInteger(month) || month<0 || month>11 || !Number.isInteger(year) || year<1900 || year>9999 || !['pago','parcial','pagar_na_retirada','nao_pago'].includes(payment)) return invalid();
    const [counts,monthly,years]=await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS total,SUM(status='pending') AS pending,SUM(status='confirmed') AS confirmed FROM formulas WHERE tenant_id=?").bind(tenant.id).first<any>(),
      env.DB.prepare(`SELECT COALESCE(SUM(CASE WHEN ?='parcial' THEN COALESCE(f.partial_payment_amount,0) ELSE (SELECT COALESCE(SUM(bi.value),0) FROM formula_budget_items bi WHERE bi.tenant_id=f.tenant_id AND bi.formula_id=f.id AND bi.is_selected=1) END),0) AS total
        FROM formulas f WHERE f.tenant_id=? AND (f.payment_status=? OR (?='nao_pago' AND COALESCE(f.payment_status,'')='')) AND f.delivery_status='entregue' AND CAST(substr(f.delivered_at,6,2) AS INTEGER)=? AND CAST(substr(f.delivered_at,1,4) AS INTEGER)=?`).bind(payment,tenant.id,payment,payment,month+1,year).first<any>(),
      env.DB.prepare('SELECT DISTINCT CAST(substr(delivered_at,1,4) AS INTEGER) AS year FROM formulas WHERE tenant_id=? AND delivered_at IS NOT NULL ORDER BY year DESC').bind(tenant.id).all<any>(),
    ]);
    return json({data:{total:Number(counts?.total ?? 0),pending:Number(counts?.pending ?? 0),confirmed:Number(counts?.confirmed ?? 0),deliveredMonthlyTotal:Number(monthly?.total ?? 0),deliveredYears:years.results.map((row:any)=>Number(row.year)).filter((value:number)=>value>1900)}});
  }

  if (resource === 'formulas') {
    if (id && action === undefined && method === 'GET') {
      const formula=await loadFormula(env,tenant.id,id);
      return formula ? json({data:formula}) : notFound();
    }
    if (!id && method === 'GET') {
      const query=new URL(request.url).searchParams;
      const limit=Number(query.get('limit') ?? 50);
      const statuses=(query.get('statuses') ?? '').split(',').filter(Boolean);
      const delivery=query.get('deliveryStatus') ?? '';
      const search=(query.get('search') ?? '').trim().slice(0,100);
      if (!Number.isInteger(limit) || limit<1 || limit>100 || statuses.some(value=>!['pending','confirmed','cancelled','delivered'].includes(value)) || delivery.length>40) return invalid();
      let fence:{d:string;i:number}|null=null; let before:{d:string;i:number}|null=null;
      const cursor=query.get('cursor');
      if (cursor) {
        try {
          const value=decodeCursor(cursor) as any;
          if (value?.v!==1 || typeof value.f?.d!=='string' || !Number.isSafeInteger(value.f?.i) || typeof value.b?.d!=='string' || !Number.isSafeInteger(value.b?.i)) throw new Error();
          fence={d:value.f.d,i:value.f.i}; before={d:value.b.d,i:value.b.i};
        } catch { return error('VALIDATION_ERROR','Cursor inválido. Reinicie a paginação.',400,requestId); }
      } else {
        const latest=await env.DB.prepare('SELECT created_at AS d,id AS i FROM formulas WHERE tenant_id=? ORDER BY created_at DESC,id DESC LIMIT 1').bind(tenant.id).first<{d:string;i:number}>();
        if (!latest) return json({data:{rows:[],nextCursor:null,total:0,limit}});
        fence=latest;
      }
      const filters=['f.tenant_id=?']; const params:unknown[]=[tenant.id];
      if (statuses.length) {filters.push(`f.status IN (${statuses.map(()=>'?').join(',')})`);params.push(...statuses);}
      if (delivery) {filters.push('f.delivery_status=?');params.push(delivery);}
      if (search) {filters.push("(CAST(f.id AS TEXT) LIKE ? OR c.name LIKE ? OR f.customer_phone LIKE ? OR f.attendant_name LIKE ? OR COALESCE(f.budget_number,'') LIKE ? OR EXISTS(SELECT 1 FROM formula_items fi JOIN insumos i ON i.tenant_id=fi.tenant_id AND i.id=fi.insumo_id WHERE fi.tenant_id=f.tenant_id AND fi.formula_id=f.id AND i.name LIKE ?))"); for(let n=0;n<6;n++)params.push(`%${search}%`);}
      const filterSql=filters.join(' AND ');
      const count=await env.DB.prepare(`SELECT COUNT(*) AS total FROM formulas f JOIN customers c ON c.tenant_id=f.tenant_id AND c.id=f.customer_id WHERE ${filterSql}`).bind(...params).first<{total:number}>();
      const pageFilters=[...filters,'(f.created_at < ? OR (f.created_at=? AND f.id<=?))']; const pageParams=[...params,fence!.d,fence!.d,fence!.i];
      if (before) {pageFilters.push('(f.created_at < ? OR (f.created_at=? AND f.id<?))');pageParams.push(before.d,before.d,before.i);}
      const result=await env.DB.prepare(`SELECT f.id,f.customer_id,c.name AS customer_name,r.name AS responsible_name,COALESCE(f.customer_phone,'') AS customer_phone,COALESCE(f.attendant_name,'') AS attendant_name,f.created_by_name,COALESCE(f.budget_number,'') AS budget_number,f.delivery_date,f.delivered_at,COALESCE(f.payment_status,'') AS payment_status,f.partial_payment_amount,f.payment_method,COALESCE(f.delivery_status,'') AS delivery_status,f.manager_verified,f.cancel_reason,f.status,f.created_at
        FROM formulas f JOIN customers c ON c.tenant_id=f.tenant_id AND c.id=f.customer_id LEFT JOIN customers r ON r.tenant_id=c.tenant_id AND r.id=c.responsible_id
        WHERE ${pageFilters.join(' AND ')} ORDER BY f.created_at DESC,f.id DESC LIMIT ?`).bind(...pageParams,limit+1).all<any>();
      const hasMore=result.results.length>limit; const rows=result.results.slice(0,limit);
      if (rows.length) await attachFormulaChildren(env,tenant.id,rows);
      const last=rows.at(-1);
      return json({data:{rows,nextCursor:hasMore && last ? encodeCursor({v:1,f:fence,b:{d:last.created_at,i:last.id}}):null,total:count?.total ?? 0,limit}});
    }
    if (id && action==='status' && method==='PATCH' || id && action==='delivery-status' && method==='PATCH') {
      if (!canWrite(user)) return forbidden();
      const body=await bodyObject(request); const status=typeof body?.status==='string' ? body.status.trim() : '';
      if (!status || status.length>40 || action==='status' && !['pending','confirmed','cancelled','delivered'].includes(status) || action==='delivery-status' && !['','em_producao','pronto','entregue'].includes(status)) return invalid();
      const timestamp=deliveryTimestamp();
      const update=action==='status'
        ? env.DB.prepare("UPDATE formulas SET status=?,delivery_status=CASE WHEN ?='confirmed' THEN 'em_producao' ELSE delivery_status END,delivered_at=CASE WHEN ?='confirmed' THEN NULL ELSE delivered_at END,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=? AND id=?").bind(status,status,status,tenant.id,id)
        : env.DB.prepare(`UPDATE formulas SET delivered_at=CASE WHEN ?='entregue' THEN CASE WHEN delivery_status='entregue' THEN delivered_at ELSE ? END ELSE NULL END,delivery_status=?,status=CASE WHEN ?='entregue' THEN 'delivered' WHEN status='delivered' THEN 'confirmed' ELSE status END,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=? AND id=?`).bind(status,timestamp,status,status,tenant.id,id);
      const result=await env.DB.batch([update,auditInsert(env,tenant,user,action==='status'?'update_status':'update_delivery_status','formulas',id,`Status: ${status}`)]);
      if (!result[0]?.meta.changes) return notFound();
      return json({data:{success:true,id}});
    }
    if (id && action==='payment' && method==='PATCH') {
      if (!canWrite(user)) return forbidden();
      const body=await bodyObject(request);
      const status=body?.payment_status; const amount=body?.partial_payment_amount;
      if (!['pago','parcial','pagar_na_retirada'].includes(String(status)) || amount!==null && amount!==undefined && (!Number.isFinite(amount) || Number(amount)<=0 || Math.round(Number(amount)*100)!==Number(amount)*100)) return invalid();
      const partial=status==='parcial' ? Number(amount) : null;
      if (status==='parcial' && !partial) return invalid();
      const statement=env.DB.prepare(`UPDATE formulas SET payment_status=?,partial_payment_amount=?,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=? AND id=? AND status='delivered' AND delivery_status='entregue' AND payment_status<>'pago'
        AND (?<>'parcial' OR ((SELECT COUNT(*) FROM formula_budget_items WHERE tenant_id=? AND formula_id=? AND is_selected=1)=1 AND ?<=(SELECT value FROM formula_budget_items WHERE tenant_id=? AND formula_id=? AND is_selected=1 LIMIT 1)))`)
        .bind(status,partial,tenant.id,id,status,tenant.id,id,partial ?? 0,tenant.id,id);
      const result=await env.DB.batch([statement,env.DB.prepare("INSERT INTO action_logs(id,tenant_id,user_id,user_name,action,entity,entity_id,details) SELECT ?,?,?,?,'update','formulas',?,'Pagamento atualizado' WHERE changes()=1").bind(databaseId(),tenant.id,user.id,user.name,id)]);
      if (!result[0]?.meta.changes) return error('CONFLICT','Somente fórmula entregue não paga pode receber alteração de pagamento; confira o valor parcial.',409,requestId);
      return json({data:{success:true,id}});
    }
    if (id && action==='verification' && (method==='POST' || method==='DELETE')) {
      if (user.role!=='manager') return forbidden();
      const verify=method==='POST' ? 1 : 0;
      const result=await env.DB.batch([
        env.DB.prepare('UPDATE formulas SET manager_verified=?,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=? AND id=?').bind(verify,tenant.id,id),
        auditInsert(env,tenant,user,verify?'verify':'unverify','formulas',id),
      ]);
      if (!result[0]?.meta.changes) return notFound();
      return json({data:{success:true,id}});
    }
    if (id && action===undefined && method==='DELETE') {
      if (user.role!=='admin') return forbidden();
      const result=await env.DB.batch([
        env.DB.prepare("DELETE FROM budget_number_registry WHERE tenant_id=? AND source_type='formula' AND source_id=?").bind(tenant.id,id),
        env.DB.prepare('DELETE FROM formulas WHERE tenant_id=? AND id=?').bind(tenant.id,id),
        auditInsert(env,tenant,user,'delete','formulas',id),
      ]);
      if (!result[1]?.meta.changes) return notFound();
      return json({data:{success:true,id}});
    }
    if (idPart==='delivery-status-batch' && !action && method==='PATCH') {
      if (!canWrite(user)) return forbidden();
      const body=await bodyObject(request); const ids=Array.isArray(body?.ids) ? [...new Set(body.ids.map((v:any)=>positiveId(String(v))).filter((v):v is number=>v!==null))] : [];
      const status=typeof body?.status==='string' ? body.status : '';
      if (!ids.length || ids.length>500 || !['','em_producao','pronto','entregue'].includes(status)) return invalid();
      const requested=JSON.stringify(ids); const timestamp=deliveryTimestamp();
      const result=await env.DB.batch([
        env.DB.prepare(`UPDATE formulas SET delivered_at=CASE WHEN ?='entregue' THEN CASE WHEN delivery_status='entregue' THEN delivered_at ELSE ? END ELSE NULL END,delivery_status=?,status=CASE WHEN ?='entregue' THEN 'delivered' WHEN status='delivered' THEN 'confirmed' ELSE status END,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=? AND id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`).bind(status,timestamp,status,status,tenant.id,requested),
        env.DB.prepare(`INSERT INTO action_logs(id,tenant_id,user_id,user_name,action,entity,entity_id,details) SELECT ?,tenant_id,?,?,'update_delivery_status','formulas',id,? FROM formulas WHERE tenant_id=? AND id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`).bind(databaseId(),user.id,user.name,`Andamento em lote: ${status}`,tenant.id,requested),
      ]);
      return json({data:{success:true,updated:result[0]?.meta.changes ?? 0}});
    }
    if ((!id && method==='POST' || id && method==='PATCH') && action===undefined) {
      if (!canWrite(user)) return forbidden();
      const input=validateFormulaInput(await bodyObject(request));
      if (!input) return invalid();
      const formulaId=id ?? databaseId();
      const itemsJson=formulaItemJson(input.items); const budgetsJson=budgetItemJson(input.budgets);
      try {
        const statements=[];
        if (id) {
          const existing=await env.DB.prepare('SELECT delivery_status,payment_status,partial_payment_amount FROM formulas WHERE tenant_id=? AND id=?').bind(tenant.id,id).first<any>();
          if (!existing) return notFound();
          const delivery=input.status==='confirmed' ? (input.deliveryStatus || 'em_producao') : (input.deliveryStatus || existing.delivery_status || '');
          const payment=input.paymentStatus || existing.payment_status || '';
          const partial=payment==='parcial' ? input.partialAmount ?? existing.partial_payment_amount : null;
          statements.push(env.DB.prepare(`UPDATE formulas SET customer_id=?,customer_phone=COALESCE((SELECT COALESCE(c.phone,r.phone,'') FROM customers c LEFT JOIN customers r ON r.tenant_id=c.tenant_id AND r.id=c.responsible_id WHERE c.tenant_id=? AND c.id=?),''),attendant_name=?,budget_number=?,delivery_date=?,payment_status=?,partial_payment_amount=?,payment_method=?,delivered_at=CASE WHEN ?='entregue' THEN CASE WHEN delivery_status='entregue' THEN delivered_at ELSE ? END ELSE NULL END,delivery_status=?,cancel_reason=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=? AND id=?`).bind(input.customerId,tenant.id,input.customerId,input.attendant,input.budgetNumber,input.delivery_date ?? null,payment,partial,input.paymentMethod,delivery,deliveryTimestamp(),delivery,input.cancel_reason ?? null,input.status,tenant.id,id));
          statements.push(env.DB.prepare("DELETE FROM budget_number_registry WHERE tenant_id=? AND source_type='formula' AND source_id=?").bind(tenant.id,id));
          statements.push(env.DB.prepare('DELETE FROM formula_items WHERE tenant_id=? AND formula_id=?').bind(tenant.id,id));
          statements.push(env.DB.prepare('DELETE FROM formula_budget_items WHERE tenant_id=? AND formula_id=?').bind(tenant.id,id));
        } else {
          const delivery=input.status==='confirmed' ? (input.deliveryStatus || 'em_producao') : input.deliveryStatus;
          statements.push(env.DB.prepare(`INSERT INTO formulas(id,tenant_id,customer_id,customer_phone,attendant_name,created_by_user_id,created_by_name,budget_number,delivery_date,delivered_at,payment_status,partial_payment_amount,payment_method,delivery_status,cancel_reason,status)
            SELECT ?,?,c.id,COALESCE(c.phone,r.phone,''),?,?,?, ?,?,?,?, ?,?,?,?,? FROM customers c LEFT JOIN customers r ON r.tenant_id=c.tenant_id AND r.id=c.responsible_id WHERE c.tenant_id=? AND c.id=?`).bind(formulaId,tenant.id,input.attendant,user.id,user.name,input.budgetNumber,input.delivery_date ?? null,delivery==='entregue'?deliveryTimestamp():null,input.paymentStatus,input.paymentStatus==='parcial'?input.partialAmount:null,input.paymentMethod,delivery,input.cancel_reason ?? null,input.status,tenant.id,input.customerId));
        }
        if (input.budgetNumber) statements.push(env.DB.prepare("INSERT INTO budget_number_registry(tenant_id,budget_number,source_type,source_id) VALUES(?,?,'formula',?)").bind(tenant.id,input.budgetNumber,formulaId));
        statements.push(insertFormulaItems(env,tenant.id,formulaId,itemsJson));
        if (input.budgets.length) statements.push(insertBudgetItems(env,tenant.id,formulaId,budgetsJson));
        statements.push(auditInsert(env,tenant,user,id?'update':'add','formulas',formulaId));
        const result=await env.DB.batch(statements);
        if (!id && !result[0]?.meta.changes) return notFound();
      } catch { return error('CONFLICT','Fórmula inválida, número de orçamento duplicado ou referência de outra farmácia.',409,requestId); }
      return json({data:{success:true,id:formulaId}},id?200:201);
    }
  }

  if (resource === 'saved-formulas') {
    if (!canViewPrivileged(user)) return forbidden();
    if (!id && method === 'GET') {
      const [formulas,items,budgets] = await Promise.all([
        env.DB.prepare('SELECT id,name,created_by_name,budget_number,created_at FROM saved_formulas WHERE tenant_id=? ORDER BY name LIMIT 200').bind(tenant.id).all<any>(),
        env.DB.prepare('SELECT i.saved_formula_id,i.insumo_id,m.name AS insumo_name,i.quantity,i.unit FROM saved_formula_items i JOIN insumos m ON m.tenant_id=i.tenant_id AND m.id=i.insumo_id WHERE i.tenant_id=? ORDER BY i.id LIMIT 10000').bind(tenant.id).all<any>(),
        env.DB.prepare('SELECT saved_formula_id,quantity,unit,value FROM saved_formula_budget_items WHERE tenant_id=? ORDER BY id LIMIT 5000').bind(tenant.id).all<any>(),
      ]);
      const itemsById = new Map<number,any[]>();
      const budgetsById = new Map<number,any[]>();
      for (const row of items.results) { const list=itemsById.get(row.saved_formula_id) ?? []; list.push(row); itemsById.set(row.saved_formula_id,list); }
      for (const row of budgets.results) { const list=budgetsById.get(row.saved_formula_id) ?? []; list.push({quantity:Number(row.quantity),unit:row.unit,value:Number(row.value)}); budgetsById.set(row.saved_formula_id,list); }
      return json({data:formulas.results.map((formula:any)=>({...formula,items:itemsById.get(formula.id) ?? [],budget_items:budgetsById.get(formula.id) ?? []}))});
    }
    if (!id && method === 'POST' || id && method === 'PATCH') {
      if (!canWrite(user)) return forbidden();
      const input=await bodyObject(request);
      const name=typeof input?.name==='string' ? input.name.trim().slice(0,255) : '';
      const items=Array.isArray(input?.items) ? input.items : [];
      const budgets=Array.isArray(input?.budget_items) ? input.budget_items : [];
      if (!name || !items.length || items.length>200 || budgets.length>50 || !items.every((row:any)=>positiveId(String(row?.insumo_id)) && Number.isFinite(row?.quantity) && row.quantity>0 && typeof (row.unit ?? 'mg')==='string') || !budgets.every((row:any)=>Number.isFinite(row?.quantity) && row.quantity>0 && typeof row.unit==='string' && Number.isFinite(row.value) && row.value>=0)) return invalid();
      const budgetNumber=typeof input?.budget_number==='string' ? input.budget_number.trim().slice(0,20) : '';
      const formulaId=id ?? databaseId();
      const itemJson=JSON.stringify(items.map((row:any)=>({id:databaseId(),insumo_id:Number(row.insumo_id),quantity:row.quantity,unit:row.unit ?? 'mg'})));
      const budgetJson=JSON.stringify(budgets.map((row:any)=>({id:databaseId(),quantity:row.quantity,unit:row.unit,value:row.value})));
      try {
        const statements=[];
        if (id) {
          statements.push(env.DB.prepare('UPDATE saved_formulas SET name=?,budget_number=?,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=? AND id=?').bind(name,budgetNumber || null,tenant.id,formulaId));
          statements.push(env.DB.prepare("DELETE FROM budget_number_registry WHERE tenant_id=? AND source_type='saved_formula' AND source_id=?").bind(tenant.id,formulaId));
          statements.push(env.DB.prepare('DELETE FROM saved_formula_items WHERE tenant_id=? AND saved_formula_id=?').bind(tenant.id,formulaId));
          statements.push(env.DB.prepare('DELETE FROM saved_formula_budget_items WHERE tenant_id=? AND saved_formula_id=?').bind(tenant.id,formulaId));
        } else {
          statements.push(env.DB.prepare('INSERT INTO saved_formulas(id,tenant_id,name,created_by_user_id,created_by_name,budget_number) VALUES(?,?,?,?,?,?)').bind(formulaId,tenant.id,name,user.id,user.name,budgetNumber || null));
        }
        if (budgetNumber) statements.push(env.DB.prepare("INSERT INTO budget_number_registry(tenant_id,budget_number,source_type,source_id) VALUES(?,?,'saved_formula',?)").bind(tenant.id,budgetNumber,formulaId));
        statements.push(env.DB.prepare(`INSERT INTO saved_formula_items(id,tenant_id,saved_formula_id,insumo_id,quantity,unit)
          SELECT CAST(json_extract(value,'$.id') AS INTEGER),?, ?,CAST(json_extract(value,'$.insumo_id') AS INTEGER),CAST(json_extract(value,'$.quantity') AS REAL),json_extract(value,'$.unit') FROM json_each(?)`).bind(tenant.id,formulaId,itemJson));
        if (budgets.length) statements.push(env.DB.prepare(`INSERT INTO saved_formula_budget_items(id,tenant_id,saved_formula_id,quantity,unit,value)
          SELECT CAST(json_extract(value,'$.id') AS INTEGER),?, ?,CAST(json_extract(value,'$.quantity') AS REAL),json_extract(value,'$.unit'),CAST(json_extract(value,'$.value') AS REAL) FROM json_each(?)`).bind(tenant.id,formulaId,budgetJson));
        statements.push(auditInsert(env,tenant,user,id?'update':'add','saved_formulas',formulaId));
        const result=await env.DB.batch(statements);
        if (!result[0]?.meta.changes) return notFound();
      } catch { return error('CONFLICT','Modelo duplicado, orçamento já usado ou insumo de outra farmácia.',409,requestId); }
      return json({data:{success:true,id:formulaId}},id?200:201);
    }
    if (id && method === 'DELETE') {
      if (!canWrite(user)) return forbidden();
      const result=await env.DB.batch([
        env.DB.prepare("DELETE FROM budget_number_registry WHERE tenant_id=? AND source_type='saved_formula' AND source_id=?").bind(tenant.id,id),
        env.DB.prepare('DELETE FROM saved_formulas WHERE tenant_id=? AND id=?').bind(tenant.id,id),
        auditInsert(env,tenant,user,'delete','saved_formulas',id),
      ]);
      if (!result[1]?.meta.changes) return notFound();
      return json({data:{success:true,id}});
    }
  }

  if (resource === 'logs' && method === 'GET' && !id) {
    if (!canViewPrivileged(user)) return forbidden();
    const query=new URL(request.url).searchParams;
    const page=Math.min(10000,Math.max(1,Number(query.get('page') ?? 1) || 1));
    const pageSize=Math.min(100,Math.max(1,Number(query.get('pageSize') ?? 50) || 50));
    const where=['tenant_id=?']; const params:unknown[]=[tenant.id];
    for (const [key,column] of [['userId','user_id'],['action','action'],['entity','entity']] as const) {
      const value=query.get(key); if (value) { where.push(`${column}=?`); params.push(key==='userId' ? positiveId(value) ?? -1 : value.slice(0,100)); }
    }
    const from=query.get('from'); if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {where.push('date(created_at)>=date(?)');params.push(from);}
    const to=query.get('to'); if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {where.push('date(created_at)<=date(?)');params.push(to);}
    const search=query.get('search')?.trim().slice(0,100); if (search) {where.push("(user_name LIKE ? OR COALESCE(details,'') LIKE ?)");params.push(`%${search}%`,`%${search}%`);}
    const filter=where.join(' AND ');
    const [count,rows]=await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) AS total FROM action_logs WHERE ${filter}`).bind(...params).first<{total:number}>(),
      env.DB.prepare(`SELECT id,user_id,user_name,action,entity,entity_id,COALESCE(details,'') AS details,created_at FROM action_logs WHERE ${filter} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).bind(...params,pageSize,(page-1)*pageSize).all(),
    ]);
    return json({data:{rows:rows.results,total:count?.total ?? 0}});
  }

  return error('NOT_FOUND', 'Rota não encontrada.', 404, requestId);
}

async function listAccessibleTenants(env:Env,identity:Identity) {
  const [linked,pending]=await Promise.all([
    env.DB.prepare(`SELECT t.slug,t.name,t.status,0 AS invited FROM tenants t JOIN users u ON u.tenant_id=t.id AND u.active=1 JOIN identities i ON i.id=u.identity_id WHERE i.access_issuer=? AND i.access_subject=? ORDER BY t.name`).bind(identity.issuer,identity.subject).all<TenantOption>(),
    env.DB.prepare(`SELECT t.slug,t.name,t.status,1 AS invited FROM tenants t JOIN users u ON u.tenant_id=t.id JOIN invitations v ON v.tenant_id=u.tenant_id AND v.user_id=u.id WHERE lower(v.email)=? AND t.status='active' AND u.active=0 AND u.identity_id IS NULL AND v.accepted_at IS NULL AND v.revoked_at IS NULL AND v.expires_at>CURRENT_TIMESTAMP ORDER BY t.name`).bind(identity.email).all<TenantOption>(),
  ]);
  const bySlug=new Map<string,TenantOption>();
  for(const tenant of [...linked.results,...pending.results]) bySlug.set(tenant.slug,tenant);
  return [...bySlug.values()].sort((a,b)=>a.name.localeCompare(b.name));
}

type TenantOption={slug:string;name:string;status:'active'|'suspended';invited:number};

type PlatformUser={id:number;name:string;email:string;role:'platform_admin'};

function platformLog(env:Env,identityId:number,identity:Identity,action:string,tenantId:number|null,details?:string) {
  return env.DB.prepare('INSERT INTO platform_action_logs(id,identity_id,actor_email,actor_name,action,tenant_id,details) VALUES(?,?,?,?,?,?,?)')
    .bind(databaseId(),identityId,identity.email,identity.name,action,tenantId,details ?? null);
}

async function resolvePlatformAdmin(env:Env,identity:Identity):Promise<{identityId:number;user:PlatformUser}|null> {
  const found=await env.DB.prepare(`SELECT i.id,i.display_name AS name,i.current_email AS email FROM identities i JOIN platform_admins a ON a.identity_id=i.id WHERE i.access_issuer=? AND i.access_subject=? AND a.active=1`).bind(identity.issuer,identity.subject).first<{id:number;name:string;email:string}>();
  if(found) return {identityId:found.id,user:{id:found.id,name:found.name,email:found.email,role:'platform_admin'}};
  const invite=await env.DB.prepare("SELECT id FROM platform_admin_invites WHERE lower(email)=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>CURRENT_TIMESTAMP").bind(identity.email).first<{id:number}>();
  if(!invite) return null;
  const identityId=databaseId();
  const results=await env.DB.batch([
    env.DB.prepare(`INSERT INTO identities(id,access_issuer,access_subject,current_email,display_name) VALUES(?,?,?,?,?) ON CONFLICT(access_issuer,access_subject) DO NOTHING`).bind(identityId,identity.issuer,identity.subject,identity.email,identity.name),
    env.DB.prepare(`INSERT INTO platform_admins(identity_id,active) SELECT id,1 FROM identities WHERE access_issuer=? AND access_subject=? ON CONFLICT(identity_id) DO NOTHING`).bind(identity.issuer,identity.subject),
    env.DB.prepare("UPDATE platform_admin_invites SET accepted_at=CURRENT_TIMESTAMP WHERE id=? AND lower(email)=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>CURRENT_TIMESTAMP").bind(invite.id,identity.email),
    env.DB.prepare(`INSERT INTO platform_action_logs(id,identity_id,actor_email,actor_name,action,details) SELECT ?,id,current_email,display_name,'bootstrap_admin',NULL FROM identities WHERE access_issuer=? AND access_subject=?`).bind(databaseId(),identity.issuer,identity.subject),
  ]);
  if(!results[2]?.meta.changes) return null;
  const linked=await env.DB.prepare('SELECT id,display_name AS name,current_email AS email FROM identities WHERE access_issuer=? AND access_subject=?').bind(identity.issuer,identity.subject).first<{id:number;name:string;email:string}>();
  return linked ? {identityId:linked.id,user:{id:linked.id,name:linked.name,email:linked.email,role:'platform_admin'}} : null;
}

async function platformLogin(request:Request,env:Env,identity:Identity,requestId:string) {
  let values:Map<string,string>;
  try { values=cookies(request); } catch { return error('COOKIE_INVALID','Cabeçalho de cookie ambíguo.',400,requestId); }
  const csrfCookie=values.get('__Secure-magisform_platform_csrf');
  const invalid=verifyMutation(request,{id:0,slug:'platform',name:'',status:'active',brand:'',brand_theme:''},csrfCookie,'/api/platform/v1/');
  if(invalid) return invalid;
  const body=await request.clone().json().catch(()=>({})) as {force?:boolean};
  const admin=await resolvePlatformAdmin(env,identity);
  if(!admin) return error('FORBIDDEN','Sua identidade não está autorizada como administradora da plataforma.',403,requestId);
  const existing=await env.DB.prepare('SELECT id FROM platform_sessions WHERE identity_id=? AND expires_at>CURRENT_TIMESTAMP AND absolute_expires_at>CURRENT_TIMESTAMP').bind(admin.identityId).first<{id:number}>();
  if(existing && body.force!==true) return error('SESSION_CONFLICT','Já existe uma sessão administrativa ativa.',409,requestId);
  const token=crypto.randomUUID()+crypto.randomUUID(); const csrf=crypto.randomUUID()+crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO platform_sessions(id,identity_id,token_hash,csrf_hash,expires_at,absolute_expires_at) VALUES(?,?,?,?,datetime('now','+8 hours'),datetime('now','+24 hours')) ON CONFLICT(identity_id) DO UPDATE SET token_hash=excluded.token_hash,csrf_hash=excluded.csrf_hash,created_at=CURRENT_TIMESTAMP,last_seen=CURRENT_TIMESTAMP,expires_at=excluded.expires_at,absolute_expires_at=excluded.absolute_expires_at`)
    .bind(databaseId(),admin.identityId,await digest(token),await digest(csrf)).run();
  const headers=new Headers();
  headers.append('set-cookie',`__Secure-magisform_platform_session=${token}; Path=/api/platform/v1; HttpOnly; Secure; SameSite=Lax`);
  headers.append('set-cookie',`__Secure-magisform_platform_csrf=${csrf}; Path=/api/platform/v1; Secure; SameSite=Lax`);
  return json({data:{user:admin.user,csrfToken:csrf}},200,headers);
}

async function platformCsrf():Promise<Response> {
  const token=crypto.randomUUID()+crypto.randomUUID();const headers=new Headers();
  headers.append('set-cookie',`__Secure-magisform_platform_csrf=${token}; Path=/api/platform/v1; Secure; SameSite=Lax`);
  return json({data:{csrfToken:token}},200,headers);
}

async function platformSession(request:Request,env:Env,identity:Identity) {
  const admin=await env.DB.prepare('SELECT i.id,i.display_name AS name,i.current_email AS email FROM identities i JOIN platform_admins a ON a.identity_id=i.id AND a.active=1 WHERE i.access_issuer=? AND i.access_subject=?').bind(identity.issuer,identity.subject).first<{id:number;name:string;email:string}>();
  if(!admin) return null;
  let values:Map<string,string>;try{values=cookies(request);}catch{return null;}
  const token=values.get('__Secure-magisform_platform_session');if(!token)return null;
  const session=await env.DB.prepare('SELECT id,csrf_hash FROM platform_sessions WHERE identity_id=? AND token_hash=? AND expires_at>CURRENT_TIMESTAMP AND absolute_expires_at>CURRENT_TIMESTAMP').bind(admin.id,await digest(token)).first<{id:number;csrf_hash:string}>();
  return session ? {admin:{identityId:admin.id,user:{id:admin.id,name:admin.name,email:admin.email,role:'platform_admin' as const}},session,values} : null;
}

async function handlePlatformApi(request:Request,env:Env,path:string,identity:Identity,requestId:string):Promise<Response> {
  const method=request.method;
  if(path==='/tenants' && method==='GET') return json({data:await listAccessibleTenants(env,identity)});
  if(path==='/auth/csrf' && method==='GET') return platformCsrf();
  if(path==='/auth/login' && method==='POST') return platformLogin(request,env,identity,requestId);
  const current=await platformSession(request,env,identity);
  if(!current) return error('UNAUTHENTICATED','Sessão de administração inválida ou expirada.',401,requestId);
  if(path==='/auth/me' && method==='GET') return json({data:{authenticated:true,user:current.admin.user}});
  if(method!=='GET' && method!=='HEAD') {
    const invalid=verifyMutation(request,{id:0,slug:'platform',name:'',status:'active',brand:'',brand_theme:''},current.values.get('__Secure-magisform_platform_csrf'),'/api/platform/v1/');
    if(invalid) return invalid;
    const supplied=request.headers.get('x-csrf-token') ?? '';
    if(!supplied || await digest(supplied)!==current.session.csrf_hash) return error('CSRF_INVALID','Token de segurança inválido.',403,requestId);
  }
  if(path==='/auth/logout' && method==='POST') {
    await env.DB.prepare('DELETE FROM platform_sessions WHERE id=?').bind(current.session.id).run();
    const headers=new Headers();headers.append('set-cookie','__Secure-magisform_platform_session=; Path=/api/platform/v1; HttpOnly; Secure; SameSite=Lax; Max-Age=0');headers.append('set-cookie','__Secure-magisform_platform_csrf=; Path=/api/platform/v1; Secure; SameSite=Lax; Max-Age=0');
    return json({data:{success:true}},200,headers);
  }
  const pathParts=path.split('/').filter(Boolean);
  const [resource,slug,userIdPart]=pathParts;
  const userId=positiveId(pathParts[3]);
  if(resource==='installations' && !slug && method==='GET') {
    const rows=await env.DB.prepare('SELECT id,slug,name,status,brand,brand_theme,created_at FROM tenants ORDER BY name LIMIT 500').all();
    return json({data:rows.results});
  }
  if(resource==='installations' && !slug && method==='POST') {
    const body=await bodyObject(request);const slugValue=typeof body?.slug==='string'?body.slug.trim().toLowerCase():'';const name=typeof body?.name==='string'?body.name.trim().slice(0,160):'';
    const email=typeof body?.admin_email==='string'?body.admin_email.trim().toLowerCase():'';const adminName=typeof body?.admin_name==='string'?body.admin_name.trim().slice(0,120):'';
    const brand=typeof body?.brand==='string'?body.brand.trim().slice(0,80):'MagisForm';const brandTheme=body?.brand_theme && typeof body.brand_theme==='object' ? JSON.stringify(body.brand_theme) : '{}';
    if(!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slugValue)||!name||!adminName||!/^\S+@\S+\.\S+$/.test(email)) return error('VALIDATION_ERROR','Nome, slug e convite válido para o primeiro administrador são obrigatórios.',400,requestId);
    const tenantId=databaseId(),userId=databaseId(),inviteId=databaseId();
    try { await env.DB.batch([
      env.DB.prepare('INSERT INTO tenants(id,slug,name,status,brand,brand_theme) VALUES(?,?,?,\'active\',?,?)').bind(tenantId,slugValue,name,brand,brandTheme),
      env.DB.prepare('INSERT INTO users(id,tenant_id,email,name,username,role,active) VALUES(?,?,?,?,?,\'admin\',0)').bind(userId,tenantId,email,adminName,email),
      env.DB.prepare("INSERT INTO invitations(id,tenant_id,user_id,email,expires_at) VALUES(?,?,?,?,datetime('now','+7 days'))").bind(inviteId,tenantId,userId,email),
      platformLog(env,current.admin.identityId,identity,'tenant_created',tenantId,JSON.stringify({slug:slugValue,adminEmail:email})),
    ]); } catch { return error('CONFLICT','Já existe uma farmácia com este slug ou e-mail.',409,requestId); }
    return json({data:{success:true,id:tenantId,slug:slugValue}},201);
  }
  if(resource==='installations' && slug && !userIdPart && method==='PATCH') {
    const body=await bodyObject(request);if(!body)return error('VALIDATION_ERROR','Corpo inválido.',400,requestId);
    const existing=await env.DB.prepare('SELECT id,status FROM tenants WHERE slug=?').bind(slug).first<{id:number;status:string}>();if(!existing)return error('NOT_FOUND','Farmácia não encontrada.',404,requestId);
    const status=body.status===undefined?existing.status:String(body.status);if(!['active','suspended'].includes(status))return error('VALIDATION_ERROR','Estado inválido.',400,requestId);
    const name=typeof body.name==='string'?body.name.trim().slice(0,160):null;const brand=typeof body.brand==='string'?body.brand.trim().slice(0,80):null;const theme=body.brand_theme&&typeof body.brand_theme==='object'?JSON.stringify(body.brand_theme):null;
    const stmts=[env.DB.prepare('UPDATE tenants SET status=?,name=COALESCE(?,name),brand=COALESCE(?,brand),brand_theme=COALESCE(?,brand_theme),updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(status,name,brand,theme,existing.id)];
    if(status==='suspended') stmts.push(env.DB.prepare('DELETE FROM sessions WHERE tenant_id=?').bind(existing.id));
    stmts.push(platformLog(env,current.admin.identityId,identity,status==='suspended'?'tenant_suspended':status==='active'&&existing.status==='suspended'?'tenant_reactivated':'tenant_updated',existing.id,JSON.stringify({status,name,brand})));
    await env.DB.batch(stmts);return json({data:{success:true,slug,status}});
  }
  if(resource==='installations' && slug && userIdPart==='users' && !userId && method==='GET') {
    const tenant=await env.DB.prepare('SELECT id FROM tenants WHERE slug=?').bind(slug).first<{id:number}>();if(!tenant)return error('NOT_FOUND','Farmácia não encontrada.',404,requestId);
    const users=await env.DB.prepare('SELECT id,name,email,role,active,created_at FROM users WHERE tenant_id=? ORDER BY name LIMIT 500').bind(tenant.id).all();return json({data:users.results});
  }
  if(resource==='installations' && slug && userIdPart==='users' && !userId && method==='POST') {
    const tenant=await env.DB.prepare('SELECT id FROM tenants WHERE slug=? AND status=\'active\'').bind(slug).first<{id:number}>();if(!tenant)return error('NOT_FOUND','Farmácia ativa não encontrada.',404,requestId);
    const body=await bodyObject(request);const name=typeof body?.name==='string'?body.name.trim().slice(0,120):'';const email=typeof body?.email==='string'?body.email.trim().toLowerCase():'';const role=typeof body?.role==='string'?body.role:'';
    if(!name||!/^\S+@\S+\.\S+$/.test(email)||!['admin','manager','pharmacist','employee'].includes(role))return error('VALIDATION_ERROR','Convite inválido.',400,requestId);
    const newUserId=databaseId();
    try {await env.DB.batch([
      env.DB.prepare('INSERT INTO users(id,tenant_id,email,name,username,role,active) VALUES(?,?,?,?,?,?,0)').bind(newUserId,tenant.id,email,name,email,role),
      env.DB.prepare("INSERT INTO invitations(id,tenant_id,user_id,email,expires_at) VALUES(?,?,?,?,datetime('now','+7 days'))").bind(databaseId(),tenant.id,newUserId,email),
      platformLog(env,current.admin.identityId,identity,'user_invited',tenant.id,JSON.stringify({email,role})),
    ]);}catch{return error('CONFLICT','Este e-mail já está convidado ou vinculado nesta farmácia.',409,requestId);}
    return json({data:{success:true,id:newUserId}},201);
  }
  if(resource==='installations' && slug && userIdPart==='users' && userId && method==='PATCH') {
    const body=await bodyObject(request);const role=String(body?.role ?? '');const active=body?.active;
    if(role && !['admin','manager','pharmacist','employee'].includes(role) || active!==undefined && typeof active!=='boolean')return error('VALIDATION_ERROR','Atualização de participante inválida.',400,requestId);
    const target=await env.DB.prepare('SELECT t.id AS tenant_id,u.role,u.active FROM tenants t JOIN users u ON u.tenant_id=t.id WHERE t.slug=? AND u.id=?').bind(slug,userId).first<{tenant_id:number;role:string;active:number}>();if(!target)return error('NOT_FOUND','Participante não encontrado.',404,requestId);
    const nextRole=role||target.role;const nextActive=active===undefined?target.active:(active?1:0);
    if(target.role==='admin'&&target.active===1&&(nextRole!=='admin'||nextActive!==1)){
      const admins=await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE tenant_id=? AND role='admin' AND active=1").bind(target.tenant_id).first<{count:number}>();
      if((admins?.count??0)<=1)return error('CONFLICT','A farmácia precisa manter ao menos um administrador ativo.',409,requestId);
    }
    const statements=[env.DB.prepare('UPDATE users SET role=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=? AND id=?').bind(nextRole,nextActive,target.tenant_id,userId)];
    if(!nextActive)statements.push(env.DB.prepare('DELETE FROM sessions WHERE tenant_id=? AND user_id=?').bind(target.tenant_id,userId));
    statements.push(platformLog(env,current.admin.identityId,identity,'user_updated',target.tenant_id,JSON.stringify({userId,role:nextRole,active:!!nextActive})));
    try{await env.DB.batch(statements);}catch{return error('CONFLICT','A alteração conflita com uma regra de integridade da farmácia.',409,requestId);}return json({data:{success:true,id:userId}});
  }
  return error('NOT_FOUND','Rota administrativa não encontrada.',404,requestId);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get('cf-ray') ?? crypto.randomUUID();
    if (url.pathname==='/api/platform/v1' || url.pathname.startsWith('/api/platform/v1/')) {
      const identity=await accessIdentity(request,env);
      if(!identity) return error('UNAUTHENTICATED','Cloudflare Access é obrigatório.',401,requestId);
      try { return await handlePlatformApi(request,env,url.pathname.slice('/api/platform/v1'.length) || '/',identity,requestId); }
      catch { return error('UNAVAILABLE','Serviço da plataforma temporariamente indisponível.',503,requestId); }
    }
    const route = tenantPath(url.pathname);
    if (!route) {
      const path=url.pathname;
      if(path==='/' || path==='/management' || path==='/management/' || path.startsWith('/assets/') || path.startsWith('/fonts/') || path.startsWith('/brand/') || path.startsWith('/management/assets/')) {
        const assetPath=path.startsWith('/management/assets/') ? path.slice('/management'.length) : path==='/' || path==='/management' || path==='/management/' ? '/index.html' : path;
        try { return await env.ASSETS.fetch(new Request(new URL(assetPath+url.search,url.origin),request)); }
        catch { return error('UNAVAILABLE','Assets do MagisForm indisponíveis.',503,requestId); }
      }
      return error('NOT_FOUND', 'Use / para selecionar uma farmácia ou /t/{slug}/ para acessar o sistema.', 404, requestId);
    }
    try {
      const tenant = await env.DB.prepare('SELECT id,slug,name,status,brand,brand_theme FROM tenants WHERE slug=?').bind(route.slug).first<Tenant>();
      if (!tenant) return error('NOT_FOUND', 'Farmácia não encontrada.', 404, requestId);
      if (route.rest === '/api/v1' || route.rest.startsWith('/api/v1/')) {
        const apiPath = route.rest.slice('/api/v1'.length) || '/';
        const identity = await accessIdentity(request, env);
        return handleApi(request, env, tenant, apiPath, identity);
      }
      const assetPath = route.rest === '/' ? '/index.html' : route.rest;
      const assetUrl = new URL(assetPath + url.search, url.origin);
      return await env.ASSETS.fetch(new Request(assetUrl, request));
    } catch {
      return error('UNAVAILABLE', 'Serviço temporariamente indisponível.', 503, requestId);
    }
  },
};
