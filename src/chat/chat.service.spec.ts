import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ChatService } from './chat.service';
import { PrismaService } from '../prisma/prisma.service';

const NORMATIVE = {
  id: 'doc-a',
  title: 'IN 05/2017',
  document_type: 'INSTRUCAO_NORMATIVA',
  total_pages: 42,
  file_name: 'in-05-2017.pdf',
  file_mime_type: 'application/pdf',
  file_size: 2048,
};

const EXCERPT = {
  parent_chunk_id: 'parent-1',
  section_header: '10.2.',
  n1_header: 'ANEXO VIII-B',
  n2_header: '10.2.',
  citation: 'Item 10.2 – ANEXO VIII-B – IN 05/2017',
  excerpt: 'Ao final de cada periodo mensal...',
  role: 'PRINCIPAL',
  rank: 0,
  page_start: 2,
  page_end: 2,
  char_start: 400,
  char_end: 700,
  location_precision: 'TRECHO',
};

const INTERACTION = {
  id: 'interaction-1',
  conversation_id: 'conv-1',
  user_query: 'Qual a rotina mensal?',
  ai_response: 'Ao final de cada mes...',
  created_at: new Date('2026-01-01'),
  responseSources: [
    { normative_id: 'doc-a', normative: NORMATIVE, excerpts: [EXCERPT] },
  ],
};

function buildPrismaMock() {
  return {
    conversation: {
      create: jest.fn(async ({ data }: any) => ({ id: 'conv-1', ...data })),
      findUnique: jest.fn(async () => ({
        id: 'conv-1',
        user_id: 'user-1',
        title: 'Consulta',
        interactionHistory: [INTERACTION],
      })),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      update: jest.fn(async (args: any) => args),
    },
    interactionHistory: { findMany: jest.fn(async () => [INTERACTION]) },
  };
}

describe('ChatService', () => {
  let service: ChatService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [ChatService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<ChatService>(ChatService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('validateConversation', () => {
    test('conversa de outro usuario e barrada', async () => {
      await expect(service.validateConversation('conv-1', 'outro')).rejects.toThrow(
        ForbiddenException,
      );
    });

    test('conversa inexistente resulta em 404', async () => {
      prisma.conversation.findUnique.mockResolvedValueOnce(null as any);
      await expect(service.validateConversation('conv-1', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Historico: reabrir a conversa devolve as MESMAS fontes navegaveis
  // -------------------------------------------------------------------------
  describe('getHistory', () => {
    test('acrescenta fontes navegaveis com trecho e localizacao', async () => {
      const [interaction] = await service.getHistory('conv-1', 'user-1');

      expect(interaction.sources).toHaveLength(1);
      expect(interaction.sources[0]).toMatchObject({
        id: 'doc-a',
        title: 'IN 05/2017',
        view_url: '/api/documents/doc-a/file',
        download_url: '/api/documents/doc-a/file?download=1',
        content_url: '/api/documents/doc-a/content',
      });
      expect(interaction.sources[0].excerpts[0]).toMatchObject({
        parent_chunk_id: 'parent-1',
        citation: 'Item 10.2 – ANEXO VIII-B – IN 05/2017',
        location: {
          page_start: 2,
          page_end: 2,
          char_start: 400,
          char_end: 700,
          precision: 'TRECHO',
        },
      });
    });

    test('o contrato antigo (responseSources) segue intacto', async () => {
      const [interaction] = await service.getHistory('conv-1', 'user-1');

      expect(interaction.responseSources[0].normative.title).toBe('IN 05/2017');
      expect(interaction.ai_response).toBe('Ao final de cada mes...');
      expect(interaction.user_query).toBe('Qual a rotina mensal?');
    });

    test('interacao antiga, sem trechos persistidos, ainda expoe a fonte', async () => {
      prisma.interactionHistory.findMany.mockResolvedValueOnce([
        {
          ...INTERACTION,
          responseSources: [
            {
              normative_id: 'doc-legacy',
              normative: { ...NORMATIVE, id: 'doc-legacy', file_name: null },
              excerpts: [],
            },
          ],
        },
      ] as any);

      const [interaction] = await service.getHistory('conv-1', 'user-1');

      expect(interaction.sources[0].id).toBe('doc-legacy');
      expect(interaction.sources[0].excerpts).toEqual([]);
      expect(interaction.sources[0].download_url).toBeNull();
    });

    test('os trechos sao carregados na ordem de apresentacao', async () => {
      await service.getHistory('conv-1', 'user-1');

      const [args] = prisma.interactionHistory.findMany.mock.calls[0] as any[];
      const include = args.include;
      expect(include.responseSources.include.excerpts).toEqual({
        orderBy: { rank: 'asc' },
      });
    });
  });

  describe('getConversationWithHistory', () => {
    test('cada interacao da conversa traz as suas fontes', async () => {
      const conversation = await service.getConversationWithHistory('conv-1');

      expect(conversation!.interactionHistory[0].sources[0].id).toBe('doc-a');
    });

    test('conversa inexistente devolve null', async () => {
      prisma.conversation.findUnique.mockResolvedValueOnce(null as any);
      expect(await service.getConversationWithHistory('conv-x')).toBeNull();
    });
  });
});
