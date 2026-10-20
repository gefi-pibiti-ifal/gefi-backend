import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';

/** Identidade extraida de um ID token JA verificado. */
export interface GoogleIdentity {
  /** `sub`: identificador estavel da conta. Sobrevive a renomeacao do e-mail. */
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
  /** Dominio do Workspace, quando a conta pertence a um. Contas pessoais nao tem. */
  hd: string | null;
}

@Injectable()
export class GoogleService {
  private readonly logger = new Logger(GoogleService.name);
  private readonly client: OAuth2Client;
  private readonly clientId: string;
  private readonly dominioPermitido: string;

  constructor(config: ConfigService) {
    // Sem `||` e sem default: o boot ja falhou em env.validation.ts se faltasse.
    this.clientId = config.get<string>('GOOGLE_CLIENT_ID')!;
    this.dominioPermitido = config.get<string>('GOOGLE_ALLOWED_HD') ?? '';
    this.client = new OAuth2Client(this.clientId);
  }

  /**
   * Verifica o ID token recebido do navegador.
   *
   * `verifyIdToken` faz o trabalho que NAO pode ser feito no cliente: confere a
   * assinatura contra as chaves publicas do Google, o emissor, a expiracao e --
   * criticamente -- que o `aud` e o NOSSO client id. Sem a checagem de `aud`,
   * um ID token valido emitido para qualquer outra aplicacao Google seria
   * aceito aqui, e qualquer site conseguiria logar como qualquer pessoa.
   */
  async verificarCredential(credential: string): Promise<GoogleIdentity> {
    let payload: TokenPayload | undefined;

    try {
      const ticket = await this.client.verifyIdToken({
        idToken: credential,
        audience: this.clientId,
      });
      payload = ticket.getPayload();
    } catch (error) {
      // O motivo exato (assinatura, expiracao, audience) fica no log do
      // servidor; para o cliente e sempre a mesma resposta generica.
      this.logger.warn(
        `Falha ao verificar ID token do Google: ${(error as Error).message}`,
      );
      throw new UnauthorizedException(
        'Credencial do Google invalida ou expirada.',
      );
    }

    if (!payload?.sub || !payload.email) {
      throw new UnauthorizedException('Credencial do Google incompleta.');
    }

    // Sem esta checagem, um dominio mal configurado poderia entregar um e-mail
    // que a pessoa nao controla de fato.
    if (payload.email_verified !== true) {
      throw new UnauthorizedException(
        'A conta Google usada nao tem e-mail verificado.',
      );
    }

    const hd = payload.hd?.toLowerCase() ?? null;

    // Compara-se `hd`, NUNCA o sufixo do e-mail: o dominio no endereco pode ser
    // um alias apontado para uma conta fora do Workspace, enquanto `hd` e
    // afirmado pelo Google sobre a organizacao dona da conta.
    if (this.dominioPermitido && hd !== this.dominioPermitido) {
      throw new UnauthorizedException(
        `Use sua conta institucional @${this.dominioPermitido} para acessar o GeFi.`,
      );
    }

    return {
      sub: payload.sub,
      email: payload.email.toLowerCase(),
      name: payload.name ?? null,
      picture: payload.picture ?? null,
      hd,
    };
  }
}
