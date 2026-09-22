import { Test, TestingModule } from '@nestjs/testing';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { RagService } from '../rag/rag.service';
import { DEFAULT_PERSONA_ID } from '../rag/response-persona';

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
  let chatService: {
    validateConversation: jest.Mock;
    getHistory: jest.Mock;
    getUserPersonaPreference: jest.Mock;
    createConversation: jest.Mock;
    setConversationPersona: jest.Mock;
  };
  let ragService: { query: jest.Mock };

  beforeEach(async () => {
    chatService = {
      validateConversation: jest.fn(async () => ({ id: 'conv-1', persona: null })),
      getHistory: jest.fn(async () => []),
      getUserPersonaPreference: jest.fn(async () => null),
      createConversation: jest.fn(async (title: string, _u: string, persona?: string) => ({
        id: 'conv-1',
        title,
        persona: persona ?? null,
      })),
      setConversationPersona: jest.fn(async (id: string, persona: string | null) => ({
        id,
        persona,
      })),
    };
    ragService = {
      query: jest.fn(async () => ({
        id: 'interaction-1',
        created_at: new Date('2026-01-01'),
        response: 'Sim. A verificacao e mensal.',
        persona: DEFAULT_PERSONA_ID,
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

    test('a resposta informa qual personalidade a gerou', async () => {
      const result = await controller.ask(
        { conversation_id: 'conv-1', query: 'rotina mensal' },
        { user: { id: 'user-1' } },
      );

      expect(result.persona).toBe(DEFAULT_PERSONA_ID);
    });
  });

  // -------------------------------------------------------------------------
  // Personalidade — escolha em tres niveis
  // -------------------------------------------------------------------------
  describe('personalidade', () => {
    test('a pergunta repassa os tres niveis para a resolucao', async () => {
      chatService.validateConversation.mockResolvedValueOnce({
        id: 'conv-1',
        persona: 'INSTITUCIONAL',
      });
      chatService.getUserPersonaPreference.mockResolvedValueOnce('CORDIAL');

      await controller.ask(
        { conversation_id: 'conv-1', query: 'rotina mensal', persona: 'CORDIAL' },
        { user: { id: 'user-1' } },
      );

      const [, , sources] = ragService.query.mock.calls[0];
      expect(sources).toEqual({
        request: 'CORDIAL',
        conversation: 'INSTITUCIONAL',
        user: 'CORDIAL',
      });
    });

    test('sem escolha em lugar nenhum, os tres niveis chegam vazios', async () => {
      await controller.ask(
        { conversation_id: 'conv-1', query: 'rotina mensal' },
        { user: { id: 'user-1' } },
      );

      const [, , sources] = ragService.query.mock.calls[0];
      expect(sources).toEqual({
        request: undefined,
        conversation: null,
        user: null,
      });
    });

    test('o catalogo de personalidades e servido ao frontend', () => {
      const { data } = controller.getPersonas();

      expect(data.length).toBeGreaterThanOrEqual(2);
      expect(data.map((p) => p.id)).toContain('CORDIAL');
      expect(data.every((p) => p.label && p.description && p.sample)).toBe(true);
      expect(data.filter((p) => p.is_default)).toHaveLength(1);
    });

    test('a conversa pode nascer com uma personalidade fixada', async () => {
      await controller.createConversation(
        { title: 'Consulta', persona: 'CORDIAL' },
        { user: { id: 'user-1' } },
      );

      expect(chatService.createConversation).toHaveBeenCalledWith(
        'Consulta',
        'user-1',
        'CORDIAL',
      );
    });

    test('a personalidade da conversa pode ser trocada depois (e solta com null)', async () => {
      await controller.setConversationPersona(
        'conv-1',
        { persona: null },
        { user: { id: 'user-1' } },
      );

      expect(chatService.validateConversation).toHaveBeenCalledWith('conv-1', 'user-1');
      expect(chatService.setConversationPersona).toHaveBeenCalledWith('conv-1', null);
    });
  });
});
