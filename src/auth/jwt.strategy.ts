import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'gefi_secret_key_2026',
    });
  }

  async validate(payload: any) {
    // Tokens com escopo sao credenciais de finalidade unica (ex.: leitura de um
    // arquivo especifico) e nunca valem como token de sessao.
    if (payload?.scope) {
      throw new UnauthorizedException('Token de finalidade especifica nao autentica sessao');
    }
    return { id: payload.id, email: payload.email, user_type: payload.user_type };
  }
}
