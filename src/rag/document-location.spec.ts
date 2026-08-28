import {
  buildLocatedParts,
  buildNormalizedIndex,
  buildPageMap,
  locateInDocument,
  locateSequentialSegments,
  mergePageSpans,
  mergeRanges,
  readCharRange,
  readPageMap,
  readPageSpan,
  resolvePageSpan,
  toNormalizedOffset,
  toSourceRange,
} from './document-location';
import { normalizeForSearch } from './rag.service';

// ---------------------------------------------------------------------------
// buildNormalizedIndex — a base de todo o mapeamento: precisa concordar
// exatamente com normalizeForSearch e apontar de volta para a origem.
// ---------------------------------------------------------------------------
describe('buildNormalizedIndex', () => {
  const cases = [
    'Item 10.2\nO fiscal   verificara\ta regularidade.',
    '  espacos nas extremidades  ',
    'linha1\n\n\nlinha2',
    'sem whitespace extra',
    '',
  ];

  test.each(cases)('concorda com normalizeForSearch: %j', (text) => {
    expect(buildNormalizedIndex(text).normalized).toBe(normalizeForSearch(text));
  });

  test('cada caractere normalizado aponta para a sua origem', () => {
    const text = 'Art.\n39   da Lei';
    const index = buildNormalizedIndex(text);
    for (let i = 0; i < index.normalized.length; i++) {
      const source = text[index.offsets[i]];
      const normalized = index.normalized[i];
      // Whitespace vira espaco unico; os demais caracteres sao identicos.
      if (normalized === ' ') expect(/\s/.test(source)).toBe(true);
      else expect(source).toBe(normalized);
    }
  });

  test('offsets sao estritamente crescentes', () => {
    const index = buildNormalizedIndex('a  b\nc\t\td');
    for (let i = 1; i < index.offsets.length; i++) {
      expect(index.offsets[i]).toBeGreaterThan(index.offsets[i - 1]);
    }
  });

  test('texto so de whitespace produz indice vazio', () => {
    expect(buildNormalizedIndex('  \n\t ').normalized).toBe('');
    expect(buildNormalizedIndex('  \n\t ').offsets).toEqual([]);
  });
});

describe('toSourceRange', () => {
  const text = 'Item 10.2\nO  fiscal verificara.';
  const index = buildNormalizedIndex(text);

  test('recorta no texto de origem o mesmo conteudo do intervalo normalizado', () => {
    const at = index.normalized.indexOf('O fiscal');
    const range = toSourceRange(index, at, at + 'O fiscal'.length)!;
    expect(normalizeForSearch(text.slice(range.start, range.end))).toBe('O fiscal');
  });

  test('intervalo vazio ou invertido retorna null', () => {
    expect(toSourceRange(index, 5, 5)).toBeNull();
    expect(toSourceRange(index, 8, 3)).toBeNull();
  });

  test('inicio fora dos limites retorna null', () => {
    expect(toSourceRange(index, 9999, 10000)).toBeNull();
  });

  test('indice vazio retorna null', () => {
    expect(toSourceRange(buildNormalizedIndex(''), 0, 1)).toBeNull();
  });
});

describe('toNormalizedOffset', () => {
  const text = 'abc\n\ndef';
  const index = buildNormalizedIndex(text);

  test('offset de caractere visivel mapeia para a sua posicao normalizada', () => {
    expect(toNormalizedOffset(index, text.indexOf('d'))).toBe(
      index.normalized.indexOf('def'),
    );
  });

  test('offset no meio do whitespace cai no proximo caractere visivel', () => {
    expect(toNormalizedOffset(index, 4)).toBe(index.normalized.indexOf('def'));
  });

  test('offset no fim do texto mapeia para o fim do normalizado', () => {
    expect(toNormalizedOffset(index, text.length)).toBe(index.normalized.length);
  });
});

