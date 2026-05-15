import { Controller, Post, Get, Patch, Delete, Body, Param, UseGuards, Req, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiBody, ApiQuery } from '@nestjs/swagger';
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
      properties: { title: { type: 'string', example: 'Consulta sobre legislação ambiental' } },
      required: ['title'],
    },
  })
  createConversation(@Body() body: { title: string }, @Req() req: any) {
    return this.chatService.createConversation(body.title, req.user.id);
  }

  @Get('conversations')
  @ApiOperation({ summary: 'Lista conversas com paginação' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getConversations(
    @Req() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const userId = req.user?.id || req.user?.sub; 
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 20;
    
    return this.chatService.listConversations(userId, pageNum, limitNum);
  }

  @Get('conversations/:id')
  async getConversation(@Param('id') id: string) {
    return this.chatService.getConversationWithHistory(id);
  }

  @Post('ask')
  @ApiOperation({ summary: 'Faz uma pergunta ao assistente RAG' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', example: 'uuid-da-conversa' },
        query: { type: 'string', example: 'Qual é o conteúdo deste documento?' },
      },
      required: ['conversation_id', 'query'],
    },
  })
  async ask(@Body() body: { conversation_id: string; query: string }, @Req() req: any) {
    await this.chatService.validateConversation(body.conversation_id, req.user.id);
    const result = await this.ragService.query(body.query, body.conversation_id);

    return {
      id: result.id,
      created_at: result.created_at,
      user_query: body.query,
      ai_response: result.response,
      sources: result.sources,
      conversation_id: body.conversation_id,
    };
  }
  
  @Get('history/:conversation_id')
  @ApiOperation({ summary: 'Recupera o histórico de uma conversa' })
  getHistory(@Param('conversation_id') conversation_id: string, @Req() req: any) {
    return this.chatService.getHistory(conversation_id, req.user.id);
  }

  @Patch('conversations/:id/rename')
  @ApiOperation({ summary: 'Renomeia uma conversa' })
  async renameConversation(@Param('id') id: string, @Body() body: { title: string }, @Req() req: any) {
    await this.chatService.validateConversation(id, req.user.id);
    return this.chatService.renameConversation(id, body.title);
  }

  @Patch('conversations/:id/pin')
  @ApiOperation({ summary: 'Fixa ou desfixa uma conversa' })
  async togglePin(@Param('id') id: string, @Body() body: { is_pinned: boolean }, @Req() req: any) {
    await this.chatService.validateConversation(id, req.user.id);
    return this.chatService.togglePinConversation(id, body.is_pinned);
  }

  @Delete('conversations/:id')
  @ApiOperation({ summary: 'Deleta logicamente uma conversa (soft delete)' })
  async softDelete(@Param('id') id: string, @Req() req: any) {
    await this.chatService.validateConversation(id, req.user.id);
    return this.chatService.softDeleteConversation(id);
  }
}