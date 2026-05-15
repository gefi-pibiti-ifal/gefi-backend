import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
    return this.prisma.conversation.findUnique({
      where: { id },
      include: {
        interactionHistory: {
          orderBy: { created_at: 'asc' }
        }
      }
    });
  }

  async getHistory(conversation_id: string, user_id: string) {
    await this.validateConversation(conversation_id, user_id);

    return this.prisma.interactionHistory.findMany({
      where: { conversation_id },
      orderBy: { created_at: 'asc' },
      include: {
        responseSources: {
          include: {
            normative: {
              select: { title: true, document_type: true },
            },
          },
        },
      },
    });
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