const UNSUPPORTED_AUTH_PLUGIN = 'auth_gssapi_client';

const GSSAPI_HELP = [
  'O servidor MariaDB esta exigindo autenticacao Windows/GSSAPI, que nao e suportada pelo cliente atual do app.',
  'Crie ou altere o usuario para usar senha normal no MariaDB, por exemplo: ALTER USER CURRENT_USER() IDENTIFIED VIA mysql_native_password USING PASSWORD(\'sua_senha\');',
].join(' ');

export function isUnsupportedAuthPluginError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes(UNSUPPORTED_AUTH_PLUGIN);
}

export function formatDbError(error: unknown): string {
  if (isUnsupportedAuthPluginError(error)) {
    return GSSAPI_HELP;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return 'Erro desconhecido ao conectar ao banco.';
}

// Erro de regra de negócio que pode ser apresentado sem expor detalhes do banco.
export class BusinessRuleError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message); }
}
