import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PublicUser, UsersService } from '../users/users.service';
import { GoogleService } from './google.service';
import { TokenService } from './token.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly googleService: GoogleService,
    private readonly tokenService: TokenService,
  ) {}

  /**
   * Unico ponto de entrada de sessao do sistema.
   *
   * A inversao em relacao ao fluxo antigo esta no passo 3: nao existe mais
   * auto-cadastro. O Google prova QUEM a pessoa e; quem decide SE ela entra (e
   * com que cargo) e a linha que um administrador criou antes. Uma conta
   * institucional valida sem convite e recusada.
   */
  async loginWithGoogle(
    credential: string,
  ): Promise<{ user: PublicUser; token: string }> {
    const identidade = await this.googleService.verificarCredential(credential);

    // Busca primeiro pelo `sub` porque ele sobrevive a troca de e-mail no
    // Workspace; o e-mail e o caminho do PRIMEIRO acesso, quando ainda nao ha
    // vinculo nenhum.
    let user =
      (await this.usersService.findByGoogleSub(identidade.sub)) ??
      (await this.usersService.findOneByEmail(identidade.email));

    if (!user) {
      this.logger.warn(
        `Login recusado: ${identidade.email} nao esta pre-cadastrado.`,
      );
      throw new ForbiddenException(
        'Seu e-mail nao esta autorizado a acessar o GeFi. Procure um administrador do sistema.',
      );
    }

    if (user.revoked_at) {
      this.logger.warn(
        `Login recusado: ${identidade.email} teve o acesso revogado.`,
      );
      throw new ForbiddenException(
        'Seu acesso ao GeFi foi revogado. Procure um administrador.',
      );
    }

    // Conta Google diferente reivindicando um e-mail ja vinculado. Nao deveria
    // acontecer com Workspace, mas recusar e mais barato que investigar depois.
    if (user.google_sub && user.google_sub !== identidade.sub) {
      this.logger.error(
        `Conflito de identidade em ${identidade.email}: google_sub divergente do vinculado.`,
      );
      throw new ForbiddenException(
        'Este e-mail ja esta vinculado a outra conta Google. Procure um administrador.',
      );
    }

    // Registrado no primeiro vinculo porque e a unica forma pratica de
    // descobrir qual `hd` as contas da instituicao realmente trazem -- um
    // Workspace com dominio secundario (ex.: aluno.ifal.edu.br) devolve o
    // secundario, nao o primario. Sem saber o valor real, preencher
    // GOOGLE_ALLOWED_HD e chute, e um chute errado tranca todo mundo do lado
    // de fora.
    if (!user.google_sub) {
      this.logger.log(
        `Primeiro acesso de ${identidade.email} (hd=${identidade.hd ?? 'sem dominio'}).`,
      );
    }

    user = await this.usersService.registrarLogin(user.id, {
      googleSub: identidade.sub,
      pictureUrl: identidade.picture,
    });

    return {
      user: this.usersService.toPublic(user),
      token: this.tokenService.assinar(user),
    };
  }
}
