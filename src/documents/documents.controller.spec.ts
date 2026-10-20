import { Test, TestingModule } from '@nestjs/testing';
import { StreamableFile } from '@nestjs/common';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { RagService } from '../rag/rag.service';

// O PDFLoader real carrega o pdf-parse por import dinamico de um caminho de
// arquivo — o que nao resolve sob o ts-jest (CommonJS), embora funcione em
// producao. Aqui interessa o que o CONTROLLER faz com o resultado da extracao
// (preservar o arquivo, repassar as paginas), entao a extracao e simulada com
// a mesma forma de dado que o loader entrega: um Document por pagina, com
// metadata.loc.pageNumber.
const EXTRACTED_PAGES = [
  { page: 1, text: 'ANEXO VIII-B\n1. Obrigacao da contratada.' },
  { page: 3, text: '2.1. Documentacao mensal exigida.' },
];

jest.mock('@langchain/community/document_loaders/fs/pdf', () => ({
  PDFLoader: class {
    constructor(
      _blob: unknown,
      private options: { splitPages?: boolean } = {},
    ) {}
    async load() {
      if (this.options.splitPages === false) {
        return [
          {
            pageContent: EXTRACTED_PAGES.map((p) => p.text).join('\n\n'),
            metadata: {},
          },
        ];
      }
      // O loader pula paginas sem texto: a pagina 2 do PDF (em branco) nao
      // aparece, e a pagina 3 mantem o seu numero real.
      return EXTRACTED_PAGES.map((p) => ({
        pageContent: p.text,
        metadata: { loc: { pageNumber: p.page }, pdf: { totalPages: 3 } },
      }));
    }
  },
}));

const ADMIN = { id: 'user-admin', user_type: 'ADMINISTRADOR' };
// FISCAL saiu daqui junto com os casos de cargo, que migraram para
// src/auth/roles.guard.spec.ts quando a regra virou @Roles + RolesGuard.

function buildFile(): Express.Multer.File {
  const buffer = Buffer.from('%PDF-1.4 conteudo binario do arquivo');
  return {
    originalname: 'in-05-2017.pdf',
    mimetype: 'application/pdf',
    size: buffer.length,
    buffer,
  } as Express.Multer.File;
}

