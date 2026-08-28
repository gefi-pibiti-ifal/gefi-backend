import { Document } from '@langchain/core/documents';
import { Logger } from '@nestjs/common';
import { RagService } from './rag.service';

// ---------------------------------------------------------------------------
// Fluxo completo da resposta: recuperacao -> prompt -> fontes -> persistencia.
// A recuperacao e o LLM sao simulados; o que esta sob teste e a construcao das
// fontes navegaveis e a gravacao da rastreabilidade.
// ---------------------------------------------------------------------------
const DOCUMENTS = [
  {
    id: 'doc-a',
    title: 'IN 05/2017',
    document_type: 'INSTRUCAO_NORMATIVA',
    total_pages: 42,
    file_name: 'in-05-2017.pdf',
    file_mime_type: 'application/pdf',
    file_size: 2048,
  },
  {
    // Documento antigo: indexado antes da preservacao do arquivo original.
    id: 'doc-legacy',
    title: 'Lei 14.133/2021',
    document_type: 'LEI',
    total_pages: null,
    file_name: null,
    file_mime_type: null,
    file_size: null,
  },
];

function parentDoc(overrides: Record<string, unknown> = {}) {
  return new Document({
    pageContent: 'Ao final de cada periodo mensal, o fiscal administrativo verificara...',
    metadata: {
      documentId: 'doc-a',
      title: 'IN 05/2017',
      n1_header: 'ANEXO VIII-B',
      n2_header: '10.2.',
      sectionHeader: '10.2.',
      parentId: 'parent-1',
      role: 'PRINCIPAL',
      charStart: 1000,
      charEnd: 1800,
      pageStart: 2,
      pageEnd: 3,
      excerptCharStart: 1200,
      excerptCharEnd: 1450,
      excerptPageStart: 2,
      excerptPageEnd: 2,
      ...overrides,
    },
  });
}

function buildHarness(parents: Document[]) {
  const created: any[] = [];
  const prisma = {
    normativeDocument: {
      findMany: jest.fn(async ({ where }: any) =>
        DOCUMENTS.filter((d) => where.id.in.includes(d.id)),
      ),
    },
    interactionHistory: {
      create: jest.fn(async (args: any) => {
        created.push(args);
        return { id: 'interaction-1', created_at: new Date('2026-01-01') };
      }),
    },
  } as any;

  const service = new RagService(prisma);
  const sourceDocIds = [
    ...new Set(parents.map((p) => p.metadata.documentId as string)),
  ];
  (service as any).retrieveParentContexts = jest.fn(async () => ({
    parents,
    sourceDocIds,
  }));
  (service as any).llm = {
    invoke: jest.fn(async () => ({
      content: 'Sim. A verificacao e mensal.',
      response_metadata: { finishReason: 'STOP' },
    })),
  };

  return { service, prisma, created };
}

