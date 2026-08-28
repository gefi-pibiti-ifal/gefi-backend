import { Logger } from '@nestjs/common';
import { RagService, cleanExtractedText, normalizeForSearch } from './rag.service';
import { splitLegalDocument } from './legal-document-splitter';
import {
  buildNormalizedIndex,
  buildPageMap,
  locateSequentialSegments,
  resolvePageSpan,
} from './document-location';

// ---------------------------------------------------------------------------
// Documento de teste: uma norma com anexo, preambulo e itens numerados,
// dividida em paginas como o extrator do PDF entrega. A juncao das paginas com
// '\n\n' reproduz exatamente o texto que o loader produzia antes (splitPages
// false concatenava as paginas com o mesmo separador), entao o chunking sobre
// este texto e o mesmo de sempre.
// ---------------------------------------------------------------------------
const PAGES = [
  {
    page: 1,
    text: [
      'ANEXO VIII-B',
      'DIRETRIZES PARA A FISCALIZACAO ADMINISTRATIVA DOS CONTRATOS',
      '1. A fiscalizacao administrativa das obrigacoes trabalhistas e previdenciarias observara as rotinas descritas neste Anexo, sem prejuizo das demais atribuicoes do fiscal do contrato.',
    ].join('\n'),
  },
  {
    page: 2,
    text: [
      '2.1. A CONTRATADA apresentara mensalmente a documentacao comprobatoria do cumprimento das obrigacoes trabalhistas, incluindo as certidoes negativas de debito exigidas no instrumento contratual.',
      '10.2. Ao final de cada periodo mensal, o fiscal administrativo verificara a regularidade fiscal da contratada e emitira relatorio circunstanciado sobre os dispendios do periodo.',
    ].join('\n'),
  },
  {
    page: 3,
    text: '10.3. Constatada irregularidade, o fiscal notificara a contratada para saneamento no prazo de 5 (cinco) dias uteis, contados do recebimento da notificacao.',
  },
];

const RAW_CONTENT = PAGES.map((p) => p.text).join('\n\n');

// ---------------------------------------------------------------------------
// A premissa que sustenta toda a localizacao: o conteudo de cada grupo emitido
// pelo splitter e, a menos de whitespace, um trecho CONTIGUO do texto limpo.
// Se isso deixar de valer, a localizacao passa a devolver null (nunca uma
// posicao errada) — e estes testes acusam a regressao.
// ---------------------------------------------------------------------------
describe('premissa de localizacao — grupos do splitter dentro do texto limpo', () => {
  const cleaned = cleanExtractedText(RAW_CONTENT);
  const index = buildNormalizedIndex(cleaned);
  const chunks = splitLegalDocument(cleaned);

  test('todo grupo emitido pelo splitter e localizavel', () => {
    const ranges = locateSequentialSegments(
      index,
      chunks.map((c) => c.content),
    );
    expect(ranges.every((r) => r !== null)).toBe(true);
  });

  test('o texto recortado pelo intervalo e o proprio conteudo do grupo', () => {
    const ranges = locateSequentialSegments(
      index,
      chunks.map((c) => c.content),
    );
    ranges.forEach((range, i) => {
      expect(normalizeForSearch(cleaned.slice(range!.start, range!.end))).toBe(
        normalizeForSearch(chunks[i].content),
      );
    });
  });

  test('os intervalos nao se sobrepoem e seguem a ordem do documento', () => {
    const ranges = locateSequentialSegments(
      index,
      chunks.map((c) => c.content),
    );
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]!.start).toBeGreaterThanOrEqual(ranges[i - 1]!.end);
    }
  });
});

