import {
  buildDocumentLinks,
  buildExcerptLocation,
  buildHistorySources,
  buildResponseSources,
  type ContextDocument,
  type SourceDocumentInfo,
} from './response-sources';

const DOC_A: SourceDocumentInfo = {
  id: 'doc-a',
  title: 'IN 05/2017',
  document_type: 'INSTRUCAO_NORMATIVA',
  total_pages: 42,
  file_name: 'in-05-2017.pdf',
  file_mime_type: 'application/pdf',
  file_size: 1024,
};

// Documento antigo: indexado antes da preservacao do arquivo original.
const DOC_LEGACY: SourceDocumentInfo = {
  id: 'doc-legacy',
  title: 'Lei 14.133/2021',
  document_type: 'LEI',
  total_pages: null,
  file_name: null,
  file_mime_type: null,
  file_size: null,
};

function context(overrides: Record<string, unknown> = {}): ContextDocument {
  return {
    pageContent: 'Ao final de cada periodo mensal, o fiscal administrativo verificara...',
    metadata: {
      documentId: 'doc-a',
      title: 'IN 05/2017',
      n1_header: 'ANEXO VIII-B',
      n2_header: '10.2.',
      sectionHeader: '10.2.',
      parentId: 'parent-1',
      role: 'PRINCIPAL',
      ...overrides,
    },
  };
}

const documents = new Map<string, SourceDocumentInfo>([
  ['doc-a', DOC_A],
  ['doc-legacy', DOC_LEGACY],
]);