describe('query — fontes navegaveis na resposta', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeAll(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });
  afterAll(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('a fonte identifica o documento e oferece consulta e download', async () => {
    const { service } = buildHarness([parentDoc()]);

    const result = await service.query('rotina mensal', 'conv-1');

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      id: 'doc-a',
      title: 'IN 05/2017',
      document_type: 'INSTRUCAO_NORMATIVA',
      total_pages: 42,
      view_url: '/api/documents/doc-a/file',
      download_url: '/api/documents/doc-a/file?download=1',
      content_url: '/api/documents/doc-a/content',
    });
    expect(result.sources[0].file.available).toBe(true);
  });

  test('a fonte preserva trecho, citacao e localizacao do que fundamentou', async () => {
    const { service } = buildHarness([parentDoc()]);

    const result = await service.query('rotina mensal', 'conv-1');
    const [excerpt] = result.sources[0].excerpts;

    expect(excerpt.parent_chunk_id).toBe('parent-1');
    expect(excerpt.citation).toBe('Item 10.2 – ANEXO VIII-B – IN 05/2017');
    expect(excerpt.excerpt).toContain('fiscal administrativo');
    expect(excerpt.location).toEqual({
      page_start: 2,
      page_end: 2,
      char_start: 1200,
      char_end: 1450,
      precision: 'TRECHO',
    });
  });

  test('trechos de documentos diferentes viram fontes diferentes', async () => {
    const { service } = buildHarness([
      parentDoc(),
      parentDoc({
        documentId: 'doc-legacy',
        title: 'Lei 14.133/2021',
        n1_header: '',
        n2_header: 'Art. 75',
        sectionHeader: 'Art. 75',
        parentId: 'parent-9',
        charStart: undefined,
        charEnd: undefined,
        pageStart: undefined,
        pageEnd: undefined,
        excerptCharStart: undefined,
        excerptCharEnd: undefined,
        excerptPageStart: undefined,
        excerptPageEnd: undefined,
      }),
    ]);

    const result = await service.query('limites de dispensa', 'conv-1');

    expect(result.sources.map((s) => s.id)).toEqual(['doc-a', 'doc-legacy']);
    // Documento sem localizacao e sem arquivo continua sendo fonte utilizavel.
    expect(result.sources[1].excerpts[0].location).toBeNull();
    expect(result.sources[1].download_url).toBeNull();
    expect(result.sources[1].content_url).toBe('/api/documents/doc-legacy/content');
    expect(result.sources[1].excerpts[0].citation).toBe('Art. 75 – Lei 14.133/2021');
  });

  test('varios trechos do mesmo documento ficam sob uma unica fonte', async () => {
    const { service } = buildHarness([
      parentDoc(),
      parentDoc({ parentId: 'parent-2', n2_header: '10.3.', role: 'COMPLEMENTAR' }),
    ]);

    const result = await service.query('rotina mensal', 'conv-1');

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].excerpts).toHaveLength(2);
    expect(result.sources[0].excerpts.map((e) => e.role)).toEqual([
      'PRINCIPAL',
      'COMPLEMENTAR',
    ]);
  });

  // -------------------------------------------------------------------------
  // Persistencia da rastreabilidade
  // -------------------------------------------------------------------------
  test('a interacao grava as fontes e os trechos com a sua localizacao', async () => {
    const { service, created } = buildHarness([parentDoc()]);

    await service.query('rotina mensal', 'conv-1');

    const responseSources = created[0].data.responseSources.create;
    expect(responseSources).toHaveLength(1);
    expect(responseSources[0].normative.connect).toEqual({ id: 'doc-a' });

    const [persisted] = responseSources[0].excerpts.create;
    expect(persisted).toMatchObject({
      parent_chunk_id: 'parent-1',
      section_header: '10.2.',
      n1_header: 'ANEXO VIII-B',
      n2_header: '10.2.',
      role: 'PRINCIPAL',
      rank: 0,
      page_start: 2,
      page_end: 2,
      char_start: 1200,
      char_end: 1450,
      location_precision: 'TRECHO',
    });
    expect(persisted.excerpt).toContain('fiscal administrativo');
  });

  test('a ordem de apresentacao dos trechos e preservada no rank', async () => {
    const { service, created } = buildHarness([
      parentDoc(),
      parentDoc({ parentId: 'parent-2', n2_header: '10.3.' }),
    ]);

    await service.query('rotina mensal', 'conv-1');

    const ranks = created[0].data.responseSources.create[0].excerpts.create.map(
      (e: any) => e.rank,
    );
    expect(ranks).toEqual([0, 1]);
  });

  test('trecho sem localizacao e gravado com coordenadas nulas, nunca estimadas', async () => {
    const { service, created } = buildHarness([
      parentDoc({
        charStart: undefined,
        charEnd: undefined,
        pageStart: undefined,
        pageEnd: undefined,
        excerptCharStart: undefined,
        excerptCharEnd: undefined,
        excerptPageStart: undefined,
        excerptPageEnd: undefined,
      }),
    ]);

    await service.query('rotina mensal', 'conv-1');

    expect(created[0].data.responseSources.create[0].excerpts.create[0]).toMatchObject({
      page_start: null,
      page_end: null,
      char_start: null,
      char_end: null,
      location_precision: null,
    });
  });

  test('as fontes persistidas sao exatamente os documentos do contexto (invariante I3)', async () => {
    const { service, created } = buildHarness([
      parentDoc(),
      parentDoc({ documentId: 'doc-legacy', parentId: 'parent-9' }),
      parentDoc({ parentId: 'parent-2' }),
    ]);

    const result = await service.query('pergunta transversal', 'conv-1');

    const persistedIds = created[0].data.responseSources.create.map(
      (s: any) => s.normative.connect.id,
    );
    expect(persistedIds).toEqual(result.sources.map((s) => s.id));
    expect(new Set(persistedIds).size).toBe(persistedIds.length);
  });

  // -------------------------------------------------------------------------
  // Robustez: as fontes sobrevivem a falhas e a ausencia de contexto
  // -------------------------------------------------------------------------
  test('falha do LLM nao apaga as fontes recuperadas', async () => {
    const { service } = buildHarness([parentDoc()]);
    (service as any).llm.invoke = jest.fn(async () => {
      throw new Error('503 Service Unavailable');
    });

    const result = await service.query('rotina mensal', 'conv-1');

    expect(result.response).toContain('falha tecnica');
    expect(result.sources[0].excerpts[0].location?.page_start).toBe(2);
  });

  test('sem contexto recuperado, a resposta nao promete fonte alguma', async () => {
    const { service, created } = buildHarness([]);

    const result = await service.query('pergunta sem correspondencia', 'conv-1');

    expect(result.sources).toEqual([]);
    expect(created[0].data.responseSources.create).toEqual([]);
  });

  test('documento sem metadados carregados ainda produz fonte identificavel', async () => {
    const { service, prisma } = buildHarness([parentDoc()]);
    prisma.normativeDocument.findMany.mockResolvedValueOnce([]);

    const result = await service.query('rotina mensal', 'conv-1');

    expect(result.sources[0].id).toBe('doc-a');
    expect(result.sources[0].title).toBe('IN 05/2017'); // vem do metadado do trecho
    expect(result.sources[0].file.available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A ponte entre ingestao e resposta: a recuperacao precisa CARREGAR a
// localizacao gravada na ingestao ate o contexto que vira fonte.
// ---------------------------------------------------------------------------
const PARENT_CONTENT =
  'Ao final de cada periodo mensal, o fiscal administrativo verificara a regularidade ' +
  'fiscal da contratada e emitira relatorio circunstanciado sobre os dispendios do periodo, ' +
  'anexando a documentacao comprobatoria correspondente.';

function parentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'parent-1',
    document_id: 'doc-a',
    section_header: '10.2.',
    content: PARENT_CONTENT,
    metadata: {
      documentId: 'doc-a',
      title: 'IN 05/2017',
      n1_header: 'ANEXO VIII-B',
      n2_header: '10.2.',
      char_start: 1000,
      char_end: 1800,
      page_start: 2,
      page_end: 3,
      ...overrides,
    },
    created_at: new Date(),
  };
}

function childHit(metadata: Record<string, unknown>, score = 0.1) {
  return [
    new Document({
      pageContent: PARENT_CONTENT.slice(0, 60),
      metadata: { documentId: 'doc-a', parentId: 'parent-1', ...metadata },
    }),
    score,
  ] as [Document, number];
}

function buildRetrievalHarness(parents: any[], hits: Array<[Document, number]>) {
  const prisma = {
    parentChunk: {
      findMany: jest.fn(async ({ where }: any) =>
        where?.id?.in ? parents.filter((p) => where.id.in.includes(p.id)) : [],
      ),
    },
  } as any;

  const service = new RagService(prisma);
  (service as any).embeddings = { embedQuery: jest.fn(async () => [0.1, 0.2]) };
  (service as any).vectorStore = {
    similaritySearchVectorWithScore: jest.fn(async () => hits),
  };

  return (service as any).retrieveParentContexts.bind(service) as (
    q: string,
  ) => Promise<{ parents: Document[]; sourceDocIds: string[] }>;
}

describe('retrieveParentContexts — a localizacao chega ao contexto', () => {
  test('o contexto carrega a localizacao do dispositivo e a do trecho recuperado', async () => {
    const retrieve = buildRetrievalHarness(
      [parentRow()],
      [childHit({ char_start: 1200, char_end: 1450, page_start: 2, page_end: 2 })],
    );

    const { parents } = await retrieve('rotina mensal');

    expect(parents[0].metadata).toMatchObject({
      parentId: 'parent-1',
      charStart: 1000,
      charEnd: 1800,
      pageStart: 2,
      pageEnd: 3,
      excerptCharStart: 1200,
      excerptCharEnd: 1450,
      excerptPageStart: 2,
      excerptPageEnd: 2,
    });
  });

  test('varios trechos do mesmo dispositivo cobrem do primeiro ao ultimo', async () => {
    const retrieve = buildRetrievalHarness(
      [parentRow()],
      [
        childHit({ char_start: 1600, char_end: 1750, page_start: 3, page_end: 3 }, 0.2),
        childHit({ char_start: 1200, char_end: 1450, page_start: 2, page_end: 2 }, 0.1),
      ],
    );

    const { parents } = await retrieve('rotina mensal');

    expect(parents[0].metadata).toMatchObject({
      excerptCharStart: 1200,
      excerptCharEnd: 1750,
      excerptPageStart: 2,
      excerptPageEnd: 3,
    });
  });

  test('child indexado sem localizacao: sobra a do dispositivo', async () => {
    const retrieve = buildRetrievalHarness([parentRow()], [childHit({})]);

    const { parents } = await retrieve('rotina mensal');

    expect(parents[0].metadata.charStart).toBe(1000);
    expect(parents[0].metadata.excerptCharStart).toBeUndefined();
    expect(parents[0].metadata.excerptPageStart).toBeUndefined();
  });

  test('documento indexado antes da funcionalidade: contexto sem localizacao', async () => {
    const legacyParent = parentRow();
    delete (legacyParent.metadata as any).char_start;
    delete (legacyParent.metadata as any).char_end;
    delete (legacyParent.metadata as any).page_start;
    delete (legacyParent.metadata as any).page_end;

    const retrieve = buildRetrievalHarness([legacyParent], [childHit({})]);

    const { parents, sourceDocIds } = await retrieve('rotina mensal');

    expect(parents[0].metadata.charStart).toBeUndefined();
    expect(parents[0].metadata.pageStart).toBeUndefined();
    // A fonte continua existindo: identificacao do documento nao depende de
    // localizacao.
    expect(parents[0].metadata.documentId).toBe('doc-a');
    expect(sourceDocIds).toEqual(['doc-a']);
  });
});
