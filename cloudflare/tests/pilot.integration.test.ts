import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyD1Migrations, env, fetchMock } from 'cloudflare:test';
import worker from '../worker';

const TEAM = 'magisform-test.cloudflareaccess.com';
const AUDIENCE = 'magisform-test-audience';
const ISSUER = `https://${TEAM}`;
const encoder = new TextEncoder();
let signingKey: CryptoKey;

function invoke(url:string,init?:RequestInit) {
  return worker.fetch(new Request(url,init),env);
}

function base64url(value: Uint8Array): string {
  let binary=''; for(const byte of value) binary+=String.fromCharCode(byte);
  return btoa(binary).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

async function accessToken(subject: string, email: string, expired=false): Promise<string> {
  const header=base64url(encoder.encode(JSON.stringify({alg:'RS256',kid:'workers-test-key'})));
  const payload=base64url(encoder.encode(JSON.stringify({iss:ISSUER,sub:subject,aud:[AUDIENCE],exp:Math.floor(Date.now()/1000)+(expired?-60:3600),email,name:email.split('@')[0]})));
  const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',signingKey,encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

async function loggedIn(slug:string, token:string, force=false) {
  const root=`https://magisform-test.workers.dev/t/${slug}/api/v1`;
  const csrfResponse=await invoke(`${root}/auth/csrf`,{headers:{'cf-access-jwt-assertion':token}});
  const csrfBody=await csrfResponse.json() as any;
  if(!csrfResponse.ok) return {root,response:csrfResponse,body:csrfBody,headers:{'cf-access-jwt-assertion':token}};
  const loginResponse=await invoke(`${root}/auth/login`,{
    method:'POST',headers:{'cf-access-jwt-assertion':token,origin:'https://magisform-test.workers.dev',cookie:`__Secure-magisform_csrf=${csrfBody.data.csrfToken}`,'x-csrf-token':csrfBody.data.csrfToken,'content-type':'application/json'},
    body:JSON.stringify({force}),
  });
  const body=await loginResponse.json() as any;
  const cookie=loginResponse.headers.get('set-cookie') ?? '';
  const session=/__Secure-magisform_session=([^;,\s]+)/.exec(cookie)?.[1];
  const csrf=body.data?.csrfToken;
  return {root,response:loginResponse,body,headers:{'cf-access-jwt-assertion':token,cookie:`__Secure-magisform_session=${session}; __Secure-magisform_csrf=${csrf}`,'x-csrf-token':csrf,origin:'https://magisform-test.workers.dev','content-type':'application/json'}};
}

async function api(session:Awaited<ReturnType<typeof loggedIn>>,path:string,method='GET',body?:unknown) {
  return invoke(`${session.root}${path}`,{method,headers:session.headers, ...(body===undefined?{}:{body:JSON.stringify(body)})});
}

describe('piloto Cloudflare com D1 em workerd',()=>{
  beforeAll(async()=>{
    const migrations=(env as typeof env & {TEST_MIGRATIONS:string}).TEST_MIGRATIONS;
    await applyD1Migrations(env.DB,JSON.parse(migrations));
    const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
    signingKey=pair.privateKey;
    const publicJwk=await crypto.subtle.exportKey('jwk',pair.publicKey) as JsonWebKey & {kid?:string;alg?:string;use?:string};
    publicJwk.kid='workers-test-key'; publicJwk.alg='RS256'; publicJwk.use='sig';
    fetchMock.activate();
    fetchMock.get(`https://${TEAM}`).intercept({path:'/cdn-cgi/access/certs'}).reply(200,{keys:[publicJwk]});
    await env.DB.batch([
      env.DB.prepare("INSERT INTO tenants(id,slug,name,brand,brand_theme) VALUES(7001,'farmacia-a','Farmácia A','MagisForm','{}')"),
      env.DB.prepare("INSERT INTO tenants(id,slug,name,brand,brand_theme) VALUES(7002,'farmacia-b','Farmácia B','MagisForm','{}')"),
      env.DB.prepare("INSERT INTO tenants(id,slug,name,brand,brand_theme) VALUES(7003,'farmacia-c','Farmácia C','MagisForm','{}')"),
      env.DB.prepare("INSERT INTO users(id,tenant_id,email,name,username,role,active) VALUES(8001,7001,'a@example.test','Admin A','a@example.test','admin',0)"),
      env.DB.prepare("INSERT INTO users(id,tenant_id,email,name,username,role,active) VALUES(8002,7002,'b@example.test','Admin B','b@example.test','admin',0)"),
      env.DB.prepare("INSERT INTO users(id,tenant_id,email,name,username,role,active) VALUES(8003,7003,'c@example.test','Admin C','c@example.test','admin',1)"),
      env.DB.prepare("INSERT INTO invitations(id,tenant_id,user_id,email,expires_at) VALUES(9001,7001,8001,'a@example.test',datetime('now','+1 day'))"),
      env.DB.prepare("INSERT INTO invitations(id,tenant_id,user_id,email,expires_at) VALUES(9002,7002,8002,'b@example.test',datetime('now','+1 day'))"),
      env.DB.prepare("INSERT INTO platform_admin_invites(id,email,expires_at) VALUES(9010,'platform@example.test',datetime('now','+1 day'))"),
    ]);
  });
  afterAll(()=>fetchMock.assertNoPendingInterceptors());

  it('vincula convites, aplica sessões/CSRF e mantém CRUD, fórmulas e auditoria isolados por tenant',async()=>{
    expect(env.ACCESS_TEAM_DOMAIN).toBe(TEAM);
    const tokenA=await accessToken('subject-a','a@example.test');
    expect(new Request('https://magisform-test.workers.dev/',{headers:{'cf-access-jwt-assertion':tokenA}}).headers.get('cf-access-jwt-assertion')).toBe(tokenA);
    const csrfOnly=await invoke('https://magisform-test.workers.dev/t/farmacia-a/api/v1/auth/csrf',{headers:{'cf-access-jwt-assertion':tokenA}});
    expect(csrfOnly.status).toBe(200);
    const unaccepted=await env.DB.prepare('SELECT accepted_at FROM invitations WHERE tenant_id=7001 AND user_id=8001').first<{accepted_at:string|null}>();
    expect(unaccepted?.accepted_at).toBeNull();
    const tokenB=await accessToken('subject-b','b@example.test');
    const a=await loggedIn('farmacia-a',tokenA);
    const b=await loggedIn('farmacia-b',tokenB);
    expect(a.response.status,JSON.stringify(a.body)).toBe(200);
    expect(b.response.status,JSON.stringify(b.body)).toBe(200);

    const customerResponse=await api(a,'/customers','POST',{name:'Cliente fictício A',phone:'11999990000'});
    const customer=(await customerResponse.json() as any).data;
    expect(customerResponse.status).toBe(201);
    expect((await (await api(b,'/customers')).json() as any).data).toHaveLength(0);
    expect((await api(b,`/customers/${customer.id}`,'PATCH',{name:'tentativa'})).status).toBe(404);
    const badOrigin=await invoke(`${a.root}/customers`,{method:'POST',headers:{...a.headers,origin:'https://origem-invalida.example'},body:JSON.stringify({name:'Não gravar'})});
    expect(badOrigin.status).toBe(403);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM customers WHERE tenant_id=7001 AND name='Não gravar'").first<{count:number}>())?.count).toBe(0);

    const ingredientResponse=await api(a,'/insumos','POST','Ativo A');
    const ingredient=(await ingredientResponse.json() as any).data;
    const foreignIngredientResponse=await api(b,'/insumos','POST','Ativo B');
    const foreignIngredient=(await foreignIngredientResponse.json() as any).data;
    const input={customer_id:customer.id,attendant_name:'Atendente A',items:[{insumo_id:ingredient.id,quantity:100,unit:'mg'}],budget_number:'QA-100',budget_items:[{quantity:30,unit:'caps',value:75,is_selected:true}]};
    const createResponse=await api(a,'/formulas','POST',input);
    const created=(await createResponse.json() as any).data;
    expect(createResponse.status).toBe(201);
    expect((await (await api(a,`/formulas/${created.id}`)).json() as any).data.items[0].insumo_name).toBe('Ativo A');

    const crossTenant=await api(a,'/formulas','POST',{...input,budget_number:'QA-CROSS',items:[{insumo_id:foreignIngredient.id,quantity:1,unit:'mg'}]});
    expect(crossTenant.status).toBe(409);
    const formulasAfterRollback=await env.DB.prepare('SELECT COUNT(*) AS count FROM formulas WHERE tenant_id=7001').first<{count:number}>();
    expect(formulasAfterRollback?.count).toBe(1);

    expect((await api(a,`/formulas/${created.id}/status`,'PATCH',{status:'confirmed'})).status).toBe(200);
    expect((await api(a,`/formulas/${created.id}/delivery-status`,'PATCH',{status:'entregue'})).status).toBe(200);
    expect((await api(a,`/formulas/${created.id}/payment`,'PATCH',{payment_status:'parcial',partial_payment_amount:25})).status).toBe(200);
    const summary=(await (await api(a,'/formulas-summary?month='+new Date().getMonth()+'&year='+new Date().getFullYear()+'&paymentStatus=parcial')).json() as any).data;
    expect(summary.deliveredMonthlyTotal).toBe(25);
    const logs=(await (await api(a,'/logs?page=1&pageSize=50')).json() as any).data.rows;
    expect(logs.some((row:any)=>row.entity==='formulas' && row.action==='add')).toBe(true);
    expect((await (await api(b,'/logs')).json() as any).data.rows.every((row:any)=>row.entity!=='formulas')).toBe(true);
    const reusedEmail=await loggedIn('farmacia-a',await accessToken('different-subject','a@example.test'));
    expect(reusedEmail.response.status).toBe(403);
  });

  it('rejeita JWT expirado e exige confirmação para substituir sessão ativa',async()=>{
    const expired=await accessToken('expired','a@example.test',true);
    expect((await invoke('https://magisform-test.workers.dev/t/farmacia-a/api/v1/auth/csrf',{headers:{'cf-access-jwt-assertion':expired}})).status).toBe(401);
    const token=await accessToken('subject-a','a@example.test');
    const first=await loggedIn('farmacia-a',token);
    expect(first.response.status).toBe(200);
    const second=await loggedIn('farmacia-a',token);
    expect(second.response.status).toBe(409);
    const forced=await loggedIn('farmacia-a',token,true);
    expect(forced.response.status).toBe(200);
    expect((await api(first,'/auth/me')).status).toBe(401);
  });

  it('não duplica auditoria quando o aceite do mesmo convite concorre',async()=>{
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users(id,tenant_id,email,name,username,role,active) VALUES(8014,7003,'concorrente@example.test','Concorrente','concorrente@example.test','employee',0)"),
      env.DB.prepare("INSERT INTO invitations(id,tenant_id,user_id,email,expires_at) VALUES(9014,7003,8014,'concorrente@example.test',datetime('now','+1 day'))"),
    ]);
    const token=await accessToken('subject-concorrente','concorrente@example.test');
    await Promise.all([loggedIn('farmacia-c',token),loggedIn('farmacia-c',token)]);
    const user=await env.DB.prepare('SELECT active FROM users WHERE tenant_id=7003 AND id=8014').first<{active:number}>();
    const logs=await env.DB.prepare("SELECT COUNT(*) AS count FROM action_logs WHERE tenant_id=7003 AND user_id=8014 AND action='invite_accepted'").first<{count:number}>();
    expect(user?.active).toBe(1);
    expect(logs?.count).toBe(1);
  });

  it('separa a administração global dos papéis de farmácia e permite suspender uma instalação',async()=>{
    const access=await accessToken('platform-subject','platform@example.test');
    const root='https://magisform-test.workers.dev/api/platform/v1';
    const csrfResponse=await invoke(`${root}/auth/csrf`,{headers:{'cf-access-jwt-assertion':access}});
    const csrf=(await csrfResponse.json() as any).data.csrfToken;
    const login=await invoke(`${root}/auth/login`,{method:'POST',headers:{'cf-access-jwt-assertion':access,origin:'https://magisform-test.workers.dev',cookie:`__Secure-magisform_platform_csrf=${csrf}`,'x-csrf-token':csrf,'content-type':'application/json'},body:JSON.stringify({})});
    expect(login.status).toBe(200);
    const loginBody=await login.json() as any;
    const cookie=login.headers.get('set-cookie') ?? '';
    const session=/__Secure-magisform_platform_session=([^;,\s]+)/.exec(cookie)?.[1];
    const platformCsrf=loginBody.data.csrfToken;
    const headers={'cf-access-jwt-assertion':access,cookie:`__Secure-magisform_platform_session=${session}; __Secure-magisform_platform_csrf=${platformCsrf}`,'x-csrf-token':platformCsrf,origin:'https://magisform-test.workers.dev','content-type':'application/json'};
    const create=await invoke(`${root}/installations`,{method:'POST',headers,body:JSON.stringify({slug:'farmacia-plataforma',name:'Farmácia Plataforma',admin_email:'platform-c@example.test',admin_name:'Admin Plataforma',brand:'Marca Plataforma',brand_theme:{primary:'#173E35'}})});
    expect(create.status).toBe(201);
    const suspended=await invoke(`${root}/installations/farmacia-plataforma`,{method:'PATCH',headers,body:JSON.stringify({status:'suspended'})});
    expect(suspended.status).toBe(200);
    const suspendedAccess=await invoke('https://magisform-test.workers.dev/t/farmacia-plataforma/api/v1/auth/csrf',{headers:{'cf-access-jwt-assertion':access}});
    expect(suspendedAccess.status).toBe(403);
    const tenants=(await (await invoke(`${root}/installations`,{headers})).json() as any).data;
    expect(tenants.find((tenant:any)=>tenant.slug==='farmacia-plataforma').status).toBe('suspended');
    const tenantRoleToken=await accessToken('subject-a','a@example.test');
    const forbidden=await invoke(`${root}/installations`,{headers:{'cf-access-jwt-assertion':tenantRoleToken}});
    expect(forbidden.status).toBe(401);
    const visible=await invoke('https://magisform-test.workers.dev/api/platform/v1/tenants',{headers:{'cf-access-jwt-assertion':tenantRoleToken}});
    expect(visible.status).toBe(200);
    expect((await visible.json() as any).data.map((tenant:any)=>tenant.slug)).toContain('farmacia-a');
  });

  it('preserva o último administrador ativo da farmácia no próprio D1',async()=>{
    const trigger=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='preserve_last_active_tenant_admin'").first<{name:string}>();
    expect(trigger?.name).toBe('preserve_last_active_tenant_admin');
    const admins=await env.DB.prepare("SELECT id FROM users WHERE tenant_id=7003 AND active=1 AND role='admin'").all();
    expect(admins.results).toHaveLength(1);
    await expect(env.DB.prepare("UPDATE users SET role='employee' WHERE tenant_id=7003 AND id=8003").run()).rejects.toThrow(/last active tenant administrator/);
    const admin=await env.DB.prepare('SELECT role,active FROM users WHERE tenant_id=7003 AND id=8003').first<{role:string;active:number}>();
    expect(admin).toEqual({role:'admin',active:1});
  });
});
