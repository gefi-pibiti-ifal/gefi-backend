import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { PrismaService } from '../prisma/prisma.service';

const DOCUMENT = {
  id: 'doc-1',
  title: 'IN 05/2017',
  document_type: 'INSTRUCAO_NORMATIVA',
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-02'),
  file_name: 'in-05-2017.pdf',
  file_mime_type: 'application/pdf',
  file_size: 2048,
  total_pages: 42,
};

function buildPrismaMock() {
  return {
    normativeDocument: {
      create: jest.fn(async ({ data }: any) => ({ id: 'doc-novo', ...data })),
      findMany: jest.fn(async () => [DOCUMENT]),
      count: jest.fn(async () => 1),
      findFirst: jest.fn(async () => DOCUMENT),
      delete: jest.fn(async () => DOCUMENT),
    },
    responseSource: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    $executeRaw: jest.fn(async () => 0),
  };
}

describe('DocumentsService', () => {
  let service: DocumentsService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [DocumentsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<DocumentsService>(DocumentsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Identificacao do documento
  // -------------------------------------------------------------------------
  describe('findOne', () => {
    test('devolve os metadados com os links de consulta e download', async () => {
      const result = await service.findOne('doc-1');

      expect(result).toMatchObject({
        id: 'doc-1',
        title: 'IN 05/2017',
        total_pages: 42,
        view_url: '/api/documents/doc-1/file',
        download_url: '/api/documents/doc-1/file?download=1',
        content_url: '/api/documents/doc-1/content',
      });
      expect(result.file).toEqual({
        available: true,
        name: 'in-05-2017.pdf',
        mime_type: 'application/pdf',
        size: 2048,
      });
    });

    test('documento sem arquivo original nao anuncia download', async () => {
      prisma.normativeDocument.findFirst.mockResolvedValueOnce({
        ...DOCUMENT,
        file_name: null,
        file_mime_type: null,
        file_size: null,
      } as any);

      const result = await service.findOne('doc-1');

      expect(result.file.available).toBe(false);
      expect(result.view_url).toBeNull();
      expect(result.download_url).toBeNull();
      expect(result.content_url).toBe('/api/documents/doc-1/content');
    });

    test('documento inexistente resulta em 404', async () => {
      prisma.normativeDocument.findFirst.mockResolvedValueOnce(null as any);
      await expect(service.findOne('nao-existe')).rejects.toThrow(NotFoundException);
    });

    test('documento removido logicamente nao e servido', async () => {
      await service.findOne('doc-1');
      expect(prisma.normativeDocument.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'doc-1', deleted_at: null } }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Obtencao do arquivo original
  // -------------------------------------------------------------------------
  describe('getFile', () => {
    test('devolve o binario, o nome e o tipo do arquivo', async () => {
      const data = Buffer.from('%PDF-1.7 conteudo');
      prisma.normativeDocument.findFirst.mockResolvedValueOnce({
        ...DOCUMENT,
        file_data: data,
      } as any);

      const file = await service.getFile('doc-1');

      expect(file.data.equals(data)).toBe(true);
      expect(file.fileName).toBe('in-05-2017.pdf');
      expect(file.mimeType).toBe('application/pdf');
    });

    test('documento sem arquivo: 404 que aponta o caminho alternativo', async () => {
      prisma.normativeDocument.findFirst.mockResolvedValueOnce({
        ...DOCUMENT,
        file_data: null,
      } as any);

      await expect(service.getFile('doc-1')).rejects.toThrow(
        /\/api\/documents\/doc-1\/content/,
      );
    });

    test('documento inexistente resulta em 404', async () => {
      prisma.normativeDocument.findFirst.mockResolvedValueOnce(null as any);
      await expect(service.getFile('nao-existe')).rejects.toThrow(NotFoundException);
    });

    test('sem nome gravado, cai no titulo do documento', async () => {
      prisma.normativeDocument.findFirst.mockResolvedValueOnce({
        ...DOCUMENT,
        file_name: null,
        file_mime_type: null,
        file_data: Buffer.from('pdf'),
      } as any);

      const file = await service.getFile('doc-1');

      expect(file.fileName).toBe('IN 05/2017.pdf');
      expect(file.mimeType).toBe('application/pdf');
    });
  });

  // -------------------------------------------------------------------------
  // Texto indexado (coordenadas das fontes / visualizador alternativo)
  // -------------------------------------------------------------------------
  describe('getContent', () => {
    test('devolve o texto indexado, alinhado com os offsets das fontes', async () => {
      prisma.normativeDocument.findFirst.mockResolvedValueOnce({
        ...DOCUMENT,
        indexed_content: 'texto limpo indexado',
        original_content: 'texto cru',
        page_map: [{ page_start: 1, page_end: 1, start: 0, end: 20 }],
      } as any);

      const result = await service.getContent('doc-1');

      expect(result.content).toBe('texto limpo indexado');
      expect(result.aligned_with_offsets).toBe(true);
      expect(result.page_map).toEqual([
        { page_start: 1, page_end: 1, start: 0, end: 20 },
      ]);
    });

    test('documento antigo cai no texto extraido e avisa que nao ha alinhamento', async () => {
      prisma.normativeDocument.findFirst.mockResolvedValueOnce({
        ...DOCUMENT,
        indexed_content: null,
        original_content: 'texto cru extraido',
        page_map: null,
        total_pages: null,
      } as any);

      const result = await service.getContent('doc-1');

      expect(result.content).toBe('texto cru extraido');
      expect(result.aligned_with_offsets).toBe(false);
      expect(result.page_map).toEqual([]);
    });

    test('documento inexistente resulta em 404', async () => {
      prisma.normativeDocument.findFirst.mockResolvedValueOnce(null as any);
      await expect(service.getContent('nao-existe')).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // Listagem e remocao — o binario nunca vaza numa resposta de listagem
  // -------------------------------------------------------------------------
  describe('findAll / remove', () => {
    test('a listagem nao seleciona o binario do arquivo', async () => {
      await service.findAll(1, 10);

      const [args] = prisma.normativeDocument.findMany.mock.calls[0] as any[];
      const select = args.select;
      expect(select.file_data).toBeUndefined();
      expect(select.file_name).toBe(true);
    });

    test('remove apaga vetores, fontes e o documento', async () => {
      await service.remove('doc-1');

      expect(prisma.$executeRaw).toHaveBeenCalled();
      expect(prisma.responseSource.deleteMany).toHaveBeenCalledWith({
        where: { normative_id: 'doc-1' },
      });
      expect(prisma.normativeDocument.delete).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'doc-1' } }),
      );
    });

    test('remove nao devolve o binario do arquivo', async () => {
      await service.remove('doc-1');

      const [args] = prisma.normativeDocument.delete.mock.calls[0] as any[];
      const select = args.select;
      expect(select.file_data).toBeUndefined();
    });
  });
});