describe('mapa de paginas sobre o documento real', () => {
  const cleaned = cleanExtractedText(RAW_CONTENT);
  const index = buildNormalizedIndex(cleaned);
  const cleanedPages = PAGES.map((p) => ({
    page: p.page,
    text: cleanExtractedText(p.text),
  }));
  const pageMap = buildPageMap(index, cleanedPages);

  test('todas as paginas sao ancoradas', () => {
    expect(pageMap.map((e) => e.page_start)).toEqual([1, 2, 3]);
  });

  test('cada item cai na pagina em que foi escrito', () => {
    const chunks = splitLegalDocument(cleaned);
    const ranges = locateSequentialSegments(
      index,
      chunks.map((c) => c.content),
    );

    const pageOf = (n2: string) => {
      const i = chunks.findIndex((c) => c.metadata.n2_header === n2);
      return resolvePageSpan(pageMap, ranges[i]);
    };

    expect(pageOf('1.')).toEqual({ page_start: 1, page_end: 1 });
    expect(pageOf('2.1.')).toEqual({ page_start: 2, page_end: 2 });
    expect(pageOf('10.2.')).toEqual({ page_start: 2, page_end: 2 });
    expect(pageOf('10.3.')).toEqual({ page_start: 3, page_end: 3 });
  });
});

// ---------------------------------------------------------------------------
// Ingestao completa com Prisma/embeddings/vector store simulados.
// ---------------------------------------------------------------------------
type CreatedParent = {
  id: string;
  document_id: string;
  section_header: string;
  content: string;
  metadata: Record<string, any>;
};

function buildHarness() {
  const parents: CreatedParent[] = [];
  const documentUpdates: any[] = [];

  const prisma = {
    normativeDocument: {
      updateMany: jest.fn(async (args: any) => {
        documentUpdates.push(args.data);
        return { count: 1 };
      }),
    },
    parentChunk: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `parent-${parents.length + 1}`, ...data };
        parents.push(row);
        return row;
      }),
    },
  } as any;

  const service = new RagService(prisma);
  const addVectors = jest.fn(async () => undefined);
  (service as any).embeddings = {
    embedDocuments: jest.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
  };
  (service as any).vectorStore = { addVectors };

  const children = () =>
    addVectors.mock.calls.flatMap((call: any[]) => call[1] as any[]);

  return { service, prisma, parents, documentUpdates, children };
}

