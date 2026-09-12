import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { User } from '@prisma/client';

export const JWT_ISSUER = 'gefi-docs';
export const JWT_AUDIENCE = 'gefi-docs-web';

export interface JwtPayload {
  /** Id do usuario no GeFi -- nao confundir com o `sub` do Google. */
  sub: string;
  email: string;
  user_type: string;
  profile_completed: boolean;
}

/**
 * Assinatura do token isolada num modulo proprio (TokenModule).
 *
 * Motivo: tanto o AuthService (login) quanto o UsersController (conclusao do
 * perfil, que muda `profile_completed` e por isso precisa reemitir o cookie)
 * precisam assinar. Se isso vivesse no AuthService, UsersModule importaria
 * AuthModule e AuthModule importaria UsersModule -- ciclo que so se resolveria
 * com forwardRef. Um servico sem dependencias de dominio quebra o ciclo.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  assinar(user: User): string {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      user_type: user.user_type,
      profile_completed: user.profile_completed,
    };

    return this.jwtService.sign(payload, {
      // O cast existe porque `expiresIn` e tipado como template literal ('8h',
      // '30m'...) e o ConfigService devolve string. O formato ja foi conferido
      // por duracaoParaMs() em session.cookie.ts, que roda no mesmo valor.
      expiresIn: (this.config.get<string>('JWT_EXPIRES_IN') ??
        '8h') as JwtSignOptions['expiresIn'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
  }
}
