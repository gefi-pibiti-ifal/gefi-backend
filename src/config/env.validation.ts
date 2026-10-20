/**
 * Validacao das variaveis de ambiente, executada UMA vez no boot.
 *
 * Por que existir: antes desta funcao, `JWT_SECRET` tinha fallback literal no
 * codigo (`process.env.JWT_SECRET || 'gefi_secret_key_2026'`, em auth.module.ts
 * e jwt.strategy.ts). Um deploy que esquecesse a env subia normalmente e
 * assinava tokens com um segredo publicado no repositorio -- qualquer pessoa
 * com acesso ao codigo forjava um token de ADMINISTRADOR.
 *
 * A regra aqui e: falta de config e falha de BOOT, nao degradacao silenciosa.
 * E melhor o container morrer com uma mensagem legivel do que servir trafego
 * autenticado com um segredo conhecido.
 */

/** Valor do fallback removido. Recusado explicitamente para o caso de alguem copiar do historico do git. */
const SEGREDO_VAZADO = 'gefi_secret_key_2026';

const TAMANHO_MINIMO_SEGREDO = 32;

export interface EnvConfig {
  NODE_ENV: string;
  PORT: number;
  DATABASE_URL: string;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  GOOGLE_CLIENT_ID: string;
  /** Vazio => a allowlist (tabela users) e o unico controle. */
  GOOGLE_ALLOWED_HD: string;
  BOOTSTRAP_ADMIN_EMAILS: string[];
  COOKIE_SECURE: boolean;
  CORS_ORIGIN: string[];
}

function exigir(
  raw: Record<string, unknown>,
  chave: string,
  comoGerar?: string,
): string {
  const valor = typeof raw[chave] === 'string' ? raw[chave].trim() : '';
  if (!valor) {
    throw new Error(
      `[config] ${chave} e obrigatoria e nao foi definida.` +
        (comoGerar ? ` ${comoGerar}` : ''),
    );
  }
  return valor;
}

function lerBooleano(valor: unknown, padrao: boolean): boolean {
  if (valor === undefined || valor === null || valor === '') return padrao;
  if (typeof valor === 'boolean') return valor;

  if (typeof valor !== 'string') {
    throw new Error('[config] Valor booleano invalido: esperava true ou false.');
  }

  const normalizado = valor.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalizado)) return true;
  if (['false', '0', 'no', 'off'].includes(normalizado)) return false;

  throw new Error(`[config] Valor booleano invalido: "${valor}". Use true ou false.`);
}

/** Divide uma lista separada por virgulas, descartando espacos e itens vazios. */
function lerLista(valor: unknown): string[] {
  if (typeof valor !== 'string') return [];
  return valor
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function validate(raw: Record<string, unknown>): EnvConfig {
  const NODE_ENV =
    (typeof raw.NODE_ENV === 'string' && raw.NODE_ENV) || 'development';

  const JWT_SECRET = exigir(
    raw,
    'JWT_SECRET',
    'Gere com: openssl rand -hex 64',
  );

  if (JWT_SECRET === SEGREDO_VAZADO) {
    throw new Error(
      '[config] JWT_SECRET e o valor de exemplo que ja esteve versionado neste repositorio. ' +
        'Gere um novo: openssl rand -hex 64',
    );
  }

  if (JWT_SECRET.length < TAMANHO_MINIMO_SEGREDO) {
    throw new Error(
      `[config] JWT_SECRET tem ${JWT_SECRET.length} caracteres; o minimo e ${TAMANHO_MINIMO_SEGREDO}. ` +
        'Gere com: openssl rand -hex 64',
    );
  }

  const GOOGLE_CLIENT_ID = exigir(
    raw,
    'GOOGLE_CLIENT_ID',
    'Pegue em console.cloud.google.com > APIs & Services > Credentials > OAuth 2.0 Client ID.',
  );

  if (!GOOGLE_CLIENT_ID.endsWith('.apps.googleusercontent.com')) {
    throw new Error(
      '[config] GOOGLE_CLIENT_ID nao parece um Client ID do Google ' +
        '(deveria terminar em .apps.googleusercontent.com). Confira se nao colou o Client Secret.',
    );
  }

  const BOOTSTRAP_ADMIN_EMAILS = lerLista(raw.BOOTSTRAP_ADMIN_EMAILS).map(
    (email) => email.toLowerCase(),
  );

  const invalido = BOOTSTRAP_ADMIN_EMAILS.find((email) => !email.includes('@'));
  if (invalido) {
    throw new Error(
      `[config] BOOTSTRAP_ADMIN_EMAILS contem um endereco invalido: "${invalido}".`,
    );
  }

  return {
    NODE_ENV,
    PORT: Number(raw.PORT) || 3000,
    DATABASE_URL: exigir(raw, 'DATABASE_URL'),
    JWT_SECRET,
    JWT_EXPIRES_IN:
      (typeof raw.JWT_EXPIRES_IN === 'string' && raw.JWT_EXPIRES_IN) || '8h',
    GOOGLE_CLIENT_ID,
    GOOGLE_ALLOWED_HD:
      typeof raw.GOOGLE_ALLOWED_HD === 'string'
        ? raw.GOOGLE_ALLOWED_HD.trim().toLowerCase()
        : '',
    BOOTSTRAP_ADMIN_EMAILS,
    // Cookie sem `Secure` viaja em HTTP -- aceitavel so em desenvolvimento
    // local. Em producao o padrao e true e so uma env explicita desliga.
    COOKIE_SECURE: lerBooleano(raw.COOKIE_SECURE, NODE_ENV === 'production'),
    CORS_ORIGIN: lerLista(raw.CORS_ORIGIN),
  };
}