describe('indexDocument — localizacao gravada na ingestao', () => {
  let logSpy: jest.SpyInstance;

  beforeAll(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterAll(() => logSpy.mockRestore());

  test('parents recebem intervalo de caracteres e pagina', async () => {
    const { service, parents } = buildHarness();

    const result = await service.indexDocument(RAW_CONTENT, 'doc-1', 'IN 05/2017', PAGES);

    expect(result.sections).toBe(parents.length);
    expect(result.locatedSections).toBe(parents.length);
    expect(result.pagesMapped).toBe(3);

    for (const parent of parents) {
      expect(typeof parent.metadata.char_start).toBe('number');
      expect(parent.metadata.char_end).toBeGreaterThan(parent.metadata.char_start);
      expect(parent.metadata.page_start).toBeGreaterThanOrEqual(1);
      expect(parent.metadata.page_end).toBeGreaterThanOrEqual(
        parent.metadata.page_start,
      );
    }
  });

  test('a pagina gravada e a pagina real do dispositivo', async () => {
    const { service, parents } = buildHarness();
    await service.indexDocument(RAW_CONTENT, 'doc-1', 'IN 05/2017', PAGES);

    const pageOf = (section: string) =>
      parents.find((p) => p.section_header === section)!.metadata.page_start;

    expect(pageOf('1.')).toBe(1);
    expect(pageOf('2.1.')).toBe(2);
    expect(pageOf('10.2.')).toBe(2);
    expect(pageOf('10.3.')).toBe(3);
  });

  test('o intervalo do parent recorta, no texto indexado, o proprio conteudo', async () => {
    const { service, parents, documentUpdates } = buildHarness();
    await service.indexDocument(RAW_CONTENT, 'doc-1', 'IN 05/2017', PAGES);

    const indexedContent: string = documentUpdates[0].indexed_content;

    for (const parent of parents) {
      const slice = indexedContent.slice(
        parent.metadata.char_start,
        parent.metadata.char_end,
      );
      expect(normalizeForSearch(slice)).toBe(normalizeForSearch(parent.content));
    }
  });

  test('children recebem a sua propria localizacao, mais fina que a do parent', async () => {
    const { service, children, documentUpdates } = buildHarness();
    await service.indexDocument(RAW_CONTENT, 'doc-1', 'IN 05/2017', PAGES);

    const indexedContent: string = documentUpdates[0].indexed_content;
    const childDocs = children();

    expect(childDocs.length).toBeGreaterThan(0);
    for (const child of childDocs) {
      expect(typeof child.metadata.char_start).toBe('number');
      const slice = indexedContent.slice(
        child.metadata.char_start,
        child.metadata.char_end,
      );
      expect(normalizeForSearch(slice)).toBe(normalizeForSearch(child.pageContent));
      expect(child.metadata.page_start).toBeGreaterThanOrEqual(1);
    }
  });

  test('child longo: cada janela aponta para a sua propria regiao', async () => {
    // Dispositivo grande o bastante para render varios child chunks — o caso em
    // que a localizacao fina de fato importa (a resposta veio de UMA regiao do
    // artigo, nao dele inteiro).
    const longItem =
      '1. ' +
      Array.from(
        { length: 12 },
        (_, i) =>
          `A alinea ${i + 1} trata de obrigacao especifica da contratada quanto a comprovacao mensal de regularidade e a guarda dos documentos correspondentes.`,
      ).join(' ');

    const { service, children, documentUpdates } = buildHarness();
    await service.indexDocument(longItem, 'doc-2', 'Norma longa');

    const indexedContent: string = documentUpdates[0].indexed_content;
    const childDocs = children();

    expect(childDocs.length).toBeGreaterThan(1);

    const starts = childDocs.map((c: any) => c.metadata.char_start);
    expect(new Set(starts).size).toBe(starts.length); // janelas distintas

    for (const child of childDocs) {
      const slice = indexedContent.slice(
        child.metadata.char_start,
        child.metadata.char_end,
      );
      expect(normalizeForSearch(slice)).toBe(normalizeForSearch(child.pageContent));
    }
  });

  test('sem paginas: coordenadas de caractere continuam, pagina fica ausente', async () => {
    const { service, parents } = buildHarness();

    const result = await service.indexDocument(RAW_CONTENT, 'doc-3', 'IN 05/2017');

    expect(result.pagesMapped).toBe(0);
    for (const parent of parents) {
      expect(typeof parent.metadata.char_start).toBe('number');
      expect(parent.metadata.page_start).toBeUndefined();
      expect(parent.metadata.page_end).toBeUndefined();
    }
  });

  test('metadados estruturais existentes seguem intactos', async () => {
    const { service, parents, children } = buildHarness();
    await service.indexDocument(RAW_CONTENT, 'doc-1', 'IN 05/2017', PAGES);

    for (const parent of parents) {
      expect(parent.metadata.documentId).toBe('doc-1');
      expect(parent.metadata.title).toBe('IN 05/2017');
      expect(parent.metadata.n1_header).toBe('ANEXO VIII-B');
      expect(typeof parent.metadata.n2_header).toBe('string');
    }
    for (const child of children()) {
      expect(child.metadata.documentId).toBe('doc-1');
      expect(child.metadata.parentId).toMatch(/^parent-/);
      expect(child.metadata.n1_header).toBe('ANEXO VIII-B');
    }
  });

  test('o texto dividido e o mesmo com ou sem paginas (chunking inalterado)', async () => {
    const withPages = buildHarness();
    await withPages.service.indexDocument(RAW_CONTENT, 'doc-1', 'IN 05/2017', PAGES);

    const withoutPages = buildHarness();
    await withoutPages.service.indexDocument(RAW_CONTENT, 'doc-1', 'IN 05/2017');

    expect(withPages.parents.map((p) => p.content)).toEqual(
      withoutPages.parents.map((p) => p.content),
    );
    expect(withPages.children().map((c: any) => c.pageContent)).toEqual(
      withoutPages.children().map((c: any) => c.pageContent),
    );
  });

  test('o documento recebe texto indexado, mapa de paginas e total de paginas', async () => {
    const { service, documentUpdates } = buildHarness();
    await service.indexDocument(RAW_CONTENT, 'doc-1', 'IN 05/2017', PAGES);

    expect(documentUpdates).toHaveLength(1);
    expect(documentUpdates[0].indexed_content).toBe(cleanExtractedText(RAW_CONTENT));
    expect(documentUpdates[0].total_pages).toBe(3);
    expect(documentUpdates[0].page_map).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Backfill: recupera coordenadas de documentos ja indexados sem reprocessar
// embeddings.
// ---------------------------------------------------------------------------
describe('backfillDocumentLocations', () => {
  let logSpy: jest.SpyInstance;

  beforeAll(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterAll(() => logSpy.mockRestore());

  function buildLegacyHarness() {
    const cleaned = cleanExtractedText(RAW_CONTENT);
    const legacyParents = splitLegalDocument(cleaned).map((chunk, i) => ({
      id: `legacy-${i}`,
      document_id: 'doc-legacy',
      section_header: chunk.metadata.n2_header || chunk.metadata.n1_header,
      content: chunk.content,
      // Metadata como era ANTES: sem qualquer coordenada.
      metadata: {
        documentId: 'doc-legacy',
        title: 'IN 05/2017',
        n1_header: chunk.metadata.n1_header,
        n2_header: chunk.metadata.n2_header,
      },
      created_at: new Date(),
    }));

    const updates: any[] = [];
    const prisma = {
      normativeDocument: {
        findUnique: jest.fn(async () => ({
          id: 'doc-legacy',
          original_content: RAW_CONTENT,
        })),
        update: jest.fn(async (args: any) => args),
      },
      parentChunk: {
        findMany: jest.fn(async () => legacyParents),
        update: jest.fn(async (args: any) => {
          updates.push(args);
          return args;
        }),
      },
    } as any;

    return { service: new RagService(prisma), prisma, legacyParents, updates };
  }

  test('localiza os parents existentes e preserva os metadados antigos', async () => {
    const { service, legacyParents, updates } = buildLegacyHarness();

    const result = await service.backfillDocumentLocations('doc-legacy');

    expect(result.parents).toBe(legacyParents.length);
    expect(result.located).toBe(legacyParents.length);

    for (const update of updates) {
      expect(update.data.metadata.title).toBe('IN 05/2017');
      expect(update.data.metadata.n1_header).toBe('ANEXO VIII-B');
      expect(typeof update.data.metadata.char_start).toBe('number');
      // Paginas NAO sao recuperaveis por backfill: a extracao antiga concatenou
      // as paginas e a divisao se perdeu. Prometer uma pagina aqui seria invencao.
      expect(update.data.metadata.page_start).toBeUndefined();
    }
  });

  test('grava o texto indexado para alinhar as coordenadas ao visualizador', async () => {
    const { service, prisma } = buildLegacyHarness();

    await service.backfillDocumentLocations('doc-legacy');

    expect(prisma.normativeDocument.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { indexed_content: cleanExtractedText(RAW_CONTENT) },
      }),
    );
  });

  test('documento inexistente resulta em 404', async () => {
    const prisma = {
      normativeDocument: { findUnique: jest.fn(async () => null) },
    } as any;

    await expect(
      new RagService(prisma).backfillDocumentLocations('nao-existe'),
    ).rejects.toThrow('Documento nao encontrado');
  });
});
