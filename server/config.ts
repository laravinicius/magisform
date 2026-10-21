import { z } from 'zod';
import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import proxyAddr from '@fastify/proxy-addr';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MAGISFORM_SERVER_HOST: z.string().default('127.0.0.1'),
  MAGISFORM_SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  MAGISFORM_SERVER_ORIGIN: z.string().url().optional(),
  MAGISFORM_SERVER_ALLOW_HOST_WITHOUT_PORT: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  MAGISFORM_SERVER_TRUST_PROXY: z.string().default(''),
  MAGISFORM_SERVER_INSTALLATION_NAME: z.string().trim().min(1).max(100).default('MagisForm'),
  MAGISFORM_SERVER_BRAND: z.string().trim().min(1).max(80).default('MagisForm'),
  MAGISFORM_SERVER_BRAND_PRIMARY: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#D95C4F'),
  MAGISFORM_SERVER_BRAND_SECONDARY: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#173E35'),
  MAGISFORM_SERVER_BRAND_BACKGROUND: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#F4F1E9'),
  MAGISFORM_SERVER_BRAND_SURFACE: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#FFFDF8'),
  MAGISFORM_SERVER_BRAND_INK: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#17201D'),
  MAGISFORM_SERVER_BRAND_MUTED: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#5F6965'),
  MAGISFORM_SERVER_VERSION: z.string().trim().min(1).max(40).default('0.2.4'),
  MAGISFORM_SERVER_DB_HOST: z.string().min(1),
  MAGISFORM_SERVER_DB_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
  MAGISFORM_SERVER_DB_NAME: z.string().min(1),
  MAGISFORM_SERVER_DB_USER: z.string().min(1),
  MAGISFORM_SERVER_DB_PASSWORD: z.string().default(''),
  MAGISFORM_SERVER_DB_PASSWORD_FILE: z.string().optional(),
  MAGISFORM_SERVER_DB_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(50).default(10),
  MAGISFORM_SERVER_SESSION_IDLE_HOURS: z.coerce.number().int().min(1).max(8).default(8),
  MAGISFORM_SERVER_SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(24).default(24),
});

export type ServerConfig = ReturnType<typeof loadConfig>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Configuração do servidor inválida: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  const value = parsed.data;
  const dbPassword = value.MAGISFORM_SERVER_DB_PASSWORD_FILE
    ? readFileSync(value.MAGISFORM_SERVER_DB_PASSWORD_FILE, 'utf8').replace(/[\r\n]+$/, '')
    : value.MAGISFORM_SERVER_DB_PASSWORD;
  if (value.MAGISFORM_SERVER_SESSION_ABSOLUTE_HOURS < value.MAGISFORM_SERVER_SESSION_IDLE_HOURS) throw new Error('A validade absoluta deve ser maior ou igual à inatividade máxima.');
  const proxyAddresses = value.MAGISFORM_SERVER_TRUST_PROXY.split(',').map((entry) => entry.trim()).filter(Boolean);
  try { if (proxyAddresses.length) proxyAddr.compile(proxyAddresses); }
  catch { throw new Error('MAGISFORM_SERVER_TRUST_PROXY deve conter somente IPs/CIDRs de proxy confiáveis separados por vírgula.'); }
  const trustProxy: false | string[] = proxyAddresses.length ? proxyAddresses : false;
  if (value.NODE_ENV === 'production' && (!value.MAGISFORM_SERVER_ORIGIN || new URL(value.MAGISFORM_SERVER_ORIGIN).protocol !== 'https:')) throw new Error('Produção exige MAGISFORM_SERVER_ORIGIN HTTPS canônico.');
  const configuredOrigin = value.MAGISFORM_SERVER_ORIGIN ? new URL(value.MAGISFORM_SERVER_ORIGIN) : undefined;
  if (configuredOrigin && (configuredOrigin.username || configuredOrigin.password || configuredOrigin.pathname !== '/' || configuredOrigin.search || configuredOrigin.hash)) throw new Error('MAGISFORM_SERVER_ORIGIN deve conter somente o origin canônico, sem credenciais ou caminho.');
  if (value.NODE_ENV === 'production' && !dbPassword) throw new Error('Produção exige senha de banco não vazia.');
  const loopback = (host: string) => host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  if (value.NODE_ENV !== 'production' && (!loopback(value.MAGISFORM_SERVER_HOST) || (configuredOrigin && !loopback(configuredOrigin.hostname)))) throw new Error('Desenvolvimento sem TLS deve usar host e origin de loopback.');
  const origin = configuredOrigin ? configuredOrigin.origin : `http://${value.MAGISFORM_SERVER_HOST}:${value.MAGISFORM_SERVER_PORT}`;
  const secure = value.NODE_ENV === 'production';
  return {
    mode: value.NODE_ENV, host: value.MAGISFORM_SERVER_HOST, port: value.MAGISFORM_SERVER_PORT,
    origin, secure, trustProxy, allowHostWithoutPort: value.MAGISFORM_SERVER_ALLOW_HOST_WITHOUT_PORT, installationName: value.MAGISFORM_SERVER_INSTALLATION_NAME,
    brand: value.MAGISFORM_SERVER_BRAND,
    brandTheme: { primary: value.MAGISFORM_SERVER_BRAND_PRIMARY, secondary: value.MAGISFORM_SERVER_BRAND_SECONDARY, background: value.MAGISFORM_SERVER_BRAND_BACKGROUND, surface: value.MAGISFORM_SERVER_BRAND_SURFACE, ink: value.MAGISFORM_SERVER_BRAND_INK, muted: value.MAGISFORM_SERVER_BRAND_MUTED },
    version: value.MAGISFORM_SERVER_VERSION,
    sessionIdleHours: value.MAGISFORM_SERVER_SESSION_IDLE_HOURS,
    sessionAbsoluteHours: value.MAGISFORM_SERVER_SESSION_ABSOLUTE_HOURS,
    db: { host: value.MAGISFORM_SERVER_DB_HOST, port: value.MAGISFORM_SERVER_DB_PORT, database: value.MAGISFORM_SERVER_DB_NAME, user: value.MAGISFORM_SERVER_DB_USER, password: dbPassword, connectionLimit: value.MAGISFORM_SERVER_DB_CONNECTION_LIMIT },
  };
}
