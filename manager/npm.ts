import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, X509Certificate } from 'node:crypto';

type NpmCredentials = { identity: string; secret: string };
type NpmCertificate = { id: number; domain_names: string[]; provider: string; meta?: { certificate?: string } };
type NpmProxyHost = { id: number; domain_names: string[]; forward_host: string; forward_port: number; certificate_id?: number; ssl_forced?: boolean; meta?: { nginx_online?: boolean; nginx_err?: string | null } };

export class NpmApiError extends Error {
  constructor(readonly status: number, message = 'A API do Nginx Proxy Manager recusou a operação.') {
    super(message);
    this.name = 'NpmApiError';
  }
}

export class NpmClient {
  private token = '';
  constructor(
    private readonly baseUrl: string,
    private readonly credentials: NpmCredentials,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Endereço interno da API NPM inválido.');
  }

  static async fromFile(baseUrl: string, file: string): Promise<NpmClient> {
    const credentials = JSON.parse(await readFile(file, 'utf8')) as NpmCredentials;
    if (!credentials.identity || !credentials.secret) throw new Error('Credenciais NPM inválidas.');
    return new NpmClient(baseUrl, credentials);
  }

  private async request<T>(method: string, endpoint: string, payload?: unknown, retried = false): Promise<T> {
    if (!this.token && endpoint !== '/tokens') await this.authenticate();
    const multipart = payload instanceof FormData;
    const response = await this.fetcher(new URL(endpoint.replace(/^\//, ''), `${this.baseUrl.replace(/\/$/, '')}/`), {
      method,
      headers: { ...(payload === undefined || multipart ? {} : { 'content-type': 'application/json' }), ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      ...(payload === undefined ? {} : { body: multipart ? payload : JSON.stringify(payload) }),
      signal: AbortSignal.timeout(method === 'POST' && endpoint === '/nginx/certificates' ? 180_000 : 20_000),
    });
    if (response.status === 401 && endpoint !== '/tokens' && !retried) {
      this.token = '';
      await this.authenticate();
      return this.request<T>(method, endpoint, payload, true);
    }
    if (!response.ok) throw new NpmApiError(response.status);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  private async authenticate(): Promise<void> {
    const result = await this.request<{ token: string }>('POST', '/tokens', { identity: this.credentials.identity, secret: this.credentials.secret });
    if (!result.token) throw new NpmApiError(502, 'A API NPM não retornou token de sessão.');
    this.token = result.token;
  }

  async ensureCertificate(input: { host: string; publicMode: boolean; email?: string; localCertificate?: { certificate: string; key: string; domainNames?: string[] } }): Promise<number> {
    const certificates = await this.request<NpmCertificate[]>('GET', '/nginx/certificates');
    const existing = certificates.find((certificate) => (certificate.domain_names?.includes(input.host) || certificate.domain_names?.some((domain) => domain.startsWith('*.') && input.host.endsWith(domain.slice(1)))) && (input.publicMode ? certificate.provider === 'letsencrypt' : certificate.provider === 'other'));
    if (existing) {
      if (!input.publicMode && input.localCertificate) await this.uploadLocalCertificate(existing.id, input.localCertificate);
      return existing.id;
    }
    const payload = input.publicMode
      ? { provider: 'letsencrypt', nice_name: `MagisForm ${input.host}`, domain_names: [input.host], meta: { dns_challenge: false } }
      : input.localCertificate
        ? { provider: 'other', nice_name: `MagisForm teste ${input.host}`, domain_names: input.localCertificate.domainNames ?? [input.host], meta: { certificate: input.localCertificate.certificate, certificate_key: input.localCertificate.key } }
        : null;
    if (!payload) throw new Error('Certificado de teste ausente para o domínio local.');
    const created = await this.request<{ id: number }>('POST', '/nginx/certificates', payload);
    if (!created.id) throw new NpmApiError(502, 'A API NPM não retornou o certificado criado.');
    if (!input.publicMode && input.localCertificate) await this.uploadLocalCertificate(created.id, input.localCertificate);
    return created.id;
  }

  private async uploadLocalCertificate(id: number, input: { certificate: string; key: string }): Promise<void> {
    // O cadastro JSON não grava os PEMs no volume do NPM; o upload é obrigatório.
    const files = new FormData();
    files.append('certificate', new Blob([input.certificate], { type: 'application/x-pem-file' }), 'certificate.pem');
    files.append('certificate_key', new Blob([input.key], { type: 'application/x-pem-file' }), 'privkey.pem');
    await this.request('POST', `/nginx/certificates/${id}/upload`, files);
  }

  async ensureLocalCertificate(input: { domainNames: string[]; certificate: string; key: string }): Promise<number> {
    const certificates = await this.request<NpmCertificate[]>('GET', '/nginx/certificates');
    const existing = certificates.find((certificate) => {
      if (certificate.provider !== 'other') return false;
      if (input.domainNames.every((name) => certificate.domain_names?.includes(name))) return true;
      // Após upload, o NPM lista somente o CN; confira os SANs do PEM para reutilizar o ID.
      if (!certificate.meta?.certificate) return false;
      try {
        const pem = new X509Certificate(certificate.meta.certificate);
        return input.domainNames.every((name) => Boolean(pem.checkHost(name)));
      } catch { return false; }
    });
    if (existing) {
      await this.uploadLocalCertificate(existing.id, input);
      return existing.id;
    }
    const created = await this.request<{ id: number }>('POST', '/nginx/certificates', {
      provider: 'other', nice_name: `MagisForm teste ${input.domainNames[0]}`, domain_names: input.domainNames,
      meta: { certificate: input.certificate, certificate_key: input.key },
    });
    if (!created.id) throw new NpmApiError(502, 'A API NPM não retornou o certificado local criado.');
    await this.uploadLocalCertificate(created.id, input);
    return created.id;
  }

  async ensureProxyHost(input: { host: string; forwardHost: string; forwardPort: number; certificateId: number; secure: boolean }): Promise<number> {
    const hosts = await this.request<NpmProxyHost[]>('GET', '/nginx/proxy-hosts');
    const existing = hosts.find((item) => item.domain_names?.includes(input.host));
    const payload = {
      domain_names: [input.host], forward_scheme: 'http', forward_host: input.forwardHost, forward_port: input.forwardPort,
      certificate_id: input.certificateId, ssl_forced: input.secure, hsts_enabled: input.secure,
      hsts_subdomains: false, trust_forwarded_proto: true, http2_support: true,
      block_exploits: true, caching_enabled: false, allow_websocket_upgrade: true,
      access_list_id: 0, advanced_config: 'access_log off;', enabled: true, meta: {}, locations: [],
    };
    if (existing) {
      if (existing.forward_host !== input.forwardHost || existing.forward_port !== input.forwardPort) throw new Error('O domínio já pertence a um Proxy Host com destino diferente.');
      if (existing.certificate_id !== input.certificateId || existing.ssl_forced !== input.secure) throw new Error('O domínio já pertence a um Proxy Host com configuração TLS divergente.');
      const repaired = await this.request<NpmProxyHost>('PUT', `/nginx/proxy-hosts/${existing.id}`, payload);
      if (repaired.meta?.nginx_online === false) throw new NpmApiError(502, 'O Nginx recusou a configuração do Proxy Host. Verifique o certificado e o destino no NPM.');
      return existing.id;
    }
    const created = await this.request<NpmProxyHost>('POST', '/nginx/proxy-hosts', payload);
    if (!created.id) throw new NpmApiError(502, 'A API NPM não retornou o Proxy Host criado.');
    if (created.meta?.nginx_online === false) throw new NpmApiError(502, 'O Nginx recusou a configuração do Proxy Host. Verifique o certificado e o destino no NPM.');
    return created.id;
  }

  async removeProxyHost(id: number): Promise<void> {
    await this.request('DELETE', `/nginx/proxy-hosts/${id}`);
  }
}

export async function bootstrapNpmCredentials(baseUrl: string, credentialsFile: string, initialPassword: string, accountEmail?: string): Promise<void> {
  const apiUrl = (endpoint: string) => new URL(endpoint.replace(/^\//, ''), `${baseUrl.replace(/\/$/, '')}/`);
  const updateEmail = async (credentials: NpmCredentials) => {
    if (!accountEmail) return credentials;
    const tokenResponse = await fetch(apiUrl('tokens'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials), signal: AbortSignal.timeout(10_000) });
    if (!tokenResponse.ok) throw new Error('Não foi possível autenticar para atualizar o e-mail de certificados do NPM.');
    const { token } = await tokenResponse.json() as { token?: string };
    if (!token) throw new Error('A API NPM não retornou token ao atualizar o e-mail.');
    const response = await fetch(apiUrl('users/1'), { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ email: accountEmail, name: 'MagisForm', nickname: 'MagisForm' }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new NpmApiError(response.status, 'Não foi possível salvar o e-mail de certificados no usuário administrador do NPM.');
    return { ...credentials, identity: accountEmail };
  };
  try {
    const stored = JSON.parse(await readFile(credentialsFile, 'utf8')) as NpmCredentials;
    const credentials = await updateEmail(stored);
    if (credentials.identity !== stored.identity) await writeFile(credentialsFile, JSON.stringify(credentials) + '\n', { mode: 0o600 });
    else {
      const response = await fetch(apiUrl('tokens'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(stored), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('Credencial NPM armazenada não autentica.');
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const identity = 'admin@example.com';
  const login = await fetch(apiUrl('tokens'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identity, secret: initialPassword }), signal: AbortSignal.timeout(10_000),
  });
  if (!login.ok) throw new Error('Não foi possível autenticar na conta inicial criada pelo NPM; verifique os logs do NPM e o estado persistido.');
  const { token } = await login.json() as { token?: string };
  if (!token) throw new Error('A API NPM não retornou token durante a inicialização.');
  const secret = randomBytes(36).toString('base64url');
  const changed = await fetch(apiUrl('users/1/auth'), {
    method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'password', current: initialPassword, secret }), signal: AbortSignal.timeout(10_000),
  });
  if (!changed.ok) throw new NpmApiError(changed.status, 'Não foi possível substituir a senha inicial do NPM.');
  await mkdir(path.dirname(credentialsFile), { recursive: true, mode: 0o700 });
  const stored = await updateEmail({ identity, secret });
  await writeFile(credentialsFile, JSON.stringify(stored) + '\n', { flag: 'wx', mode: 0o600 });
}
