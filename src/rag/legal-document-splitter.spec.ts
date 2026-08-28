import {
  parseItemNumber,
  isValidTitleSuffix,
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
// Aberturas de clausula que a antiga camada looksLikeHeading rejeitava.
//
// Regressao do caso real: no contrato indexado, "3.1. O prazo de vigencia...
// ate o limite de 60 (sessenta) meses" nunca virava ParentChunk proprio
// porque o sufixo "O prazo" (maiuscula isolada + espaco) nao casava com a
// allowlist de formas de titulo — a clausula de vigencia era absorvida pelo
// chunk da tabela de precos e nao aparecia no Top-K da busca vetorial.
// ---------------------------------------------------------------------------
describe('isStructuralItem — aberturas de clausula de contrato (regressao)', () => {
  describe('deve aceitar clausulas iniciadas por artigo/conjuncao de uma letra', () => {
    const cases: [string, string, string][] = [
      ['3.1. O prazo de vigência deste Termo de Contrato é de 24 (vinte e quatro) meses', '3.', 'clausula iniciada por "O"'],
      ['2.1. A presente contratação fundamenta-se no art. 2º', '1.3', 'clausula iniciada por "A"'],
      ['4.2. E ainda deverá ser comprovada a regularidade fiscal', '4.1.', 'clausula iniciada por "E"'],
      ['9. É permitida a licitação:', '8.', 'item iniciado por "É" acentuado'],
    ];
    test.each(cases)('%s (current="%s") — %s', (line, current) => {
      expect(isStructuralItem(line, current)).toBe(true);
    });
  });

  describe('deve aceitar titulos totalmente em caixa alta', () => {
    const cases: [string, string, string][] = [
      ['3.         CLÁUSULA TERCEIRA – VIGÊNCIA', '2.1.', 'titulo de clausula em caixa alta'],
      ['11. CLÁUSULA DÉCIMA PRIMEIRA – SANÇÕES ADMINISTRATIVAS', '8.1.', 'titulo caixa alta apos salto'],
      ['12. CLÁUSULA DÉCIMA SEGUNDA – RESCISÃO CONTRATUAL', '11.1.', 'titulo caixa alta sequencial'],
    ];
    test.each(cases)('%s (current="%s") — %s', (line, current) => {
      expect(isStructuralItem(line, current)).toBe(true);
    });
  });

  describe('prefixo com espaco de artefato de PDF ("N .")', () => {
    test('"2 .  CLÁUSULA SEGUNDA – FUNDAMENTO LEGAL" e item estrutural', () => {
      expect(isStructuralItem('2 .  CLÁUSULA SEGUNDA – FUNDAMENTO LEGAL', '1.3')).toBe(true);
    });

    test('extractItemHeader normaliza "2 ." para a forma canonica "2."', () => {
      expect(extractItemHeader('2 .  CLÁUSULA SEGUNDA – FUNDAMENTO LEGAL')).toBe('2.');
    });
  });

  describe('numeros de lei continuam rejeitados mesmo sem estado corrente', () => {
    const cases: [string, string][] = [
      ['8.666Fiscalização', 'numero de lei colado a texto'],
      ['14.133 Serviços de contratação', 'numero de lei + texto'],
      ['10.520 Pagamento', 'numero de lei + texto'],
    ];
    test.each(cases)('"%s" (%s) → false', (line) => {
      expect(isStructuralItem(line)).toBe(false);
    });
  });

  describe('enumeracao decimal dentro de ARTIGO nao abre grupo (caso IN SEGES 147)', () => {
    test('continuacao de frase em minuscula apos artigo permanece conteudo', () => {
      expect(isStructuralItem('1. do limite de idade da criança para a concessão do benefício; e', 'Art. 4')).toBe(false);
      expect(isStructuralItem('2. da obrigatoriedade ou dispensa de comprovação de despesas pelo beneficiário; ou', 'Art. 4')).toBe(false);
    });

    test('titulo capitalizado apos artigo continua abrindo grupo', () => {
      expect(isStructuralItem('1. Introdução', 'Art. 4')).toBe(true);
      expect(isStructuralItem('1. Do objeto', 'Art. 4')).toBe(true);
    });

    test('item multi-nivel apos artigo nao e afetado pelo guard', () => {
      expect(isStructuralItem('10.1. das obrigações previstas na norma', 'Art. 5')).toBe(true);
    });

    test('fora do estado de artigo, minuscula apos numero segue aceita', () => {
      expect(isStructuralItem('2. das penalidades aplicáveis ao caso', '1.')).toBe(true);
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
      // Profundidade >= 3 — regressao: a regra antiga so tratava nivel 2 e
      // rejeitava TODA transicao de irmaos em nivel 3+, fundindo os subitens
      // de uma clausula ("3.2.1." absorvia 3.2.2 a 3.2.11 no contrato real).
      ['3.1.1.',  '3.1.2.',  'irmão em profundidade 3'],
      ['3.2.1.',  '3.2.2.',  'irmão em profundidade 3'],
      ['3.2.10.', '3.2.11.', 'irmão de dois dígitos em profundidade 3'],
      ['12.7.1.', '12.7.2.', 'irmão em profundidade 3 (seção alta)'],
      ['3.1.6.',  '3.2.1.',  'novo bloco em profundidade 3'],
      ['3.2.11.', '3.3.',    'subida de nível após subitens'],
      ['17.2.3.', '17.3.',   'subida de nível em seção alta'],
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
      // Profundidade >= 3 — retrocessos e formas implausíveis
      ['3.1.2.',  '3.1.1.',  'retrocesso de irmão em profundidade 3'],
      ['3.2.5.',  '3.1.9.',  'retrocesso de bloco em profundidade 3'],
      ['10.2.',   '10.2.1.1.', 'descida de dois níveis de uma vez'],
      ['17.',     '2024.',   'salto absurdo de nível único (ano em prosa)'],
      ['3.',      '3.',      'mesmo número não é transição'],
      ['10.2.',   '10.2.',   'mesmo número multi-nível não é transição'],
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
// splitLegalDocument — termo de contrato administrativo (regressao integral)
//
// Reproduz em miniatura a estrutura do CONTRATO_N_06_2024-REITORIA que expos
// os tres defeitos do splitter:
//   1. clausulas iniciadas por "O"/"A" e titulos em caixa alta nao viravam
//      fronteira (looksLikeHeading) — a clausula de vigencia era absorvida
//      pelo chunk da tabela de precos;
//   2. "anexo do Edital." em prosa disparava RE_ANEXO/i e rotulava todo o
//      resto do documento com o anexo fantasma "ANEXO DO";
//   3. subitens de profundidade 3 (3.1.1, 3.1.2) nao geravam grupos proprios.
// ---------------------------------------------------------------------------
describe('splitLegalDocument — termo de contrato administrativo', () => {
  const contrato = [
    'INSTITUTO FEDERAL DE EXEMPLO',
    'TERMO DE CONTRATO DE PRESTAÇÃO DE SERVIÇOS QUE FAZEM ENTRE SI A UNIÃO E A EMPRESA EXEMPLO LTDA.',
    '1 .  CLÁUSULA PRIMEIRA – OBJETO',
    '1.1 .O  objeto  do  presente  instrumento  é  a  contratação  de  serviços  continuados de limpeza.',
    '2 .  CLÁUSULA SEGUNDA – FUNDAMENTO LEGAL',
    '2.1. A presente contratação fundamenta-se no art. 2º, da Lei nº 8.666/93 e demais normas aplicáveis.',
    '3.         CLÁUSULA TERCEIRA – VIGÊNCIA',
    '3.1. O prazo de vigência deste Termo de Contrato é de 24 (vinte e quatro) meses, podendo ser prorrogado até o limite de 60 (sessenta) meses.',
    '3.1.1. formalmente demonstrado que a forma de prestação dos serviços tem natureza continuada;',
    '3.1.2. Seja juntado relatório que discorra sobre a execução do contrato durante toda a vigência.',
    '8.1. Será exigida a prestação de garantia na presente contratação, conforme regras do Termo de Referência,',
    'anexo do Edital.',
    '11. CLÁUSULA DÉCIMA PRIMEIRA – SANÇÕES ADMINISTRATIVAS',
    '11.1. As sanções relacionadas à execução do contrato são aquelas previstas no Termo de Referência.',
  ].join('\n');

  const chunks = splitLegalDocument(contrato);
  const byN2 = (n2: string) => chunks.find(c => c.metadata.n2_header === n2);

  test('a clausula de vigencia (3.1) vira grupo proprio com o prazo de prorrogacao', () => {
    const chunk31 = byN2('3.1.');
    expect(chunk31).toBeDefined();
    expect(chunk31!.content).toContain('60 (sessenta) meses');
    // e NAO carrega conteudo de outras clausulas
    expect(chunk31!.content).not.toContain('CLÁUSULA SEGUNDA');
    expect(chunk31!.content).not.toContain('objeto');
  });

  test('titulos de clausula em caixa alta viram grupos proprios', () => {
    expect(byN2('3.')).toBeDefined();
    expect(byN2('3.')!.content).toContain('CLÁUSULA TERCEIRA');
    expect(byN2('11.')).toBeDefined();
    expect(byN2('11.')!.content).toContain('SANÇÕES ADMINISTRATIVAS');
  });

  test('prefixo "N ." com espaco de PDF vira grupo com header canonico', () => {
    expect(byN2('2.')).toBeDefined();
    expect(byN2('2.')!.content).toContain('FUNDAMENTO LEGAL');
  });

  test('subitens de profundidade 3 viram grupos separados', () => {
    expect(byN2('3.1.1.')).toBeDefined();
    expect(byN2('3.1.2.')).toBeDefined();
    expect(byN2('3.1.1.')!.content).toContain('natureza continuada');
    expect(byN2('3.1.2.')!.content).toContain('relatório');
  });

  test('"anexo do Edital." em prosa NAO vira transicao de anexo', () => {
    // nenhum grupo rotulado com anexo fantasma
    for (const chunk of chunks) {
      expect(chunk.metadata.n1_header).toBe('');
    }
    // a frase permanece como conteudo do grupo em que ocorre (8.1)
    const chunk81 = byN2('8.1.');
    expect(chunk81).toBeDefined();
    expect(chunk81!.content).toContain('anexo do Edital.');
  });

  test('clausulas iniciadas por "O"/"A" viram grupos proprios', () => {
    expect(byN2('1.1')).toBeDefined();
    expect(byN2('1.1')!.content).toContain('objeto');
    expect(byN2('2.1.')).toBeDefined();
    expect(byN2('2.1.')!.content).toContain('fundamenta-se');
  });
});

// ---------------------------------------------------------------------------
// splitLegalDocument — referencia a anexo em prosa dentro de norma
//
// Na IN 05 real, linhas como "Anexo V-B, ou outro instrumento substituto..."
// (referencia em caixa mista no inicio de linha, artefato de quebra do PDF)
// disparavam RE_ANEXO/i e mudavam o estado para um anexo errado, rotulando os
// itens seguintes com n1_header incorreto.
// ---------------------------------------------------------------------------
describe('splitLegalDocument — referencia a anexo em prosa nao muda o estado', () => {
  test('referencia em caixa mista permanece no anexo corrente', () => {
    const texto = [
      'ANEXO V-A',
      '1. Conteúdo do primeiro item do anexo V-A com texto suficiente para o grupo existir.',
      'Anexo V-B, ou outro instrumento substituto para aferição da qualidade.',
      '2. Segundo item ainda dentro do anexo V-A, com texto suficiente para o grupo existir.',
    ].join('\n');

    const chunks = splitLegalDocument(texto);

    // nenhum grupo rotulado com o anexo referido em prosa
    expect(chunks.some(c => c.metadata.n1_header === 'ANEXO V-B')).toBe(false);
    // os dois itens pertencem ao ANEXO V-A e a referencia vira conteudo do item 1
    const chunk1 = chunks.find(c => c.metadata.n2_header === '1.');
    const chunk2 = chunks.find(c => c.metadata.n2_header === '2.');
    expect(chunk1?.metadata.n1_header).toBe('ANEXO V-A');
    expect(chunk1?.content).toContain('Anexo V-B, ou outro instrumento');
    expect(chunk2?.metadata.n1_header).toBe('ANEXO V-A');
  });

  test('cabecalho genuino em caixa alta continua transicionando', () => {
    const texto = [
      'ANEXO VIII-B',
      '1. Item do anexo VIII-B com texto suficiente para o grupo nao ser descartado.',
      'ANEXO IX',
      '1. Item do anexo IX com texto suficiente para o grupo nao ser descartado.',
    ].join('\n');

    const chunks = splitLegalDocument(texto);
    expect(chunks.some(c => c.metadata.n1_header === 'ANEXO VIII-B')).toBe(true);
    expect(chunks.some(c => c.metadata.n1_header === 'ANEXO IX')).toBe(true);
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
