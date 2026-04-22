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
