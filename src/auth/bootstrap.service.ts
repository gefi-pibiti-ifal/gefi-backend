import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Semeia os administradores iniciais a partir de BOOTSTRAP_ADMIN_EMAILS.
 *
 * POR QUE ISSO PRECISA EXISTIR: nao ha mais login por senha e so um
 * ADMINISTRADOR pode pre-cadastrar alguem. Num banco vazio, portanto, ninguem
 * consegue entrar -- nem para criar o primeiro administrador. Esta e a unica
 * porta de entrada inicial do sistema, e tambem a recuperacao se a ultima
 * conta de administrador for perdida.
 *
 * E deliberadamente conservador: cria quem falta e promove quem esta la como
 * FISCAL, mas nunca rebaixa, nunca apaga e nunca mexe em perfil ja preenchido.
 */
@Injectable()
export class BootstrapService implements OnModuleInit {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const emails = this.config.get<string[]>('BOOTSTRAP_ADMIN_EMAILS') ?? [];

    if (emails.length === 0) {
      const admins = await this.prisma.user.count({
        where: { user_type: UserType.ADMINISTRADOR, revoked_at: null },
      });

      if (admins === 0) {
        this.logger.error(
          'Nenhum administrador ativo e BOOTSTRAP_ADMIN_EMAILS esta vazia: ninguem conseguira ' +
            'entrar no sistema. Defina a variavel com pelo menos um e-mail institucional e reinicie.',
        );
      }
      return;
    }

    for (const email of emails) {
      const existente = await this.prisma.user.findUnique({ where: { email } });

      if (!existente) {
        await this.prisma.user.create({
          data: { email, user_type: UserType.ADMINISTRADOR },
        });
        this.logger.log(`Administrador inicial pre-cadastrado: ${email}`);
        continue;
      }

      const precisaPromover = existente.user_type !== UserType.ADMINISTRADOR;
      const precisaReativar = existente.revoked_at !== null;

      if (precisaPromover || precisaReativar) {
        await this.prisma.user.update({
          where: { id: existente.id },
          data: { user_type: UserType.ADMINISTRADOR, revoked_at: null },
        });
        this.logger.warn(
          `Administrador inicial restaurado a partir da env: ${email}`,
        );
      }
    }
  }
}
