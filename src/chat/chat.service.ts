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

  // Adicione este método dentro da classe ChatService
  async listConversations(userId?: string) {
   
    const whereClause = userId ? { user_id: userId } : {};

    return this.prisma.conversation.findMany({
      where: whereClause,
      orderBy: {
        created_at: 'desc', 
      },
      select: {
        id: true,
        title: true,
        created_at: true,
      },
    });
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
}
