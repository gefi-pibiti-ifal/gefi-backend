import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, User, UserType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import { InviteUserDto } from './dto/invite-user.dto';
import { ListUsersDto } from './dto/list-users.dto';

/**
 * Campos devolvidos ao cliente. `google_sub` fica de fora de proposito: e um
 * identificador de conta externa e nao tem utilidade nenhuma no navegador.
 */
export const USER_PUBLIC_SELECT = {
  id: true,
  email: true,
  full_name: true,
  siap_registration: true,
  user_type: true,
  profile_completed: true,
  picture_url: true,
  revoked_at: true,
  last_login_at: true,
  created_at: true,
} satisfies Prisma.UserSelect;

export type PublicUser = Prisma.UserGetPayload<{
  select: typeof USER_PUBLIC_SELECT;
}>;

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  /** E-mail e chave de identidade: comparar sem normalizar deixaria passar duplicatas por caixa. */
  private static normalizarEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async findOneByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email: UsersService.normalizarEmail(email) },
    });
  }

  async findByGoogleSub(googleSub: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { google_sub: googleSub } });
  }

  /**
   * Monta a resposta por INCLUSAO, nunca removendo campos de um spread: assim,
   * uma coluna sensivel adicionada ao schema no futuro nao vaza sozinha para o
   * cliente por esquecimento.
   */
  toPublic(user: User): PublicUser {
    return {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      siap_registration: user.siap_registration,
      user_type: user.user_type,
      profile_completed: user.profile_completed,
      picture_url: user.picture_url,
      revoked_at: user.revoked_at,
      last_login_at: user.last_login_at,
      created_at: user.created_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Fluxo de login (chamado pelo AuthService)
  // ---------------------------------------------------------------------------

  /**
   * Vincula a conta Google a linha pre-cadastrada, na primeira vez que a pessoa
   * entra. O `picture_url` e atualizado a cada login porque a pessoa pode
   * trocar a foto; `full_name` NAO e sobrescrito, para nao desfazer o que ela
   * digitou em /complete-profile.
   */
  async registrarLogin(
    userId: string,
    dados: { googleSub: string; pictureUrl: string | null },
  ): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        google_sub: dados.googleSub,
        picture_url: dados.pictureUrl,
        last_login_at: new Date(),
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Perfil da propria pessoa
  // ---------------------------------------------------------------------------

  async completeProfile(
    userId: string,
    dto: CompleteProfileDto,
  ): Promise<User> {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException('Usuario nao encontrado.');

    return this.prisma.user.update({
      where: { id: userId },
      data: {
        full_name: dto.full_name,
        siap_registration: dto.siap_registration,
        profile_completed: true,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Administracao
  // ---------------------------------------------------------------------------

  /**
   * Pre-cadastro. Criar a linha ANTES do primeiro acesso e o que transforma a
   * tabela em allowlist: `AuthService.loginWithGoogle` recusa quem nao tem
   * linha. Convidar um e-mail ja revogado reativa a conta em vez de falhar.
   */
  async invite(dto: InviteUserDto, invitedById: string): Promise<PublicUser> {
    const email = UsersService.normalizarEmail(dto.email);
    const existente = await this.prisma.user.findUnique({ where: { email } });

    if (existente && !existente.revoked_at) {
      throw new ConflictException(`O e-mail ${email} ja esta cadastrado.`);
    }

    if (existente?.revoked_at) {
      return this.prisma.user.update({
        where: { id: existente.id },
        data: {
          revoked_at: null,
          user_type: dto.user_type ?? UserType.FISCAL,
          invited_by_id: invitedById,
        },
        select: USER_PUBLIC_SELECT,
      });
    }

    return this.prisma.user.create({
      data: {
        email,
        user_type: dto.user_type ?? UserType.FISCAL,
        invited_by_id: invitedById,
        // full_name, siap_registration e google_sub ficam nulos ate o 1o acesso.
      },
      select: USER_PUBLIC_SELECT,
    });
  }

  async list(query: ListUsersDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const where: Prisma.UserWhereInput = {
      ...(query.user_type ? { user_type: query.user_type } : {}),
      ...(query.search
        ? {
            OR: [
              { email: { contains: query.search, mode: 'insensitive' } },
              { full_name: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: USER_PUBLIC_SELECT,
        orderBy: [{ revoked_at: 'asc' }, { created_at: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  async updateRole(
    id: string,
    user_type: UserType,
    actorId: string,
  ): Promise<PublicUser> {
    if (id === actorId) {
      // Sem esta trava, um administrador distraido se rebaixa e perde o acesso
      // a propria tela que usaria para se promover de volta.
      throw new BadRequestException('Voce nao pode alterar o proprio cargo.');
    }

    const user = await this.findById(id);
    if (!user) throw new NotFoundException('Usuario nao encontrado.');

    if (
      user.user_type === UserType.ADMINISTRADOR &&
      user_type !== UserType.ADMINISTRADOR
    ) {
      await this.garantirQueSobraAdministrador(id);
    }

    return this.prisma.user.update({
      where: { id },
      data: { user_type },
      select: USER_PUBLIC_SELECT,
    });
  }

  /**
   * "Excluir" tem dois significados aqui, e a diferenca importa para auditoria:
   *
   * - convite nunca usado, sem nada vinculado  -> apaga a linha de verdade;
   * - conta que ja produziu registros          -> revoga (revoked_at), preservando
   *                                               a autoria de documentos e conversas.
   */
  async remove(id: string, actorId: string): Promise<{ revogado: boolean }> {
    if (id === actorId) {
      throw new BadRequestException('Voce nao pode remover o proprio acesso.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            conversations: true,
            normativeDocuments: true,
            systemAudits: true,
          },
        },
      },
    });

    if (!user) throw new NotFoundException('Usuario nao encontrado.');

    if (user.user_type === UserType.ADMINISTRADOR) {
      await this.garantirQueSobraAdministrador(id);
    }

    const temHistorico =
      user._count.conversations > 0 ||
      user._count.normativeDocuments > 0 ||
      user._count.systemAudits > 0;

    if (!temHistorico) {
      await this.prisma.user.delete({ where: { id } });
      return { revogado: false };
    }

    await this.prisma.user.update({
      where: { id },
      data: {
        revoked_at: new Date(),
        // Desvincula a conta Google: se a pessoa for reconvidada depois, o
        // vinculo e refeito do zero em vez de ressuscitar um estado antigo.
        google_sub: null,
      },
    });

    return { revogado: true };
  }

  /**
   * O sistema so pode ser administrado por quem esta dentro dele. Ficar sem
   * nenhum ADMINISTRADOR ativo significa que ninguem consegue mais convidar
   * ninguem -- a recuperacao passaria a exigir BOOTSTRAP_ADMIN_EMAILS e um
   * restart do container.
   */
  private async garantirQueSobraAdministrador(
    idExcluido: string,
  ): Promise<void> {
    const restantes = await this.prisma.user.count({
      where: {
        user_type: UserType.ADMINISTRADOR,
        revoked_at: null,
        id: { not: idExcluido },
      },
    });

    if (restantes === 0) {
      throw new BadRequestException(
        'Esta e a ultima conta de administrador ativa. Promova outra pessoa antes de remove-la.',
      );
    }
  }
}
