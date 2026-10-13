import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { bootstrapNpmCredentials, NpmClient } from '../manager/npm.js';

function mockNpmFetch() {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ url, method, body });
    if (url.endsWith('/tokens')) return new Response(JSON.stringify({ token: 'unit-token' }), { status: 200 });
    if (url.endsWith('/nginx/certificates') && method === 'GET') return new Response(JSON.stringify([{ id: 42, provider: 'other', domain_names: ['*.magisform.test', 'magisform.test'] }]), { status: 200 });
    if (url.endsWith('/nginx/proxy-hosts') && method === 'GET') return new Response('[]', { status: 200 });
    if (url.endsWith('/nginx/proxy-hosts') && method === 'POST') return new Response(JSON.stringify({ id: 91 }), { status: 201 });
    if (url.endsWith('/nginx/certificates') && method === 'POST') return new Response(JSON.stringify({ id: 43 }), { status: 201 });
    return new Response('{}', { status: 200 });
  });
  return { calls, fetcher };
}

describe('Integração com Nginx Proxy Manager', () => {
  it('reusa certificado wildcard de teste e cria Proxy Host protegido', async () => {
    const { calls, fetcher } = mockNpmFetch();
    const npm = new NpmClient('http://npm:81/api', { identity: 'operator@example.test', secret: 'secret-value' }, fetcher);
    const certificateId = await npm.ensureCertificate({ host: 'farmacia-a.magisform.test', publicMode: false });
    const proxyHostId = await npm.ensureProxyHost({ host: 'farmacia-a.magisform.test', forwardHost: 'mf-farmacia-a', forwardPort: 3001, certificateId, secure: true });

    expect(certificateId).toBe(42);
    expect(proxyHostId).toBe(91);
    const payload = calls.find((call) => call.method === 'POST' && call.url.endsWith('/nginx/proxy-hosts'))?.body;
    expect(payload).toMatchObject({ domain_names: ['farmacia-a.magisform.test'], forward_host: 'mf-farmacia-a', forward_port: 3001, certificate_id: 42, ssl_forced: true, block_exploits: true, allow_websocket_upgrade: true });
    expect(payload?.advanced_config).toBe('access_log off;');
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/nginx/certificates'))).toBe(false);
  });

  it("solicita certificado individual Let's Encrypt no modo público", async () => {
    const { calls, fetcher } = mockNpmFetch();
    const npm = new NpmClient('http://npm:81/api', { identity: 'operator@example.test', secret: 'secret-value' }, fetcher);
    const certificateId = await npm.ensureCertificate({ host: 'farmacia.example.com', publicMode: true, email: 'admin@example.com' });
    const payload = calls.find((call) => call.method === 'POST' && call.url.endsWith('/nginx/certificates'))?.body;

    expect(certificateId).toBe(43);
    expect(payload).toMatchObject({ provider: 'letsencrypt', domain_names: ['farmacia.example.com'], meta: { dns_challenge: false } });
  });

  it('grava os PEMs via multipart após cadastrar um certificado local', async () => {
    const { fetcher } = mockNpmFetch();
    const npm = new NpmClient('http://npm:81/api', { identity: 'operator', secret: 'secret' }, fetcher);
    const id = await npm.ensureLocalCertificate({ domainNames: ['novo.test'], certificate: 'PEM-CERT', key: 'PEM-KEY' });
    expect(id).toBe(43);
    const call = vi.mocked(fetcher).mock.calls.find(([url]) => String(url).endsWith('/nginx/certificates/43/upload'));
    const files = call?.[1]?.body as FormData;
    expect(files).toBeInstanceOf(FormData);
    expect(await (files.get('certificate') as Blob).text()).toBe('PEM-CERT');
    expect(await (files.get('certificate_key') as Blob).text()).toBe('PEM-KEY');
    expect(call?.[1]?.headers).not.toHaveProperty('content-type');
  });

  it('refaz o upload no certificado existente para recuperar instalações incompletas', async () => {
    const { calls, fetcher } = mockNpmFetch();
    const npm = new NpmClient('http://npm:81/api', { identity: 'operator', secret: 'secret' }, fetcher);
    expect(await npm.ensureLocalCertificate({ domainNames: ['*.magisform.test'], certificate: 'CERT', key: 'KEY' })).toBe(42);
    expect(calls.some((call) => call.url.endsWith('/nginx/certificates/42/upload'))).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/nginx/certificates') && call.method === 'POST')).toBe(false);
  });

  it('reusa o ID quando o NPM lista só o CN e o PEM contém os SANs solicitados', async () => {
    const certificate = `-----BEGIN CERTIFICATE-----
MIIDRTCCAi2gAwIBAgIUapJ47bgLLGM6XforxMrCYHoWFocwDQYJKoZIhvcNAQEL
BQAwGzEZMBcGA1UEAwwQKi5tYWdpc2Zvcm0udGVzdDAeFw0yNjEwMTMxMTMwNTVa
Fw0yNjEwMTQxMTMwNTVaMBsxGTAXBgNVBAMMECoubWFnaXNmb3JtLnRlc3QwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDGuuIYPrKeG0cQZW25OmPMSoUg
Fi9RD5VvTJkNVposajH8vMaBvJce97DHiv7x7PGb7QAMvbnyEJAnE7OLmR+VPq/X
b9EsE2anRNrKP3aw3Fc30bJqcpuwv+kjuAklM5AcUtJHTmjgo7RLm7BeZrMNDroi
auSlbgzxQI2FAnHOkM+Ui8zAfJtLU3o3tBFqPWKugLpad6Q0/Q3g3o/KYgE2kI/m
8Z59TcCwUSh25rqM1yYAAg/LTijNUeLYtGDCST8TMxaykWhENuN6rCCcW/lAOCRo
OANp/HdwFVc3nlXoHmHIu/P3oceoAKnU0JP56lFKZ3+vKmgBvKsCHxYNzXY/AgMB
AAGjgYAwfjAdBgNVHQ4EFgQUjFiQpOL8uy4gvGoJ8L4zPSbEFkwwHwYDVR0jBBgw
FoAUjFiQpOL8uy4gvGoJ8L4zPSbEFkwwDwYDVR0TAQH/BAUwAwEB/zArBgNVHREE
JDAighAqLm1hZ2lzZm9ybS50ZXN0gg5tYWdpc2Zvcm0udGVzdDANBgkqhkiG9w0B
AQsFAAOCAQEARGxwKYqCeuHPYfkUkk0LM+ovbYYW87aR70d++FySoPOW6nga+pC4
IZK2Xmt3e2BhnMR4vOzMHK5fR73Y4Letwc4AHy2Uf1rPtWggjaVnHM8WfU//Ay7u
mHaUXVzimzfQ/Cl4OCH7IcFYgL6V9QnZyUuqmTFOOlP1cmR+xybPNXuxrKHXIrdS
62cqUXv4/EiJmIqNjffXocIZyx9DwHqtpJtoGh5VhhulsLbQ4Cc06QU+6CAQl74r
zsPeEhc59W+ssgSsobKe7hNyXjw8YTTb+EW0eUPHnn5+hWU9+D4JkAhKlsHRbZSG
wrhRFvcoZJ4VVSGECU+x1O2KgNzmOSCUtg==
-----END CERTIFICATE-----
`;
    const { fetcher } = mockNpmFetch();
    const cnOnlyFetch: typeof fetch = async (url, init) => String(url).endsWith('/nginx/certificates') && init?.method === 'GET'
      ? new Response(JSON.stringify([{ id: 42, provider: 'other', domain_names: ['*.magisform.test'], meta: { certificate } }])) : fetcher(url, init);
    const npm = new NpmClient('http://npm:81/api', { identity: 'operator', secret: 'secret' }, cnOnlyFetch);
    expect(await npm.ensureLocalCertificate({ domainNames: ['*.magisform.test', 'magisform.test'], certificate, key: 'KEY' })).toBe(42);
  });

  it('não anuncia certificado pronto quando o upload falha', async () => {
    const { fetcher } = mockNpmFetch();
    const failUpload: typeof fetch = async (url, init) => String(url).endsWith('/upload')
      ? new Response('{}', { status: 400 }) : fetcher(url, init);
    const npm = new NpmClient('http://npm:81/api', { identity: 'operator', secret: 'secret' }, failUpload);
    await expect(npm.ensureCertificate({ host: 'novo.test', publicMode: false, localCertificate: { certificate: 'CERT', key: 'KEY' } })).rejects.toMatchObject({ status: 400 });
  });

  it('reaplica uma rota existente recusada pelo Nginx após recuperar o certificado', async () => {
    const { fetcher } = mockNpmFetch();
    const host = { id: 91, domain_names: ['gestao.magisform.test'], forward_host: 'api', forward_port: 3003, certificate_id: 42, ssl_forced: true };
    const requests: string[] = [];
    const offlineFetch: typeof fetch = async (url, init) => {
      requests.push(`${init?.method} ${url}`);
      if (String(url).endsWith('/nginx/proxy-hosts')) return new Response(JSON.stringify([{ ...host, meta: { nginx_online: false } }]));
      if (String(url).endsWith('/nginx/proxy-hosts/91')) return new Response(JSON.stringify({ ...host, meta: { nginx_online: true } }));
      return fetcher(url, init);
    };
    const npm = new NpmClient('http://npm:81/api', { identity: 'operator', secret: 'secret' }, offlineFetch);
    expect(await npm.ensureProxyHost({ host: host.domain_names[0], forwardHost: 'api', forwardPort: 3003, certificateId: 42, secure: true })).toBe(91);
    expect(requests).toContain('PUT http://npm:81/api/nginx/proxy-hosts/91');
  });

  it('recusa criação de rota que o Nginx não conseguiu ativar', async () => {
    const { fetcher } = mockNpmFetch();
    const offlineFetch: typeof fetch = async (url, init) => String(url).endsWith('/nginx/proxy-hosts') && init?.method === 'POST'
      ? new Response(JSON.stringify({ id: 91, meta: { nginx_online: false } })) : fetcher(url, init);
    const npm = new NpmClient('http://npm:81/api', { identity: 'operator', secret: 'secret' }, offlineFetch);
    await expect(npm.ensureProxyHost({ host: 'gestao.magisform.test', forwardHost: 'api', forwardPort: 3003, certificateId: 42, secure: true })).rejects.toThrow('Nginx recusou');
  });

  it('usa a senha inicial provisionada, rotaciona a credencial e registra e-mail próprio no NPM', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'magisform-npm-test-'));
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const fetcher: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input); const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      calls.push({ url, method, body });
      if (url.endsWith('/tokens')) return new Response(JSON.stringify({ token: 'unit-token' }), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      const file = path.join(directory, 'npm-credentials.json');
      const initialPassword = 'random-initial-password-from-compose-secret';
      await bootstrapNpmCredentials('http://npm:81/api', file, initialPassword, 'operador@example.com');
      const credentials = JSON.parse(await readFile(file, 'utf8')) as { identity: string; secret: string };

      expect(credentials.identity).toBe('operador@example.com');
      expect(credentials.secret).not.toBe(initialPassword);
      expect(credentials.secret.length).toBeGreaterThanOrEqual(40);
      expect(calls.some((call) => call.url.endsWith('/tokens') && call.body?.identity === 'admin@example.com' && call.body?.secret === initialPassword)).toBe(true);
      expect(calls.some((call) => call.url.endsWith('/users/1/auth') && call.body?.current === initialPassword)).toBe(true);
      expect(calls.some((call) => call.url.endsWith('/users/1') && call.body?.email === 'operador@example.com')).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
