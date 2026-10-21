// Sessão web para QA HTTPS: cookie host-only e CSRF, sem expor token no JSON.
export async function loginSession(request, host, username, password, force = false) {
  const csrf = await request(host, '/api/v1/auth/csrf');
  const csrfCookie = (csrf.headers?.['set-cookie'] ?? []).map(value => value.split(';')[0]).join('; ');
  const session = { cookie: csrfCookie, csrf: (csrf.json ?? csrf.payload)?.data?.csrfToken };
  const response = await request(host, '/api/v1/auth/login', { method: 'POST', session, body: { username, password, force } });
  session.cookie += '; ' + (response.headers?.['set-cookie'] ?? []).map(value => value.split(';')[0]).join('; ');
  return { ...response, session };
}
export const sessionHeaders = (host, port, session) => session ? {
  origin: `https://${host}:${port}`, cookie: session.cookie, 'x-csrf-token': session.csrf,
} : {};
