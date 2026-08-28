import { Test, TestingModule } from '@nestjs/testing';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { RagService } from '../rag/rag.service';

const SOURCE = {
  id: 'doc-a',
  title: 'IN 05/2017',
  document_type: 'INSTRUCAO_NORMATIVA',
  total_pages: 42,
  file: {
    available: true,
    name: 'in-05-2017.pdf',
    mime_type: 'application/pdf',
    size: 2048,
  },
  view_url: '/api/documents/doc-a/file',
  download_url: '/api/documents/doc-a/file?download=1',
  content_url: '/api/documents/doc-a/content',
  excerpts: [
    {
      parent_chunk_id: 'parent-1',
      citation: 'Item 10.2 – ANEXO VIII-B – IN 05/2017',
      section_header: '10.2.',
      n1_header: 'ANEXO VIII-B',
      n2_header: '10.2.',
      role: 'PRINCIPAL' as const,
      excerpt: 'Ao final de cada periodo mensal...',
      location: {
        page_start: 2,
        page_end: 2,
        char_start: 1200,
        char_end: 1450,
        precision: 'TRECHO' as const,
      },
    },
  ],
};

describe('ChatController', () => {
  let controller: ChatController;
  let chatService: { validateConversation: jest.Mock; getHistory: jest.Mock };
  let ragService: { query: jest.Mock };

  beforeEach(async () => {
    chatService = {
      validateConversation: jest.fn(async () => ({ id: 'conv-1' })),
      getHistory: jest.fn(async () => []),
    };
    ragService = {
      query: jest.fn(async () => ({
        id: 'interaction-1',
        created_at: new Date('2026-01-01'),
        response: 'Sim. A verificacao e mensal.',
        sources: [SOURCE],
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: chatService },
        { provide: RagService, useValue: ragService },
      ],
    }).compile();

    controller = module.get<ChatController>(ChatController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('ask', () => {
    test('as fontes chegam ao frontend sem perder trecho nem localizacao', async () => {
      const result = await controller.ask(
        { conversation_id: 'conv-1', query: 'rotina mensal' },
        { user: { id: 'user-1' } },
      );

      expect(result.sources).toEqual([SOURCE]);
      expect(result.sources[0].excerpts[0].location).toEqual({
        page_start: 2,
        page_end: 2,
        char_start: 1200,
        char_end: 1450,
        precision: 'TRECHO',
      });
    });

    test('o restante da resposta segue o contrato existente', async () => {
      const result = await controller.ask(
        { conversation_id: 'conv-1', query: 'rotina mensal' },
        { user: { id: 'user-1' } },
      );

      expect(result).toMatchObject({
        id: 'interaction-1',
        user_query: 'rotina mensal',
        ai_response: 'Sim. A verificacao e mensal.',
        conversation_id: 'conv-1',
      });
    });

    test('a conversa e validada antes de responder', async () => {
      await controller.ask(
        { conversation_id: 'conv-1', query: 'rotina mensal' },
        { user: { id: 'user-1' } },
      );

      expect(chatService.validateConversation).toHaveBeenCalledWith('conv-1', 'user-1');
    });
  });
});