// ---------------------------------------------------------------------------
// locateSequentialSegments
// ---------------------------------------------------------------------------
describe('locateSequentialSegments', () => {
  test('localiza cada segmento e o recorte devolve o proprio segmento', () => {
    const text = '1. Primeiro item.\n2. Segundo item.\n3. Terceiro item.';
    const index = buildNormalizedIndex(text);
    const segments = ['1. Primeiro item.', '2. Segundo item.', '3. Terceiro item.'];

    const ranges = locateSequentialSegments(index, segments);

    ranges.forEach((range, i) => {
      expect(range).not.toBeNull();
      expect(text.slice(range!.start, range!.end)).toBe(segments[i]);
    });
  });

  test('tolera diferenca de whitespace entre segmento e documento', () => {
    const text = 'Art. 39.\nO fiscal\n   verificara a regularidade.';
    const index = buildNormalizedIndex(text);
    // O splitter reune as linhas com '\n' unico — forma diferente da do texto.
    const range = locateSequentialSegments(index, [
      'Art. 39.\nO fiscal verificara a regularidade.',
    ])[0];

    expect(range).not.toBeNull();
    expect(normalizeForSearch(text.slice(range!.start, range!.end))).toBe(
      'Art. 39. O fiscal verificara a regularidade.',
    );
  });

  test('segmentos identicos caem cada um na sua ocorrencia (cursor monotonico)', () => {
    const text = 'Paragrafo unico. Vedado. Outro texto. Paragrafo unico. Vedado.';
    const index = buildNormalizedIndex(text);

    const ranges = locateSequentialSegments(index, [
      'Paragrafo unico. Vedado.',
      'Paragrafo unico. Vedado.',
    ]);

    expect(ranges[0]!.start).toBe(0);
    expect(ranges[1]!.start).toBeGreaterThan(ranges[0]!.end);
  });

  test('segmento ausente retorna null sem desalinhar os seguintes', () => {
    const text = 'Item A. Item C.';
    const index = buildNormalizedIndex(text);

    const ranges = locateSequentialSegments(index, ['Item A.', 'Item B.', 'Item C.']);

    expect(ranges[0]).not.toBeNull();
    expect(ranges[1]).toBeNull();
    expect(text.slice(ranges[2]!.start, ranges[2]!.end)).toBe('Item C.');
  });

  test('segmento vazio retorna null', () => {
    const index = buildNormalizedIndex('qualquer texto');
    expect(locateSequentialSegments(index, ['   '])).toEqual([null]);
  });
});

// ---------------------------------------------------------------------------
// buildPageMap / resolvePageSpan
// ---------------------------------------------------------------------------
describe('buildPageMap', () => {
  const pages = [
    { page: 1, text: 'Capa do documento normativo.' },
    { page: 2, text: 'Item 1. Primeira obrigacao da contratada.' },
    { page: 3, text: 'Item 2. Segunda obrigacao da contratada.' },
  ];
  const fullText = pages.map((p) => p.text).join('\n\n');
  const index = buildNormalizedIndex(fullText);

  test('cada pagina vira uma faixa contigua do texto', () => {
    const map = buildPageMap(index, pages);

    expect(map).toHaveLength(3);
    expect(map[0]).toMatchObject({ page_start: 1, page_end: 1, start: 0 });
    expect(map[2].page_start).toBe(3);
    expect(map[2].end).toBeGreaterThanOrEqual(fullText.trimEnd().length);
  });

  test('o inicio de cada pagina cai dentro da sua faixa', () => {
    const map = buildPageMap(index, pages);

    for (const page of pages) {
      const offset = fullText.indexOf(page.text);
      const span = resolvePageSpan(map, { start: offset, end: offset + 5 });
      expect(span).toEqual({ page_start: page.page, page_end: page.page });
    }
  });

  test('trecho que atravessa duas paginas devolve o intervalo completo', () => {
    const map = buildPageMap(index, pages);
    const start = fullText.indexOf('Primeira');
    const end = fullText.indexOf('Segunda') + 7;

    expect(resolvePageSpan(map, { start, end })).toEqual({
      page_start: 2,
      page_end: 3,
    });
  });

  test('pagina nao ancorada e absorvida pela anterior, virando um INTERVALO', () => {
    // A pagina 2 nao existe no texto (ex.: pagina de imagem, sem texto util):
    // o mapa nunca inventa uma posicao para ela — declara "entre 1 e 2".
    const partialPages = [
      { page: 1, text: 'Capa do documento normativo.' },
      { page: 2, text: 'ESTE TEXTO NAO APARECE NO DOCUMENTO' },
      { page: 3, text: 'Item 2. Segunda obrigacao da contratada.' },
    ];
    const map = buildPageMap(index, partialPages);

    expect(map[0]).toMatchObject({ page_start: 1, page_end: 2 });
    expect(map[1]).toMatchObject({ page_start: 3, page_end: 3 });
  });

  test('sem paginas ou sem texto o mapa e vazio', () => {
    expect(buildPageMap(index, [])).toEqual([]);
    expect(buildPageMap(buildNormalizedIndex(''), pages)).toEqual([]);
  });

  test('pagina em branco nao produz faixa', () => {
    const map = buildPageMap(index, [
      { page: 1, text: 'Capa do documento normativo.' },
      { page: 2, text: '   ' },
      { page: 3, text: 'Item 2. Segunda obrigacao da contratada.' },
    ]);
    expect(map.map((e) => e.page_start)).toEqual([1, 3]);
  });
});

