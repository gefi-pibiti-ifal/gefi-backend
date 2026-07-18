import {
  parseItemNumber,
  isValidTitleSuffix,
  looksLikeHeading,
  isSequentialItem,
  isStructuralItem,
  extractItemHeader,
  splitLegalDocument,
  splitIntoChildChunks,
  CHILD_CHUNK_SIZE,
  CHILD_CHUNK_OVERLAP,
} from './legal-document-splitter';

// ---------------------------------------------------------------------------
// parseItemNumber
// ---------------------------------------------------------------------------
describe('parseItemNumber', () => {
  describe('válidos', () => {
    const cases: [string, number[], number][] = [
      ['1.',       [1],        1],
      ['2.',       [2],        1],
      ['1.1',      [1, 1],     2],
      ['1.1.1',    [1, 1, 1],  3],
      ['10.2.',    [10, 2],    2],
      ['10.2',     [10, 2],    2],
      ['3.5.',     [3, 5],     2],
      ['2.1.',     [2, 1],     2],
      ['10.2.1.',  [10, 2, 1], 3],
      ['10.3',     [10, 3],    2],
      ['14.133',   [14, 133],  2],
      ['12.4.8',   [12, 4, 8], 3],
    ];
    test.each(cases)('"%s" → numbers=%j level=%i', (input, numbers, level) => {
      const result = parseItemNumber(input);
      expect(result).not.toBeNull();
      expect(result!.numbers).toEqual(numbers);
      expect(result!.level).toBe(level);
      expect(result!.raw).toBe(input);
    });
  });

  describe('inválidos → null', () => {
    const cases: [string, string][] = [
      ['Art. 47',  'artigo'],
      ['8.666,',   'número com vírgula'],
      ['',         'vazio'],
      ['abc',      'texto'],
      ['Lei nº',   'referência'],
      ['nº 8.666', 'começa com nº'],
      ['0.1',      'começa com zero'],
    ];
    test.each(cases)('"%s" (%s) → null', (input) => {
      expect(parseItemNumber(input)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// isValidTitleSuffix
// ---------------------------------------------------------------------------
describe('isValidTitleSuffix', () => {
  describe('deve retornar TRUE', () => {
    const cases: [string, string][] = [
      [' Fiscalização mensal',   'espaço + maiúscula'],
      ['Fiscalização',           'maiúscula sem espaço'],
      ['.Fiscalização',          'ponto + letra (PDF sem espaço)'],
      [' No caso de empresas',   'espaço + minúscula'],
      [' Das sanções',           'preposição'],
      [' Do pagamento',          'preposição'],
      [' Avaliação diária',      'letra acentuada'],
      [' Execução do contrato',  'letra'],
      [' Das penalidades',       'preposição composta'],
    ];
    test.each(cases)('"%s" (%s)', (suffix) => {
      expect(isValidTitleSuffix(suffix)).toBe(true);
    });
  });

  describe('deve retornar FALSE', () => {
    const cases: [string, string][] = [
      ['',             'vazio'],
      [', de 1993',    'vírgula'],
      ['/2021',        'barra'],
      [' de 1993',     '"de" + número'],
      [' nº 8.666',    '"nº" + número'],
      [' n° 14.133',   '"n°" + número'],
      ['12345',        'apenas dígitos'],
      [' 8.666',       'espaço + número'],
      ['123.456',      'número com ponto'],
    ];
    test.each(cases)('"%s" (%s)', (suffix) => {
      expect(isValidTitleSuffix(suffix)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// looksLikeHeading
// ---------------------------------------------------------------------------
describe('looksLikeHeading', () => {
  describe('deve retornar TRUE', () => {
    const cases: [string, string][] = [
      [' Fiscalização mensal',    'título comum'],
      [' Avaliação',              'título comum'],
      [' CAPÍTULO II',            'CAPÍTULO'],
      [' SEÇÃO I',                'SEÇÃO'],
      [' SUBSEÇÃO III',           'SUBSEÇÃO'],
      [' ANEXO VIII-B',           'ANEXO'],
      [' Parágrafo único',        'Parágrafo único'],
      [' parágrafo único',        'parágrafo único minúsculo'],
      [' §',                      'símbolo §'],
      [' I',                      'numeral romano I'],
      [' II',                     'numeral romano II'],
      [' III',                    'numeral romano III'],
      [' IV',                     'numeral romano IV'],
      [' V',                      'numeral romano V'],
      [' Inciso',                 'Inciso'],
      [' Alínea',                 'Alínea'],
      [' Das penalidades',        'preposição + substantivo'],
      [' Do pagamento',           'preposição + substantivo'],
      [' No caso de empresas',    'preposição + substantivo'],
    ];
    test.each(cases)('"%s" (%s)', (suffix) => {
      expect(looksLikeHeading(suffix)).toBe(true);
    });
  });

  describe('deve retornar FALSE', () => {
    const cases: [string, string][] = [
      ['',           'vazio'],
      [', de 1993',  'vírgula'],
      ['/2021',      'barra'],
      [' 8.666',     'número'],
    ];
    test.each(cases)('"%s" (%s)', (suffix) => {
      expect(looksLikeHeading(suffix)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// isSequentialItem
// ---------------------------------------------------------------------------
describe('isSequentialItem', () => {
  describe('deve retornar TRUE', () => {
    const cases: [string, string, string][] = [
      ['10.2.',   '10.3.',   'próximo irmão'],
      ['10.2.',   '10.5.',   'salto de irmão (seções omitidas)'],
      ['10.2.',   '10.2.1.', 'primeiro filho'],
      ['10.5.',   '11.1.',   'nova seção'],
      ['3.5.',    '3.6.',    'próximo irmão'],
      ['3.5.',    '4.1.',    'reinício de seção'],
      ['3.9.',    '4.1.',    'reinício após 9'],
      ['',        '10.1.',   'sem estado: qualquer item válido'],
      ['',        '1.',      'sem estado: nível único'],
      ['10.2.1.', '10.3.',   'subindo de nível'],
      ['1.',      '2.',      'nível único sequencial'],
      ['1.',      '3.',      'nível único com salto'],
      ['2.',      '3.',      'nível único sequencial'],
      ['Art. 5',  '10.1.',   'estado não-numérico: aceita qualquer item'],
      ['1.',      '1.1.',    'nível único → filho'],
      ['10.',     '10.1.',   'nível único alto → filho direto'],
      ['3.',      '3.1.',    'nível único → filho direto'],
      ['9.',      '10.1.',   'nível único → novo bloco'],
      ['1.',      '2.1.',    'nível único → novo bloco avançado'],
      // C1: multi-nível → nível único com avanço numérico
      ['10.2.1.', '11.',     'multi-nível → nível único (avanço)'],
      ['10.5.3.', '11.',     'multi-nível profundo → nível único'],
      ['2.3.4.',  '3.',      'multi-nível → nível único menor avanço'],
      ['8.1.',    '9.',      'dois níveis → nível único'],
    ];
    test.each(cases)('current="%s" candidate="%s" (%s)', (curr, cand) => {
      expect(isSequentialItem(curr, cand)).toBe(true);
    });
  });

  describe('deve retornar FALSE', () => {
    const cases: [string, string, string][] = [
      ['10.2.',  '8.666',    'retrocesso — referência legislativa'],
      ['10.2.',  '14.133',   'salto absurdo — referência legislativa'],
      ['3.5.',   '999.999',  'salto impossível'],
      ['5.1.',   '1.2.',     'retrocesso de seção'],
      ['10.2.',  '10.1.',    'retrocesso de item'],
      ['3.5.',   '1.1.',     'retrocesso de seção'],
      ['2.',     '1.',       'retrocesso de nível único'],
      // C1: multi-nível → nível único com retrocesso
      ['10.2.1.', '9.',      'multi-nível → nível único com retrocesso'],
      ['10.2.1.', '8.',      'multi-nível → nível único com retrocesso maior'],
    ];
    test.each(cases)('current="%s" candidate="%s" (%s)', (curr, cand) => {
      expect(isSequentialItem(curr, cand)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// isStructuralItem — sem contexto
// ---------------------------------------------------------------------------
describe('isStructuralItem (sem contexto)', () => {
  describe('deve retornar TRUE', () => {
    const cases: [string, string][] = [
      ['10.2. Fiscalização mensal',  'item com espaço após ponto'],
      ['10.2.Fiscalização mensal',   'item sem espaço após ponto'],
      ['10.2 Fiscalização mensal',   'item sem ponto final'],
      ['10.3 Fiscalização diária',   'item sem ponto final no prefixo'],
      ['3.5. Avaliação',             'item de dois níveis'],
      ['2.1.No caso de empresas',    'item sem espaço, texto minúsculo'],
      ['10.2.1. Subitem',            'item de três níveis'],
      ['10.2.1 Subitem',             'item de três níveis sem ponto'],
      ['1. Introdução',              'item de nível único'],
      ['2. Objetivo',                'item de nível único'],
      ['3. Disposições gerais',      'item de nível único'],
      ['Art. 47',                    'artigo com espaço e ponto'],
      ['Art.10',                     'artigo sem espaço'],
      ['Art.47',                     'artigo sem espaço nem ponto'],
      ['Art 47',                     'artigo sem ponto'],
      ['Art. 66-A',                  'artigo com sufixo alfanumérico'],
      ['Art.66-A',                   'artigo sem espaço com sufixo'],
      ['Art. 105-B',                 'artigo com sufixo de dois dígitos'],
      ['Art. 5º',                    'artigo com ordinal º'],
      ['Art. 5°',                    'artigo com ordinal °'],
      ['Art.5º',                     'artigo sem espaço com ordinal'],
      ['Art.5°',                     'artigo sem espaço com ordinal °'],
    ];
    test.each(cases)('%s (%s)', (line) => {
      expect(isStructuralItem(line)).toBe(true);
    });
  });

  describe('deve retornar FALSE', () => {
    const cases: [string, string][] = [
      ['8.666, de 1993.',          'vírgula após número'],
      ['14.133, de 2021.',         'vírgula após número'],
      ['10.520, de 2002.',         'vírgula após número'],
      ['8.666 de 1993',           '"de" após número'],
      ['14.133/2021',              'barra após número'],
      ['123.456',                  'número sem texto'],
      ['999.999',                  'número sem texto'],
      ['Lei nº 8.666',             'começa com "Lei"'],
      ['Lei n° 14.133',            'começa com "Lei n°"'],
      ['Lei 14.133',               'começa com "Lei" sem nº'],
      ['Lei nº',                   'começa com "Lei nº" sem número'],
      ['Lei 8.666',                'começa com "Lei" sem nº'],
      ['Decreto nº 10.024',        'começa com "Decreto"'],
      ['Portaria 123',             'começa com "Portaria"'],
      ['Resolução 55',             'começa com "Resolução"'],
      ['Instrução Normativa nº 5', 'começa com "Instrução"'],
      ['nº 8.666',                 'começa com "nº"'],
      ['n° 14.133',                'começa com "n°"'],
    ];
    test.each(cases)('%s (%s)', (line) => {
      expect(isStructuralItem(line)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// isStructuralItem — com contexto
// ---------------------------------------------------------------------------
describe('isStructuralItem (com contexto)', () => {
  describe('deve retornar TRUE quando sequência é coerente', () => {
    const cases: [string, string, string][] = [
      ['10.3. Fiscalização diária', '10.2.',  'próximo irmão'],
      ['10.5. Avaliação',           '10.2.',  'salto de irmão'],
      ['10.2.1. Subitem',           '10.2.',  'primeiro filho'],
      ['11.1. Nova seção',          '10.5.',  'nova seção'],
      ['1. Introdução',             '',       'primeiro item do documento'],
      ['2. Objetivo',               '1.',     'segundo item de nível único'],
      ['3. Disposições',            '1.',     'salto de nível único'],
    ];
    test.each(cases)('%s (current="%s") — %s', (line, current) => {
      expect(isStructuralItem(line, current)).toBe(true);
    });
  });

  describe('deve retornar FALSE quando número é incompatível com contexto', () => {
    const cases: [string, string, string][] = [
      ['8.666, de 1993.',    '10.2.',  'referência com vírgula'],
      ['8.666 de 1993',     '10.2.',  'referência com "de"'],
      ['8.666Fiscalização',  '10.2.',  'número incompatível mesmo com texto'],
      ['14.133Serviços',     '10.2.',  'número incompatível mesmo com texto'],
      ['10.520Pagamento',    '10.2.',  'número incompatível mesmo com texto'],
      ['3.5. Avaliação',     '10.2.',  'retrocesso de seção'],
      ['999.999 Título',     '10.2.',  'salto impossível'],
    ];
    test.each(cases)('%s (current="%s") — %s', (line, current) => {
      expect(isStructuralItem(line, current)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// extractItemHeader
// ---------------------------------------------------------------------------
describe('extractItemHeader', () => {
  const cases: [string, string][] = [
    ['10.2. Fiscalização mensal',  '10.2.'],
    ['10.2.Fiscalização mensal',   '10.2.'],
    ['10.3 Fiscalização diária',   '10.3'],
    ['10.2Fiscalização',           '10.2'],
    ['3.5. Avaliação',             '3.5.'],
    ['2.1.No caso de empresas',    '2.1.'],
    ['10.2.1. Subitem',            '10.2.1.'],
    ['1. Introdução',              '1.'],
    ['2. Objetivo',                '2.'],
    ['Art. 47',                    'Art. 47'],
    ['Art.10',                     'Art.10'],
    ['Art.47',                     'Art.47'],
    ['Art 47',                     'Art 47'],
    ['Art. 66-A',                  'Art. 66-A'],
    ['Art.66-A',                   'Art.66-A'],
    ['Art. 105-B',                 'Art. 105-B'],
    ['Art. 5º',                    'Art. 5º'],
    ['Art. 5°',                    'Art. 5°'],
  ];
  test.each(cases)('"%s" → "%s"', (line, expected) => {
    expect(extractItemHeader(line)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// splitLegalDocument — cabeçalhos quebrados em múltiplas linhas
// ---------------------------------------------------------------------------
describe('splitLegalDocument — cabeçalhos quebrados', () => {
  test('prefixo numérico isolado seguido de título na próxima linha', () => {
    const text = [
      'ANEXO VIII-B',
      '10.1. Fiscalização inicial',
      'Conteúdo do item 10.1 aqui presente neste parágrafo.',
      '10.2.',
      'Fiscalização mensal',
      'Conteúdo do item 10.2 aqui presente neste parágrafo.',
    ].join('\n');

    const chunks = splitLegalDocument(text);
    const chunk102 = chunks.find(c => c.metadata.n2_header === '10.2.');
    expect(chunk102).toBeDefined();
    expect(chunk102!.content).toContain('Fiscalização mensal');
    expect(chunk102!.content).toContain('Conteúdo do item 10.2');
  });

  test('prefixo isolado sem sufixo válido na próxima linha: trata como conteúdo', () => {
    const text = [
      'ANEXO VIII-B',
      '10.1. Fiscalização inicial',
      'Conteúdo do item 10.1 aqui presente neste parágrafo.',
      '10.2.',
      '8.666, de 1993.',
      'Mais conteúdo do item 10.1.',
    ].join('\n');

    const chunks = splitLegalDocument(text);
    // "10.2." não deve ter criado um novo grupo pois o sufixo é inválido
    const chunk102 = chunks.find(c => c.metadata.n2_header === '10.2.');
    expect(chunk102).toBeUndefined();
    // O conteúdo deve estar no grupo 10.1
    const chunk101 = chunks.find(c => c.metadata.n2_header === '10.1.');
    expect(chunk101).toBeDefined();
    expect(chunk101!.content).toContain('8.666, de 1993.');
  });
});

// ---------------------------------------------------------------------------
// splitLegalDocument — C1: transição multi-nível → nível único
// ---------------------------------------------------------------------------
describe('splitLegalDocument — transição multi-nível para nível único', () => {
  test('10.2.1. seguido de 11. cria grupo separado', () => {
    const text = [
      'ANEXO VIII-B',
      '10.2.1. Subitem de fiscalização',
      'Conteúdo do subitem 10.2.1 com texto suficiente para não ser descartado.',
      '11. Próxima seção principal',
      'Conteúdo da seção 11 com texto suficiente para não ser descartado.',
    ].join('\n');

    const chunks = splitLegalDocument(text);

    const chunk1021 = chunks.find(c => c.metadata.n2_header === '10.2.1.');
    expect(chunk1021).toBeDefined();
    expect(chunk1021!.content).toContain('Subitem de fiscalização');

    const chunk11 = chunks.find(c => c.metadata.n2_header === '11.');
    expect(chunk11).toBeDefined();
    expect(chunk11!.content).toContain('Próxima seção principal');
  });

  test('2.3.4. seguido de 3. cria grupo separado', () => {
    const text = [
      'ANEXO I',
      '2.3.4. Subitem profundo',
      'Conteúdo do subitem 2.3.4 com texto suficiente para não ser descartado.',
      '3. Nova seção',
      'Conteúdo da seção 3 com texto suficiente para não ser descartado.',
    ].join('\n');

    const chunks = splitLegalDocument(text);

    const chunk234 = chunks.find(c => c.metadata.n2_header === '2.3.4.');
    expect(chunk234).toBeDefined();

    const chunk3 = chunks.find(c => c.metadata.n2_header === '3.');
    expect(chunk3).toBeDefined();
    expect(chunk3!.content).toContain('Nova seção');
  });

  test('10.2.1. seguido de 9. não cria novo grupo (retrocesso)', () => {
    const text = [
      'ANEXO VIII-B',
      '10.2.1. Subitem',
      'Conteúdo do subitem 10.2.1 com texto suficiente para não ser descartado.',
      '9. Retrocesso inválido',
      'Conteúdo que deveria ficar no grupo anterior.',
    ].join('\n');

    const chunks = splitLegalDocument(text);

    // "9." não deve criar novo grupo pois é retrocesso
    const chunk9 = chunks.find(c => c.metadata.n2_header === '9.');
    expect(chunk9).toBeUndefined();

    // O conteúdo de "9." deve estar no grupo 10.2.1.
    const chunk1021 = chunks.find(c => c.metadata.n2_header === '10.2.1.');
    expect(chunk1021).toBeDefined();
    expect(chunk1021!.content).toContain('Retrocesso inválido');
  });
});

// ---------------------------------------------------------------------------
// splitLegalDocument — preservação de conteúdo (caso original do bug)
// ---------------------------------------------------------------------------
describe('splitLegalDocument — preservação de conteúdo', () => {
  test('referência "8.666, de 1993." não cria novo grupo e permanece em 10.2', () => {
    const text = [
      'ANEXO VIII-B',
      '10.2. Fiscalização mensal',
      'Conteúdo inicial do item 10.2 com texto suficiente para não ser descartado.',
      'conforme disposto no art. 66-A da Lei nº',
      '8.666, de 1993.',
      '10.3. Fiscalização diária',
      'Conteúdo do item 10.3 com texto suficiente para não ser descartado.',
    ].join('\n');

    const chunks = splitLegalDocument(text);

    const chunk102 = chunks.find(c => c.metadata.n2_header === '10.2.');
    expect(chunk102).toBeDefined();
    expect(chunk102!.content).toContain('8.666, de 1993.');

    const chunk103 = chunks.find(c => c.metadata.n2_header === '10.3.');
    expect(chunk103).toBeDefined();
    expect(chunk103!.content).toContain('Fiscalização diária');
  });
});

// ---------------------------------------------------------------------------
// splitLegalDocument — integridade do parent (Fase 1)
//
// Contrato: cada grupo estrutural e emitido como UM chunk com o texto
// integro do buffer. A derivacao dos children (janelas com overlap) acontece
// na ingestao, sobre o conteudo final do parent. Antes, o splitter emitia os
// children direto e o parent era reconstruido pelo join — duplicando ~80
// chars de overlap a cada fronteira e inserindo \n no meio de palavra.
// ---------------------------------------------------------------------------
describe('splitLegalDocument — integridade do parent', () => {
  test('grupo maior que CHILD_CHUNK_SIZE e emitido como um unico chunk integro', () => {
    const frase       = 'Frase de conteudo normativo repetida para exceder o tamanho de child. ';
    const longContent = frase.repeat(15).trim(); // ~1050 chars > CHILD_CHUNK_SIZE
    const text = [
      'ANEXO VIII-B',
      '10.2. Fiscalizacao mensal',
      longContent,
    ].join('\n');

    const chunks   = splitLegalDocument(text);
    const grupo102 = chunks.filter(c => c.metadata.n2_header === '10.2.');

    expect(grupo102).toHaveLength(1);
    expect(grupo102[0].content.length).toBeGreaterThan(CHILD_CHUNK_SIZE);
    expect(grupo102[0].content).toContain('10.2. Fiscalizacao mensal');
    expect(grupo102[0].content).toContain(longContent);
  });

  test('splitIntoChildChunks gera janelas que sao substrings exatas do texto original', () => {
    const text     = 'Conteudo normativo de exemplo. '.repeat(80); // ~2480 chars
    const children = splitIntoChildChunks(text);

    expect(children.length).toBeGreaterThan(1);
    for (const child of children) {
      expect(text).toContain(child);
    }
  });

  test('splitIntoChildChunks preserva o overlap entre janelas consecutivas', () => {
    const text     = 'Conteudo normativo de exemplo. '.repeat(80);
    const children = splitIntoChildChunks(text);

    for (let i = 1; i < children.length; i++) {
      const overlapHead = children[i].slice(0, CHILD_CHUNK_OVERLAP);
      expect(children[i - 1].endsWith(overlapHead)).toBe(true);
    }
  });
});
