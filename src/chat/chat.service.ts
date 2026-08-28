import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { buildHistorySources } from '../rag/response-sources';

// Campos do documento necessarios para montar uma fonte navegavel a partir do
// historico. Nunca inclui file_data (o PDF inteiro) nem os textos completos.
const HISTORY_NORMATIVE_SELECT = {
  id: true,
  title: true,
  document_type: true,
  total_pages: true,
  file_name: true,
  file_mime_type: true,
  file_size: true,
} as const;

@Injectable()
export class ChatService {
  constructor(private prisma: PrismaService) {}

  async createConversation(title: string, user_id: string) {
    return this.prisma.conversation.create({
      data: { title, user_id },
    });
  }

  async validateConversation(id: string, user_id: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
    });

    if (!conversation) throw new NotFoundException('Conversa não encontrada');
    if (conversation.user_id !== user_id) throw new ForbiddenException('Sem permissão');
    
    return conversation;
  }

  async listConversations(userId?: string, page: number = 1, limit: number = 20) {
    const whereClause = {
      ...(userId ? { user_id: userId } : {}),
      deleted_at: null, 
    };
    
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.conversation.findMany({
        where: whereClause,
        orderBy: [
          { is_pinned: 'desc' }, // Fixados aparecem primeiro
          { created_at: 'desc' }
        ],
        skip,
        take: limit,
        select: {
          id: true,
          title: true,
          created_at: true,
          is_pinned: true, // Adicionado para o frontend saber o estado
        },
      }),
      this.prisma.conversation.count({ where: whereClause })
    ]);

    const totalPages = Math.ceil(total / limit);
    const hasNextPage = page < totalPages;

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage
      }
    };
  }

  async getConversationWithHistory(id: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
      include: {
        interactionHistory: {
          orderBy: { created_at: 'asc' },
          include: {
            responseSources: {
              include: {
                normative: { select: HISTORY_NORMATIVE_SELECT },
                excerpts: { orderBy: { rank: 'asc' } },
              },
            },
          },
        },
      },
    });
    if (!conversation) return conversation;

    return {
      ...conversation,
      interactionHistory: conversation.interactionHistory.map((interaction) => ({
        ...interaction,
        sources: buildHistorySources(interaction.responseSources),
      })),
    };
  }

  async getHistory(conversation_id: string, user_id: string) {
    await this.validateConversation(conversation_id, user_id);

    const interactions = await this.prisma.interactionHistory.findMany({
      where: { conversation_id },
      orderBy: { created_at: 'asc' },
      include: {
        responseSources: {
          include: {
            normative: { select: HISTORY_NORMATIVE_SELECT },
            excerpts: { orderBy: { rank: 'asc' } },
          },
        },
      },
    });

    // `responseSources` continua exatamente como estava (agora com os trechos
    // aninhados); `sources` acrescenta o MESMO contrato que /chat/ask devolve,
    // para que reabrir uma conversa entregue fontes navegaveis identicas as da
    // resposta original — sem refazer nenhuma recuperacao.
    return interactions.map((interaction) => ({
      ...interaction,
      sources: buildHistorySources(interaction.responseSources),
    }));
  }
  
  async renameConversation(id: string, title: string) {
    return this.prisma.conversation.update({
      where: { id },
      data: { title },
    });
  }

  async togglePinConversation(id: string, is_pinned: boolean) {
    return this.prisma.conversation.update({
      where: { id },
      data: { is_pinned },
    });
  }

  async softDeleteConversation(id: string) {
    return this.prisma.conversation.update({
      where: { id },
      data: { deleted_at: new Date() },
    });
  }
}