describe('resolvePageSpan', () => {
  const map = [
    { page_start: 1, page_end: 1, start: 0, end: 100 },
    { page_start: 2, page_end: 2, start: 100, end: 200 },
  ];

  test('mapa vazio retorna null', () => {
    expect(resolvePageSpan([], { start: 0, end: 10 })).toBeNull();
  });

  test('intervalo ausente retorna null', () => {
    expect(resolvePageSpan(map, null)).toBeNull();
  });

  test('intervalo fora do mapa retorna null', () => {
    expect(resolvePageSpan(map, { start: 500, end: 600 })).toBeNull();
  });

  test('intervalo dentro de uma pagina retorna a propria pagina', () => {
    expect(resolvePageSpan(map, { start: 120, end: 150 })).toEqual({
      page_start: 2,
      page_end: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// buildLocatedParts / locateInDocument — offsets internos do ParentChunk
// ---------------------------------------------------------------------------
describe('locateInDocument', () => {
  const document = [
    'ANEXO VIII-B',
    'Item 1. Primeira obrigacao da contratada.',
    'Item 2. Segunda obrigacao da contratada.',
  ].join('\n');
  const index = buildNormalizedIndex(document);

  const parts = [
    'Item 1. Primeira obrigacao da contratada.',
    'Item 2. Segunda obrigacao da contratada.',
  ];
  const ranges = locateSequentialSegments(index, parts);
  const located = buildLocatedParts(parts, ranges);

  test('janela interna do parent volta para o texto correspondente no documento', () => {
    const parentContent = parts.join('\n');
    const start = parentContent.indexOf('Segunda');
    const range = locateInDocument(index, located, start, start + 'Segunda'.length)!;

    expect(document.slice(range.start, range.end)).toBe('Segunda');
  });

  test('janela que atravessa duas partes cobre da primeira a segunda', () => {
    const parentContent = parts.join('\n');
    const start = parentContent.indexOf('Primeira');
    const end = parentContent.indexOf('Segunda') + 'Segunda'.length;
    const range = locateInDocument(index, located, start, end)!;

    const slice = document.slice(range.start, range.end);
    expect(slice.startsWith('Primeira')).toBe(true);
    expect(slice.endsWith('Segunda')).toBe(true);
  });

  test('parte nao localizada nao gera localizacao aproximada', () => {
    const unlocated = buildLocatedParts(parts, [null, null]);
    expect(locateInDocument(index, unlocated, 0, 10)).toBeNull();
  });

  test('lista de partes vazia ou janela invertida retorna null', () => {
    expect(locateInDocument(index, [], 0, 10)).toBeNull();
    expect(locateInDocument(index, located, 10, 5)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// merges e leitura tolerante de metadata
// ---------------------------------------------------------------------------
describe('mergeRanges / mergePageSpans', () => {
  test('une intervalos ignorando nulos', () => {
    expect(mergeRanges([{ start: 40, end: 50 }, null, { start: 10, end: 20 }])).toEqual({
      start: 10,
      end: 50,
    });
  });

  test('sem intervalos validos retorna null', () => {
    expect(mergeRanges([null, undefined])).toBeNull();
    expect(mergePageSpans([null, undefined])).toBeNull();
  });

  test('une faixas de pagina', () => {
    expect(
      mergePageSpans([
        { page_start: 3, page_end: 3 },
        { page_start: 1, page_end: 2 },
      ]),
    ).toEqual({ page_start: 1, page_end: 3 });
  });
});

describe('leitura de metadata (documentos antigos nao quebram)', () => {
  test('metadata sem coordenadas retorna null', () => {
    expect(readCharRange({ title: 'IN 05/2017' })).toBeNull();
    expect(readPageSpan({ title: 'IN 05/2017' })).toBeNull();
    expect(readCharRange(null)).toBeNull();
    expect(readPageSpan(undefined)).toBeNull();
  });

  test('intervalo invalido (fim <= inicio) e descartado', () => {
    expect(readCharRange({ char_start: 100, char_end: 100 })).toBeNull();
    expect(readCharRange({ char_start: 100, char_end: 40 })).toBeNull();
  });

  test('coordenadas validas sao lidas', () => {
    expect(readCharRange({ char_start: 10, char_end: 40 })).toEqual({
      start: 10,
      end: 40,
    });
  });

  test('pagina sem page_end assume pagina unica', () => {
    expect(readPageSpan({ page_start: 7 })).toEqual({ page_start: 7, page_end: 7 });
  });

  test('page_map invalido ou nao-array vira lista vazia', () => {
    expect(readPageMap(null)).toEqual([]);
    expect(readPageMap('nao e um mapa')).toEqual([]);
    expect(readPageMap([{ page_start: 1 }, null, { start: 0, end: 10 }])).toEqual([]);
  });

  test('page_map valido e lido preservando as faixas', () => {
    expect(
      readPageMap([{ page_start: 1, page_end: 2, start: 0, end: 500 }]),
    ).toEqual([{ page_start: 1, page_end: 2, start: 0, end: 500 }]);
  });
});
