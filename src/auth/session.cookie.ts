import type { CookieOptions } from 'express';
import type { ConfigService } from '@nestjs/config';

/**
 * Nome do cookie de sessao. O token deixou de ir para o `localStorage` do
 * navegador: com `httpOnly`, nenhum script da pagina consegue le-lo, o que
 * remove o roubo de sessao como consequencia de um XSS -- risco concreto aqui,
 * porque a CSP do frontend precisa de `'unsafe-inline'` em script-src para o
 * payload de hydration do Next.
 */
export const SESSION_COOKIE = 'gefi_session';

/** Converte '8h', '45m', '7d', '3600' em milissegundos, para casar o Max-Age com a expiracao do JWT. */
export function duracaoParaMs(duracao: string): number {
  const match = /^(\d+)\s*([smhd])?$/.exec(duracao.trim());
  if (!match)
    throw new Error(
      `[session] Duracao invalida: "${duracao}". Use algo como 8h, 45m ou 7d.`,
    );

  const valor = Number(match[1]);
  const unidade = match[2] ?? 's';
  const fator = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unidade]!;

  return valor * fator;
}

export function opcoesDoCookie(config: ConfigService): CookieOptions {
  return {
    httpOnly: true,
    // `lax` e o ponto certo do trade-off: o cookie NAO acompanha requisicoes
    // cross-site que nao sejam navegacao de topo, o que ja barra CSRF em POST,
    // e ao mesmo tempo sobrevive ao retorno do fluxo do Google.
    sameSite: 'lax',
    secure: config.get<boolean>('COOKIE_SECURE') ?? true,
    path: '/',
    maxAge: duracaoParaMs(config.get<string>('JWT_EXPIRES_IN') ?? '8h'),
  };
}