describe('DocumentsController', () => {
  let controller: DocumentsController;
  let documentsService: {
    create: jest.Mock;
    findAll: jest.Mock;
    findOne: jest.Mock;
    getFile: jest.Mock;
    getContent: jest.Mock;
    remove: jest.Mock;
  };
  let ragService: {
    indexDocument: jest.Mock;
    backfillDocumentLocations: jest.Mock;
  };

  beforeEach(async () => {
    documentsService = {
      create: jest.fn(async (data: any) => ({ id: 'doc-1', ...data })),
      findAll: jest.fn(async () => ({ data: [], meta: {} })),
      findOne: jest.fn(async () => ({ id: 'doc-1' })),
      getFile: jest.fn(async () => ({
        data: Buffer.from('%PDF-1.7'),
        fileName: 'in-05-2017.pdf',
        mimeType: 'application/pdf',
      })),
      getContent: jest.fn(async () => ({ id: 'doc-1', content: 'texto' })),
      remove: jest.fn(async () => ({ id: 'doc-1' })),
    };
    ragService = {
      indexDocument: jest.fn(async () => undefined),
      backfillDocumentLocations: jest.fn(async () => ({
        documentId: 'doc-1',
        parents: 3,
        located: 3,
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DocumentsController],
      providers: [
        { provide: DocumentsService, useValue: documentsService },
        { provide: RagService, useValue: ragService },
      ],
    }).compile();

    controller = module.get<DocumentsController>(DocumentsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Upload — preservacao do arquivo e das paginas
  // -------------------------------------------------------------------------
  describe('upload', () => {
    test('guarda o arquivo original junto do texto extraido', async () => {
      const file = buildFile();

      await controller.upload(
        file,
        { title: 'IN 05/2017', document_type: 'IN' },
        { user: ADMIN },
      );

      const created = documentsService.create.mock.calls[0][0];
      expect(created.file_name).toBe('in-05-2017.pdf');
      expect(created.file_mime_type).toBe('application/pdf');
      expect(created.file_size).toBe(file.size);
      expect(created.file_data.equals(file.buffer)).toBe(true);
      expect(created.file_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(created.original_content).toContain('Obrigacao da contratada');
    });

    test('entrega as paginas extraidas para a indexacao', async () => {
      await controller.upload(
        buildFile(),
        { title: 'IN 05/2017', document_type: 'IN' },
        { user: ADMIN },
      );

      const [content, documentId, title, pages] =
        ragService.indexDocument.mock.calls[0];
      expect(documentId).toBe('doc-1');
      expect(title).toBe('IN 05/2017');
      // A pagina 2 do PDF nao tem texto: entra vazia para que a pagina 3
      // mantenha o seu numero real na localizacao das fontes.
      expect(pages).toEqual([
        { page: 1, text: EXTRACTED_PAGES[0].text },
        { page: 2, text: '' },
        { page: 3, text: EXTRACTED_PAGES[1].text },
      ]);
      // O texto indexado continua sendo a juncao das paginas COM TEXTO:
      // exatamente o que a extracao sem divisao de paginas produzia.
      expect(content).toBe(
        EXTRACTED_PAGES.map((p) => p.text)
          .join('\n\n')
          .trim(),
      );
    });

    test('total de paginas e o do PDF, nao o das paginas com texto', async () => {
      await controller.upload(
        buildFile(),
        { title: 'IN 05/2017', document_type: 'IN' },
        { user: ADMIN },
      );

      expect(documentsService.create.mock.calls[0][0].total_pages).toBe(3);
    });

    // A restricao de cargo saiu daqui: deixou de ser um `if` dentro do handler
    // e passou a ser @Roles(ADMINISTRADOR) + RolesGuard, coberto por
    // src/auth/roles.guard.spec.ts. Testa-la neste arquivo passaria a exercitar
    // codigo que nao existe mais.

    test('arquivo ausente e recusado', async () => {
      await expect(
        controller.upload(
          undefined as unknown as Express.Multer.File,
          { title: 'IN', document_type: 'IN' },
          { user: ADMIN },
        ),
      ).rejects.toThrow('Nenhum ficheiro recebido ou ficheiro vazio.');
    });
  });

  // -------------------------------------------------------------------------
  // Consulta e download do arquivo original
  // -------------------------------------------------------------------------
  describe('getFile', () => {
    function buildResponse() {
      return { set: jest.fn() } as any;
    }

    test('visualizacao inline por padrao', async () => {
      const res = buildResponse();

      const result = await controller.getFile('doc-1', res);

      expect(result).toBeInstanceOf(StreamableFile);
      const headers = res.set.mock.calls[0][0];
      expect(headers['Content-Type']).toBe('application/pdf');
      expect(headers['Content-Disposition']).toContain('inline;');
      expect(headers['Content-Length']).toBe('8');
    });

    test('download quando solicitado', async () => {
      const res = buildResponse();

      await controller.getFile('doc-1', res, '1');

      expect(res.set.mock.calls[0][0]['Content-Disposition']).toContain(
        'attachment;',
      );
      expect(res.set.mock.calls[0][0]['Content-Disposition']).toContain(
        'filename="in-05-2017.pdf"',
      );
    });

    test('download=0 e download=false continuam sendo visualizacao', async () => {
      const zero = buildResponse();
      await controller.getFile('doc-1', zero, '0');
      expect(zero.set.mock.calls[0][0]['Content-Disposition']).toContain(
        'inline;',
      );

      const falsy = buildResponse();
      await controller.getFile('doc-1', falsy, 'false');
      expect(falsy.set.mock.calls[0][0]['Content-Disposition']).toContain(
        'inline;',
      );
    });
  });

  describe('rotas de consulta', () => {
    test('metadados do documento', async () => {
      await controller.findOne('doc-1');
      expect(documentsService.findOne).toHaveBeenCalledWith('doc-1');
    });

    test('texto indexado', async () => {
      await controller.getContent('doc-1');
      expect(documentsService.getContent).toHaveBeenCalledWith('doc-1');
    });
  });

  // -------------------------------------------------------------------------
  // Reprocessamento de coordenadas (documentos ja indexados)
  // -------------------------------------------------------------------------
  describe('backfillLocations', () => {
    test('reprocessa as coordenadas do documento', async () => {
      const result = await controller.backfillLocations('doc-1');

      expect(ragService.backfillDocumentLocations).toHaveBeenCalledWith(
        'doc-1',
      );
      expect(result).toEqual({ documentId: 'doc-1', parents: 3, located: 3 });
    });
  });
});