// ---------------------------------------------------------------------------
// Compatibilidade: o contrato antigo era `{ id, title }` por documento.
// ---------------------------------------------------------------------------
describe('buildResponseSources — compatibilidade com o contrato antigo', () => {
  test('uma fonte por documento, com id e titulo preservados', () => {
    const sources = buildResponseSources([context()], documents);

    expect(sources).toHaveLength(1);
    expect(sources[0].id).toBe('doc-a');
    expect(sources[0].title).toBe('IN 05/2017');
  });

  test('trechos do mesmo documento colapsam numa unica fonte', () => {
    const sources = buildResponseSources(
      [context(), context({ parentId: 'parent-2', n2_header: '10.3.' })],
      documents,
    );

    expect(sources).toHaveLength(1);
    expect(sources[0].excerpts).toHaveLength(2);
  });

  test('documentos diferentes viram fontes diferentes, na ordem de pertinencia', () => {
    const sources = buildResponseSources(
      [
        context({ documentId: 'doc-legacy', title: 'Lei 14.133/2021' }),
        context(),
        context({ documentId: 'doc-legacy', parentId: 'parent-9' }),
      ],
      documents,
    );

    expect(sources.map((s) => s.id)).toEqual(['doc-legacy', 'doc-a']);
    expect(sources[0].excerpts).toHaveLength(2);
    expect(sources[1].excerpts).toHaveLength(1);
  });

  test('trecho sem documentId e ignorado (nao ha fonte a apontar)', () => {
    expect(buildResponseSources([context({ documentId: undefined })], documents)).toEqual(
      [],
    );
  });

  test('documento sem metadados carregados ainda produz fonte', () => {
    const sources = buildResponseSources(
      [context({ documentId: 'doc-desconhecido', title: 'Edital X' })],
      documents,
    );

    expect(sources[0]).toMatchObject({ id: 'doc-desconhecido', title: 'Edital X' });
    expect(sources[0].file.available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Identificacao do documento e acesso ao arquivo
// ---------------------------------------------------------------------------
describe('buildResponseSources — acesso ao documento', () => {
  test('documento com arquivo expoe visualizacao e download', () => {
    const [source] = buildResponseSources([context()], documents);

    expect(source.file).toEqual({
      available: true,
      name: 'in-05-2017.pdf',
      mime_type: 'application/pdf',
      size: 1024,
    });
    expect(source.view_url).toBe('/api/documents/doc-a/file');
    expect(source.download_url).toBe('/api/documents/doc-a/file?download=1');
    expect(source.content_url).toBe('/api/documents/doc-a/content');
    expect(source.total_pages).toBe(42);
  });

  test('documento sem arquivo original nao promete download, mas continua consultavel', () => {
    const [source] = buildResponseSources(
      [context({ documentId: 'doc-legacy' })],
      documents,
    );

    expect(source.file.available).toBe(false);
    expect(source.view_url).toBeNull();
    expect(source.download_url).toBeNull();
    expect(source.content_url).toBe('/api/documents/doc-legacy/content');
  });

  test('buildDocumentLinks e coerente com o prefixo global da API', () => {
    expect(buildDocumentLinks('abc', true)).toEqual({
      view_url: '/api/documents/abc/file',
      download_url: '/api/documents/abc/file?download=1',
      content_url: '/api/documents/abc/content',
    });
  });
});

// ---------------------------------------------------------------------------
// Rastreabilidade: resposta -> fonte -> documento -> trecho -> localizacao
// ---------------------------------------------------------------------------
describe('buildResponseSources — trecho e citacao', () => {
  test('o trecho carrega o texto exato que foi ao prompt e a sua citacao', () => {
    const [source] = buildResponseSources([context()], documents);
    const [excerpt] = source.excerpts;

    expect(excerpt.excerpt).toBe(
      'Ao final de cada periodo mensal, o fiscal administrativo verificara...',
    );
    expect(excerpt.citation).toBe('Item 10.2 – ANEXO VIII-B – IN 05/2017');
    expect(excerpt.parent_chunk_id).toBe('parent-1');
    expect(excerpt.n1_header).toBe('ANEXO VIII-B');
    expect(excerpt.n2_header).toBe('10.2.');
  });

  test('citacao de artigo nao recebe o prefixo "Item"', () => {
    const [source] = buildResponseSources(
      [context({ n2_header: 'Art. 75', n1_header: '', title: 'Lei 14.133/2021' })],
      documents,
    );

    expect(source.excerpts[0].citation).toBe('Art. 75 – Lei 14.133/2021');
  });

  test('papel do trecho no contexto e preservado', () => {
    const [source] = buildResponseSources(
      [context(), context({ role: 'COMPLEMENTAR', parentId: 'parent-2' })],
      documents,
    );

    expect(source.excerpts.map((e) => e.role)).toEqual(['PRINCIPAL', 'COMPLEMENTAR']);
  });

  test('papel desconhecido cai em PRINCIPAL (nao rebaixa o que nao se explica)', () => {
    const [source] = buildResponseSources([context({ role: undefined })], documents);
    expect(source.excerpts[0].role).toBe('PRINCIPAL');
  });
});

// ---------------------------------------------------------------------------
// Localizacao — a regra central: nunca inventar
// ---------------------------------------------------------------------------
describe('buildExcerptLocation', () => {
  test('prefere o intervalo dos trechos recuperados ao do dispositivo', () => {
    const location = buildExcerptLocation({
      charStart: 100,
      charEnd: 900,
      pageStart: 3,
      pageEnd: 5,
      excerptCharStart: 420,
      excerptCharEnd: 560,
      excerptPageStart: 4,
      excerptPageEnd: 4,
    });

    expect(location).toEqual({
      page_start: 4,
      page_end: 4,
      char_start: 420,
      char_end: 560,
      precision: 'TRECHO',
    });
  });

  test('sem trecho recuperado, usa o dispositivo inteiro', () => {
    const location = buildExcerptLocation({
      charStart: 100,
      charEnd: 900,
      pageStart: 3,
      pageEnd: 5,
    });

    expect(location).toEqual({
      page_start: 3,
      page_end: 5,
      char_start: 100,
      char_end: 900,
      precision: 'DISPOSITIVO',
    });
  });

  test('documento sem paginas: offsets valem, paginas ficam nulas', () => {
    expect(buildExcerptLocation({ charStart: 10, charEnd: 80 })).toEqual({
      page_start: null,
      page_end: null,
      char_start: 10,
      char_end: 80,
      precision: 'DISPOSITIVO',
    });
  });

  test('so pagina conhecida ainda e localizacao util', () => {
    expect(buildExcerptLocation({ pageStart: 12 })).toEqual({
      page_start: 12,
      page_end: 12,
      char_start: null,
      char_end: null,
      precision: 'DISPOSITIVO',
    });
  });

  test('sem nenhuma coordenada a localizacao e null — nunca aproximada', () => {
    expect(buildExcerptLocation({ documentId: 'doc-a', title: 'IN 05/2017' })).toBeNull();
  });

  test('intervalo degenerado e descartado', () => {
    expect(buildExcerptLocation({ charStart: 500, charEnd: 500 })).toBeNull();
    expect(
      buildExcerptLocation({ excerptCharStart: 90, excerptCharEnd: 10 }),
    ).toBeNull();
  });
});

describe('buildResponseSources — fonte sem localizacao continua valida', () => {
  test('documento antigo: fonte completa, location null', () => {
    const [source] = buildResponseSources(
      [context({ documentId: 'doc-legacy', parentId: 'parent-antigo' })],
      documents,
    );

    expect(source.id).toBe('doc-legacy');
    expect(source.excerpts[0].location).toBeNull();
    expect(source.excerpts[0].excerpt).toBeTruthy();
    expect(source.excerpts[0].citation).toBeTruthy();
  });

  test('fontes de documentos diferentes convivem com e sem localizacao', () => {
    const sources = buildResponseSources(
      [
        context({ excerptCharStart: 10, excerptCharEnd: 60, excerptPageStart: 2 }),
        context({ documentId: 'doc-legacy' }),
      ],
      documents,
    );

    expect(sources[0].excerpts[0].location?.precision).toBe('TRECHO');
    expect(sources[1].excerpts[0].location).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Historico — o mesmo contrato, reconstruido do que foi persistido
// ---------------------------------------------------------------------------
describe('buildHistorySources', () => {
  const persisted = [
    {
      normative_id: 'doc-a',
      normative: DOC_A,
      excerpts: [
        {
          parent_chunk_id: 'parent-2',
          section_header: '10.3.',
          n1_header: 'ANEXO VIII-B',
          n2_header: '10.3.',
          citation: 'Item 10.3 – ANEXO VIII-B – IN 05/2017',
          excerpt: 'Constatada irregularidade...',
          role: 'COMPLEMENTAR',
          rank: 1,
          page_start: 3,
          page_end: 3,
          char_start: 900,
          char_end: 1100,
          location_precision: 'TRECHO',
        },
        {
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
          location_precision: 'DISPOSITIVO',
        },
      ],
    },
  ];

  test('reproduz o contrato de fontes com trechos e localizacao', () => {
    const [source] = buildHistorySources(persisted);

    expect(source).toMatchObject({
      id: 'doc-a',
      title: 'IN 05/2017',
      view_url: '/api/documents/doc-a/file',
      download_url: '/api/documents/doc-a/file?download=1',
    });
    expect(source.excerpts[0].location).toEqual({
      page_start: 2,
      page_end: 2,
      char_start: 400,
      char_end: 700,
      precision: 'DISPOSITIVO',
    });
  });

  test('os trechos voltam na ordem em que foram apresentados (rank)', () => {
    const [source] = buildHistorySources(persisted);
    expect(source.excerpts.map((e) => e.n2_header)).toEqual(['10.2.', '10.3.']);
  });

  test('interacao antiga, sem trechos persistidos, ainda devolve a fonte', () => {
    const [source] = buildHistorySources([
      { normative_id: 'doc-legacy', normative: DOC_LEGACY },
    ]);

    expect(source.id).toBe('doc-legacy');
    expect(source.excerpts).toEqual([]);
    expect(source.download_url).toBeNull();
  });

  test('trecho persistido sem coordenadas devolve location null', () => {
    const [source] = buildHistorySources([
      {
        normative_id: 'doc-a',
        normative: DOC_A,
        excerpts: [
          {
            parent_chunk_id: null,
            section_header: null,
            n1_header: null,
            n2_header: null,
            citation: null,
            excerpt: 'trecho sem localizacao',
            role: null,
            rank: 0,
            page_start: null,
            page_end: null,
            char_start: null,
            char_end: null,
            location_precision: null,
          },
        ],
      },
    ]);

    expect(source.excerpts[0].location).toBeNull();
    expect(source.excerpts[0].excerpt).toBe('trecho sem localizacao');
  });

  test('documento removido dos metadados nao derruba a fonte do historico', () => {
    const [source] = buildHistorySources([{ normative_id: 'doc-x', normative: null }]);

    expect(source.id).toBe('doc-x');
    expect(source.file.available).toBe(false);
    expect(source.content_url).toBe('/api/documents/doc-x/content');
  });
});
