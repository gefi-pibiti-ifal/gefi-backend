import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../users/users.service';
import { SESSION_COOKIE } from './session.cookie';
import { JWT_AUDIENCE, JWT_ISSUER, type JwtPayload } from './token.service';

/** O token vive no cookie httpOnly; nao ha mais header Authorization a ler. */
function extrairDoCookie(req: Request): string | null {
  const cookies = (req as Request & { cookies?: Record<string, string> })
    .cookies;
  return cookies?.[SESSION_COOKIE] ?? null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([extrairDoCookie]),
      ignoreExpiration: false,
      // Sem fallback: env.validation.ts ja garantiu que existe e tem tamanho.
      secretOrKey: config.get<string>('JWT_SECRET')!,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
  }

  /**
   * Rele o usuario no banco a cada requisicao, em vez de confiar no payload.
   *
   * O custo e uma consulta por chave primaria; o ganho e que revogacao e
   * mudanca de cargo passam a valer NA HORA. Confiando so no token, um fiscal
   * promovido a administrador -- ou um acesso revogado -- so teria efeito
   * depois da expiracao de 8h.
   */
  async validate(payload: JwtPayload) {
    const user = await this.usersService.findById(payload.sub);

    if (!user || user.revoked_at) {
      throw new UnauthorizedException('Sessao invalida. Entre novamente.');
    }

    // O formato { id, email, user_type } e o que chat.controller.ts e
    // documents.controller.ts ja consomem via req.user -- preservado de proposito.
    return {
      id: user.id,
      email: user.email,
      user_type: user.user_type,
      profile_completed: user.profile_completed,
    };
  }
}
