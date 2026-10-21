// Servidor de captura: usa o renderer atual sem acessar MariaDB.
import { createServer } from 'vite';
import { demoData } from './demo-data.mjs';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const server = await createServer({
  configFile: false,
  optimizeDeps: { entries: ['index.html'] },
  root,
  plugins: [react(), tailwindcss(), {
    name: 'magisform-captura-isolada',
    configureServer(server) {
      const fixtures = demoData();
      let authenticated = false;
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url, 'http://127.0.0.1:5175');
        if (!url.pathname.startsWith('/api/')) return next();
        const route = url.pathname.replace('/api/v1', '');
        res.setHeader('Content-Type', 'application/json');
        const send = data => res.end(JSON.stringify({ data }));
        if (route === '/public-config') return send({ installationName: 'MagisForm Demo', brand: 'MagisForm', version, capabilities: ['web'] });
        if (route === '/auth/csrf') return send({ csrfToken: 'captura-ficticia' });
        if (route === '/auth/login' && req.method === 'POST') { authenticated = true; return send({ user: fixtures.user }); }
        if (route === '/auth/logout' && req.method === 'POST') { authenticated = false; return send({ success: true }); }
        if (route === '/auth/me' || route === '/auth/heartbeat') {
          if (!authenticated) { res.statusCode = 401; return res.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Entre na demonstração.' } })); }
          return send({ authenticated: true, valid: true, user: fixtures.user });
        }
        if (authenticated && req.method === 'GET') {
          if (route === '/formulas') {
            let rows = fixtures.formulas;
            const statuses = url.searchParams.get('statuses')?.split(',');
            if (statuses) rows = rows.filter(row => statuses.includes(row.status));
            if (url.searchParams.get('deliveryStatus')) rows = rows.filter(row => row.delivery_status === url.searchParams.get('deliveryStatus'));
            return send({ rows, nextCursor: null, total: rows.length, limit: Number(url.searchParams.get('limit') ?? 50) });
          }
          if (route === '/formulas-summary') return send({ total: 9, pending: 2, confirmed: 5, delivered: 2, cancelled: 0, deliveredMonthlyTotal: 320 });
          const data = { '/users': [fixtures.user], '/customers': fixtures.customers, '/insumos': fixtures.insumos, '/saved-formulas': [], '/logs': { rows: [], total: 0 } }[route];
          if (data !== undefined) return send(data);
          const formula = route.match(/^\/formulas\/(\d+)$/);
          if (formula) return send(fixtures.formulas.find(row => row.id === Number(formula[1])) ?? null);
        }
        res.statusCode = 403;
        res.end(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Operação bloqueada no ambiente de captura.' } }));
      });
    },
  }],
  resolve: { alias: { '@': path.resolve(root) } },
  server: { host: '127.0.0.1', port: 5175, strictPort: true },
});
await server.listen();
console.log('Renderer isolado: http://127.0.0.1:5175/ — somente dados fictícios.');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => { await server.close(); process.exit(0); });
}
