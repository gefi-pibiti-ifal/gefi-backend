import { Controller, Post, Get, Body, Param, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiBody } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ChatService } from './chat.service';
import { RagService } from '../rag/rag.service';

@ApiTags('Chat RAG')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('chat')
export class ChatController {
  constructor(
    private chatService: ChatService,
    private ragService: RagService,
  ) {}

  @Post('conversations')
  @ApiOperation({ summary: 'Cria uma nova conversa' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          example: 'Consulta sobre legislação ambiental',
        },
      },
      required: ['title'],
    },
  })
  createConversation(@Body() body: { title: string }, @Req() req: any) {
    return this.chatService.createConversation(body.title, req.user.id);
  }

  @Post('ask')
  @ApiOperation({ summary: 'Faz uma pergunta ao assistente RAG' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          example: 'uuid-da-conversa',
        },
        query: {
          type: 'string',
          example: 'Qual é o conteúdo deste documento?',
        },
      },
      required: ['conversation_id', 'query'],
    },
  })
  async ask(
    @Body() body: { conversation_id: string; query: string },
    @Req() req: any,
  ) {
    await this.chatService.validateConversation(
      body.conversation_id,
      req.user.id,
    );

    const response = await this.ragService.query(
      body.query,
      body.conversation_id,
    );

    return {
      query: body.query,
      response: response,
      conversation_id: body.conversation_id,
    };
  }

  @Get('history/:conversation_id')
  @ApiOperation({ summary: 'Recupera o histórico de uma conversa' })
  getHistory(@Param('conversation_id') conversation_id: string, @Req() req: any) {
    return this.chatService.getHistory(conversation_id, req.user.id);
  }
}
