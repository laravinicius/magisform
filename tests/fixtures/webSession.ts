import type { FastifyInstance } from 'fastify';

export async function csrfHeaders(app: FastifyInstance, origin = 'http://127.0.0.1:3001') {
  const csrf = await app.inject('/api/v1/auth/csrf');
  const cookie = String(csrf.headers['set-cookie']).split(';')[0];
  return { origin, cookie, 'x-csrf-token': csrf.json().data.csrfToken as string };
}

export async function webLogin(app: FastifyInstance, username: string, password: string, force = false) {
  const headers = await csrfHeaders(app);
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: { username, password, force } });
  const sessionCookie = String(response.headers['set-cookie'] ?? '').split(';')[0];
  return { response, headers: { ...headers, cookie: `${headers.cookie}; ${sessionCookie}` } };
}
