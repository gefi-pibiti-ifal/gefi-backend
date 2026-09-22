import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { User, Prisma } from '@prisma/client';
import {
  DEFAULT_PERSONA_ID,
  isKnownPersona,
  resolvePersona,
} from '../rag/response-persona';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findOneByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email },
    });
  }

  async create(data: Prisma.UserCreateInput): Promise<User> {
    return this.prisma.user.create({
      data,
    });
  }

  /** Perfil + preferencias do usuario autenticado (sem o hash da senha). */
  async getProfile(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        full_name: true,
        email: true,
        siap_registration: true,
        user_type: true,
        response_persona: true,
      },
    });
    if (!user) throw new NotFoundException('Usuario nao encontrado');

    // Quem nunca escolheu enxerga o padrao explicito, e nao null: a interface
    // consegue marcar a opcao corrente sem conhecer a regra de fallback.
    return {
      ...user,
      response_persona: user.response_persona ?? DEFAULT_PERSONA_ID,
    };
  }

  /**
   * Grava a personalidade preferida. Valor desconhecido e recusado aqui — numa
   * ESCRITA de preferencia, aceitar em silencio e gravar outra coisa seria
   * mentir para o usuario; na leitura, o desconhecido continua degradando para
   * o padrao para nunca impedir uma resposta.
   */
  async setResponsePersona(id: string, persona: unknown) {
    if (!isKnownPersona(persona)) {
      throw new BadRequestException(
        `Personalidade desconhecida: ${String(persona)}`,
      );
    }
    return this.prisma.user.update({
      where: { id },
      data: { response_persona: resolvePersona(persona).id },
      select: { id: true, response_persona: true },
    });
  }
}
