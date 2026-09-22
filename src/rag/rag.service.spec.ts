import {
  normalizeForSearch,
  findAnchorIndex,
  snapWindowStart,
  snapWindowEnd,
  buildRagPrompt,
  buildSourceLabel,
  normalizeDocumentTitle,
  SECTION_HEADER_FALLBACK,
  buildChunkEmbedText,
  stripInvisibleArtifacts,
  dehyphenateAttested,
} from './rag.service';
import { Document } from '@langchain/core/documents';
import {
  CHILD_CHUNK_SIZE,
  CHILD_CHUNK_OVERLAP,
  MAX_MAJOR_JUMP,
  MAX_MINOR_COMPONENT,
} from './legal-document-splitter';

// ---------------------------------------------------------------------------
// normalizeForSearch
// ---------------------------------------------------------------------------
describe('normalizeForSearch', () => {
  test('quebra de linha entre palavras vira espaco unico', () => {
    expect(normalizeForSearch('Fiscalizacao\nmensal')).toBe('Fiscalizacao mensal');
  });

  test('multiplos espacos viram espaco unico', () => {
    expect(normalizeForSearch('Fiscalizacao     mensal')).toBe('Fiscalizacao mensal');
  });

  test('tab vira espaco unico', () => {
    expect(normalizeForSearch('Fiscalizacao\tmensal')).toBe('Fiscalizacao mensal');
  });

  test('preserva acentos: Fiscalização\\nmensal -> Fiscalização mensal', () => {
    expect(normalizeForSearch('Fiscalização\nmensal')).toBe('Fiscalização mensal');
  });

  test('preserva acentos: Fiscalização     mensal -> Fiscalização mensal', () => {
    expect(normalizeForSearch('Fiscalização     mensal')).toBe('Fiscalização mensal');
  });

  test('preserva acentos: Fiscalização\\tmensal -> Fiscalização mensal', () => {
    expect(normalizeForSearch('Fiscalização\tmensal')).toBe('Fiscalização mensal');
  });

  test('preserva pontuacao e acentos: Art. 66-A da Lei no 8.666, de 1993.', () => {
    const input    = 'Art. 66-A da Lei nº 8.666, de 1993.';
    const expected = 'Art. 66-A da Lei nº 8.666, de 1993.';
    expect(normalizeForSearch(input)).toBe(expected);
  });

  test('Art. 66-A da Lei no 8.666 com whitespace extra normaliza sem perder conteudo', () => {
    const input    = 'Art. 66-A  da  Lei\nnº 8.666,\tde 1993.';
    const expected = 'Art. 66-A da Lei nº 8.666, de 1993.';
    expect(normalizeForSearch(input)).toBe(expected);
  });

  test('remove espacos nas extremidades', () => {
    expect(normalizeForSearch('  texto  ')).toBe('texto');
  });

  test('combinacao: quebra de linha + multiplos espacos', () => {
    expect(normalizeForSearch('Fiscalização\n   mensal')).toBe('Fiscalização mensal');
  });

  test('string vazia retorna string vazia', () => {
    expect(normalizeForSearch('')).toBe('');
  });

  test('texto sem whitespace extra nao e alterado', () => {
    expect(normalizeForSearch('texto normal')).toBe('texto normal');
  });

  test('multiplas quebras de linha consecutivas viram espaco unico', () => {
    expect(normalizeForSearch('linha1\n\n\nlinha2')).toBe('linha1 linha2');
  });
});

// ---------------------------------------------------------------------------
// Sliding window — fallback progressivo do anchor
//
// Replica a logica de retrieveParentContexts sem depender de infraestrutura.
// Deve ser mantida em sincronia com a implementacao em rag.service.ts.
// ---------------------------------------------------------------------------
function findAnchorWithFallback(
  parentContent: string,
  childContent: string,
  anchorSizes: readonly number[],
): { startIndex: number; anchorLen: number } {
  const normalizedParent = normalizeForSearch(parentContent);
  const normalizedChild  = normalizeForSearch(childContent);

  for (const size of anchorSizes) {
    const anchor = normalizedChild.slice(0, size).trim();
    if (!anchor) continue;
    const idx = normalizedParent.indexOf(anchor);
    if (idx !== -1) {
      return { startIndex: idx, anchorLen: size };
    }
  }
  return { startIndex: -1, anchorLen: 0 };
}

// Mesmos tamanhos usados em rag.service.ts — sem hardcode
const ANCHOR_SIZES = [50, 40, 30, 20] as const;

describe('sliding window — fallback progressivo do anchor', () => {
  // Parent com texto suficiente para todos os testes de posicionamento
  const PARENT_PREFIX = 'Conteudo inicial do documento normativo com texto suficiente para teste. ';

  test('anchor encontrado com 50 caracteres (primeira tentativa)', () => {
    // child tem exatamente 60+ chars que existem no parent
    const sharedText   = '10.2. Fiscalizacao mensal dos servicos contratados conforme.';
    const parentContent = PARENT_PREFIX + sharedText + ' Texto adicional do parent.';
    const childContent  = sharedText + ' Texto adicional do child que nao importa.';

    const norm50 = normalizeForSearch(childContent).slice(0, 50);
    expect(normalizeForSearch(parentContent)).toContain(norm50);

    const { startIndex, anchorLen } = findAnchorWithFallback(parentContent, childContent, ANCHOR_SIZES);
    expect(startIndex).toBeGreaterThan(-1);
    expect(anchorLen).toBe(50);
  });

  test('anchor encontrado apenas com 40 caracteres', () => {
    // Constroi um anchor de exatamente 40 chars que existe no parent.
    // O child tem esses 40 chars seguidos de 10+ chars que NAO existem no parent,
    // garantindo que o slice de 50 nao seja encontrado mas o de 40 sim.
    const anchor40 = 'Quarenta caracteres exatos aqui presentes'; // 41 chars — slice abaixo
    const a40 = anchor40.slice(0, 40); // exatamente 40
    const suffix50only = 'ZZZZZZZZZZZ'; // 11 chars — faz com que slice(0,50) = a40 + 'ZZZZZZZZZZZ'
    const parentContent = PARENT_PREFIX + a40 + ' texto do parent que diverge completamente.';
    const childContent  = a40 + suffix50only + ' mais texto do child que nao existe no parent.';

    const norm = normalizeForSearch(childContent);
    // slice(0,50) = a40 + 'ZZZZZZZZZ' (10 chars) — nao esta no parent
    expect(normalizeForSearch(parentContent)).not.toContain(norm.slice(0, 50));
    // slice(0,40) = a40 — esta no parent
    expect(normalizeForSearch(parentContent)).toContain(norm.slice(0, 40));

    const { startIndex, anchorLen } = findAnchorWithFallback(parentContent, childContent, ANCHOR_SIZES);
    expect(startIndex).toBeGreaterThan(-1);
    expect(anchorLen).toBe(40);
  });

  test('anchor encontrado apenas com 30 caracteres', () => {
    const anchor30chars = 'Trinta chars compartilhados ok.'.slice(0, 30);
    const parentContent = PARENT_PREFIX + anchor30chars + ' DIVERGE_PARENT_40 texto extra longo aqui presente.';
    const childContent  = anchor30chars + ' DIVERGE_CHILD_40 texto completamente diferente e longo aqui.';

    const norm = normalizeForSearch(childContent);
    expect(normalizeForSearch(parentContent)).not.toContain(norm.slice(0, 50));
    expect(normalizeForSearch(parentContent)).not.toContain(norm.slice(0, 40));
    expect(normalizeForSearch(parentContent)).toContain(norm.slice(0, 30));

    const { startIndex, anchorLen } = findAnchorWithFallback(parentContent, childContent, ANCHOR_SIZES);
    expect(startIndex).toBeGreaterThan(-1);
    expect(anchorLen).toBe(30);
  });

  test('anchor encontrado apenas com 20 caracteres', () => {
    const anchor20chars = 'Vinte chars ok aqui.'.slice(0, 20);
    const parentContent = PARENT_PREFIX + anchor20chars + ' DIVERGE_PARENT_30 texto extra longo aqui presente no documento.';
    const childContent  = anchor20chars + ' DIVERGE_CHILD_30 texto completamente diferente e muito longo aqui.';

    const norm = normalizeForSearch(childContent);
    expect(normalizeForSearch(parentContent)).not.toContain(norm.slice(0, 50));
    expect(normalizeForSearch(parentContent)).not.toContain(norm.slice(0, 40));
    expect(normalizeForSearch(parentContent)).not.toContain(norm.slice(0, 30));
    expect(normalizeForSearch(parentContent)).toContain(norm.slice(0, 20));

    const { startIndex, anchorLen } = findAnchorWithFallback(parentContent, childContent, ANCHOR_SIZES);
    expect(startIndex).toBeGreaterThan(-1);
    expect(anchorLen).toBe(20);
  });

  test('anchor inexistente em qualquer tamanho -> startIndex -1 (usa parent inteiro)', () => {
    const parentContent = 'Conteudo completamente diferente do child.';
    const childContent  = 'XYZXYZXYZ conteudo que nao existe no parent de forma alguma aqui.';
    const { startIndex, anchorLen } = findAnchorWithFallback(parentContent, childContent, ANCHOR_SIZES);
    expect(startIndex).toBe(-1);
    expect(anchorLen).toBe(0);
  });

  test('anchor encontrado apos normalizacao de whitespace (quebra de linha no parent)', () => {
    // parent tem quebra de linha onde child tem espaco — normalizeForSearch resolve
    const parentContent = 'Fiscalizacao\nmensal dos servicos contratados conforme edital aqui.';
    const childContent  = 'Fiscalizacao mensal dos servicos contratados conforme edital aqui. mais texto.';
    const { startIndex } = findAnchorWithFallback(parentContent, childContent, ANCHOR_SIZES);
    expect(startIndex).toBeGreaterThan(-1);
  });

  test('anchor encontrado apos normalizacao de whitespace (multiplos espacos no parent)', () => {
    const parentContent = 'Fiscalizacao     mensal dos servicos contratados.';
    const childContent  = 'Fiscalizacao mensal dos servicos contratados. mais texto do child.';
    const { startIndex } = findAnchorWithFallback(parentContent, childContent, ANCHOR_SIZES);
    expect(startIndex).toBeGreaterThan(-1);
  });
});

// ---------------------------------------------------------------------------
// Constantes exportadas — sem valores hardcoded nos testes
// ---------------------------------------------------------------------------
describe('constantes exportadas do splitter', () => {
  test('CHILD_CHUNK_SIZE e um numero positivo', () => {
    expect(typeof CHILD_CHUNK_SIZE).toBe('number');
    expect(CHILD_CHUNK_SIZE).toBeGreaterThan(0);
  });

  test('CHILD_CHUNK_OVERLAP e menor que CHILD_CHUNK_SIZE e positivo', () => {
    expect(CHILD_CHUNK_OVERLAP).toBeLessThan(CHILD_CHUNK_SIZE);
    expect(CHILD_CHUNK_OVERLAP).toBeGreaterThan(0);
  });

  test('MAX_MAJOR_JUMP e um numero positivo', () => {
    expect(typeof MAX_MAJOR_JUMP).toBe('number');
    expect(MAX_MAJOR_JUMP).toBeGreaterThan(0);
  });

  test('MAX_MINOR_COMPONENT >= 99 (garante rejeicao de numeros de lei)', () => {
    expect(MAX_MINOR_COMPONENT).toBeGreaterThanOrEqual(99);
  });
});

// ---------------------------------------------------------------------------
// I2 — cleanExtractedText: preservacao de titulos ALL-CAPS normativos
// Replica minima da logica de cleanExtractedText para teste isolado.
// Deve ser mantida em sincronia com a implementacao em rag.service.ts.
// ---------------------------------------------------------------------------
function simulateCleanAllCapsLine(line: string): string {
  const RE_PDF_NOISE_ALLCAPS = [
    /^(MINISTÉRIO|SECRETARIA|DIRETORIA|DEPARTAMENTO|COORDENAÇÃO|SUBSECRETARIA|SUPERINTENDÊNCIA|GERENCIA|ASSESSORIA)\b/i,
    /^[A-Z]{2,5}$/,
    /^(I{1,3}|IV|VI{0,3}|IX|X{1,3}|XI{1,3}|XIV|XV)$/,
  ];

  const isStructuralHeading = (l: string) =>
    /^ANEXO\s+[A-Z0-9]/i.test(l)           ||
    /^CAP[ÍI]TULO\s+[IVXLCDM]/i.test(l)    ||
    /^Se[çc][ãa]o\s+[IVXLCDM]/i.test(l)    ||
    /^Subse[çc][ãa]o\s+[IVXLCDM]/i.test(l) ||
    /^T[ÍI]TULO\s+[IVXLCDM]/i.test(l)      ||
    /^LIVRO\s+[IVXLCDM]/i.test(l);

  const isAllCaps =
    /^[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÇ\s\/\-\.]{5,80}$/.test(line) &&
    !/[a-záéíóúâêîôûãõç]/.test(line);

  if (!isAllCaps) return line;
  if (isStructuralHeading(line)) return line;
  if (RE_PDF_NOISE_ALLCAPS.some(re => re.test(line))) return '';
  return line;
}

describe('cleanExtractedText — I2: preservacao de titulos ALL-CAPS normativos', () => {
  describe('deve PRESERVAR titulos normativos ALL-CAPS', () => {
    const cases: [string, string][] = [
      ['DAS OBRIGAÇÕES DO CONTRATADO', 'titulo de secao normativa'],
      ['DO PAGAMENTO',                 'titulo de secao normativa curto'],
      ['OBJETO',                       'titulo de secao normativa minimo'],
      ['DA EXECUÇÃO CONTRATUAL',       'titulo de secao normativa'],
      ['DA GARANTIA',                  'titulo de secao normativa'],
      ['DOS PRAZOS',                   'titulo de secao normativa'],
      ['DAS PENALIDADES',              'titulo de secao normativa'],
      ['DA FISCALIZAÇÃO',              'titulo de secao normativa'],
      ['DAS DISPOSIÇÕES GERAIS',       'titulo de secao normativa'],
      ['DO REAJUSTE',                  'titulo de secao normativa'],
    ];
    test.each(cases)('"%s" (%s)', (line) => {
      expect(simulateCleanAllCapsLine(line)).toBe(line);
    });
  });

  describe('deve REMOVER ruido de PDF ALL-CAPS', () => {
    const cases: [string, string][] = [
      ['MINISTÉRIO DA FAZENDA',  'cabecalho institucional'],
      ['SECRETARIA DE ESTADO',   'cabecalho institucional'],
      ['DIRETORIA DE CONTRATOS', 'cabecalho institucional'],
      ['DEPARTAMENTO JURÍDICO',  'cabecalho institucional'],
    ];
    test.each(cases)('"%s" (%s)', (line) => {
      expect(simulateCleanAllCapsLine(line)).toBe('');
    });
  });

  describe('deve PRESERVAR cabecalhos estruturais (maquina de estados)', () => {
    const cases: [string, string][] = [
      ['ANEXO VIII-B', 'ANEXO'],
      ['CAPÍTULO III', 'CAPITULO'],
    ];
    test.each(cases)('"%s" (%s)', (line) => {
      expect(simulateCleanAllCapsLine(line)).toBe(line);
    });
  });

  describe('deve PRESERVAR linhas com letras minusculas', () => {
    const cases: [string, string][] = [
      ['Das obrigações do contratado', 'misto'],
      ['Fiscalização mensal',          'misto'],
    ];
    test.each(cases)('"%s" (%s)', (line) => {
      expect(simulateCleanAllCapsLine(line)).toBe(line);
    });
  });
});

// ---------------------------------------------------------------------------
// I3 — alinhamento de sourceDocIds com sources
// ---------------------------------------------------------------------------
describe('I3 — sourceDocIds alinhado com sources (invariante)', () => {
  function buildSourcesFromParents(
    parents: Array<{ metadata: { documentId: string; title: string } }>,
  ) {
    const sourceDocIds = [
      ...new Set(parents.map(p => p.metadata.documentId).filter(Boolean)),
    ];
    const sourcesMap = new Map<string, { id: string; title: string }>();
    for (const parent of parents) {
      const id    = parent.metadata.documentId;
      const title = parent.metadata.title;
      if (id && !sourcesMap.has(id)) sourcesMap.set(id, { id, title });
    }
    return { sourceDocIds, sources: Array.from(sourcesMap.values()) };
  }

  test('sourceDocIds e sources tem exatamente os mesmos document IDs', () => {
    const parents = [
      { metadata: { documentId: 'doc-1', title: 'Edital A' } },
      { metadata: { documentId: 'doc-2', title: 'Edital B' } },
      { metadata: { documentId: 'doc-1', title: 'Edital A' } },
    ];
    const { sourceDocIds, sources } = buildSourcesFromParents(parents);
    expect(sourceDocIds).toHaveLength(2);
    expect(sources).toHaveLength(2);
    expect([...sourceDocIds].sort()).toEqual(sources.map(s => s.id).sort());
  });

  test('parent filtrado nao aparece em sourceDocIds', () => {
    const parents = [{ metadata: { documentId: 'doc-1', title: 'Edital A' } }];
    const { sourceDocIds, sources } = buildSourcesFromParents(parents);
    expect(sourceDocIds).toEqual(['doc-1']);
    expect(sources.map(s => s.id)).toEqual(['doc-1']);
    expect(sourceDocIds).not.toContain('doc-2');
  });

  test('lista vazia resulta em colecoes vazias', () => {
    const { sourceDocIds, sources } = buildSourcesFromParents([]);
    expect(sourceDocIds).toHaveLength(0);
    expect(sources).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// findAnchorIndex — implementacao REAL usada pela janela deslizante (Fase 1).
// Substitui a simulacao findAnchorWithFallback acima: anchor progressivo
// (50 -> 40 -> 30 -> 20) com tolerancia a whitespace via regex.
// ---------------------------------------------------------------------------
describe('findAnchorIndex (implementacao real da janela deslizante)', () => {
  test('child substring exata do parent -> encontra o indice correto', () => {
    const parent = 'Preambulo do item. 10.2. Fiscalizacao mensal dos servicos contratados conforme o edital vigente.';
    const child  = '10.2. Fiscalizacao mensal dos servicos contratados conforme';
    expect(findAnchorIndex(parent, child)).toBe(parent.indexOf('10.2.'));
  });

  test('tolera quebra de linha no parent onde o child tem espaco', () => {
    const parent = 'Fiscalizacao\nmensal dos servicos contratados conforme edital aqui presente.';
    const child  = 'Fiscalizacao mensal dos servicos contratados conforme edital aqui presente.';
    expect(findAnchorIndex(parent, child)).toBe(0);
  });

  test('tolera multiplos espacos no parent', () => {
    const parent = 'Fiscalizacao     mensal dos servicos contratados no periodo.';
    const child  = 'Fiscalizacao mensal dos servicos contratados no periodo.';
    expect(findAnchorIndex(parent, child)).toBe(0);
  });

  test('anchor de 50 nao casa mas anchor menor casa (fallback progressivo)', () => {
    const head20 = 'Fiscalizacao mensal ';
    const parent = `${head20}restante completamente distinto do child aqui.`;
    const child  = `${head20}continuacao que nao esta presente no parent de forma alguma.`;
    expect(findAnchorIndex(parent, child)).toBe(0);
  });

  test('anchor inexistente em qualquer tamanho -> -1 (parent entra integro)', () => {
    const parent = 'Conteudo completamente diferente do child.';
    const child  = 'XYZXYZXYZ conteudo que nao existe no parent de forma alguma.';
    expect(findAnchorIndex(parent, child)).toBe(-1);
  });

  test('caracteres especiais de regex no child nao quebram a busca', () => {
    const parent = 'Item (a) — valor de R$ 1.000,00 [reajustado] conforme indice oficial.';
    const child  = '(a) — valor de R$ 1.000,00 [reajustado] conforme indice';
    expect(findAnchorIndex(parent, child)).toBe(parent.indexOf('(a)'));
  });
});

// ---------------------------------------------------------------------------
// snapWindowStart / snapWindowEnd — ajuste das bordas da janela para
// fronteiras de sentenca/linha (evita cortar dispositivos no meio da frase)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Janela deslizante multi-ancora — regressao do Art. 75 da Lei 14.133.
// Quando o retriever encontra VARIAS regioes do mesmo dispositivo, a janela
// precisa cobrir da primeira a ultima; ancorar so no melhor child truncava o
// artigo e derrubava os paragrafos que a pergunta exigia.
// Replica a logica de retrieveParentContexts para teste isolado.
// ---------------------------------------------------------------------------
describe('janela deslizante — cobertura de multiplos trechos recuperados', () => {
  const SW_BEFORE = 1200;
  const SW_AFTER = 2400;

  function janela(parent: string, children: string[]): string {
    let first = Infinity;
    let lastEnd = -Infinity;
    for (const child of children) {
      const idx = findAnchorIndex(parent, child);
      if (idx === -1) continue;
      first = Math.min(first, idx);
      lastEnd = Math.max(lastEnd, idx + child.length);
    }
    if (!Number.isFinite(first)) return parent;
    let start = Math.max(0, first - SW_BEFORE);
    let end = Math.min(parent.length, lastEnd + SW_AFTER);
    start = snapWindowStart(parent, start);
    end = snapWindowEnd(parent, end);
    return parent.substring(start, end);
  }

  // Artigo longo: cabeca com o limite, corpo extenso e cauda com o paragrafo.
  // Cada sentenca do meio e unica — texto repetido faria o anchor casar sempre
  // na primeira ocorrencia e mediria o fixture, nao a janela.
  const CABECA = 'Art. 75. E dispensavel a licitacao: I - valores inferiores a R$ 100.000,00 (cem mil reais). ';
  const MEIO = Array.from(
    { length: 60 },
    (_, i) => `Inciso ${i + 1} do artigo, com redacao propria e distinta das demais para ancoragem.`,
  ).join(' ') + ' ';
  const CAUDA = 'Paragrafo 2o Os valores serao duplicados para consorcios publicos.';
  const PARENT = CABECA + MEIO + CAUDA;

  // findAnchorIndex casa a PRIMEIRA ocorrencia do anchor; os trechos abaixo
  // comecam em texto inequivoco para que a ancoragem seja deterministica.
  const childCabeca = PARENT.slice(0, 120);
  const childCauda = PARENT.slice(PARENT.indexOf('Paragrafo 2o'));

  test('dois trechos distantes: a janela cobre do primeiro ao ultimo', () => {
    const out = janela(PARENT, [childCabeca, childCauda]);
    expect(out).toContain('100.000,00');
    expect(out).toContain('duplicados para consorcios');
  });

  test('ancorar apenas no primeiro trecho perderia a cauda (comportamento antigo)', () => {
    const soPrimeiro = janela(PARENT, [childCabeca]);
    expect(soPrimeiro).toContain('100.000,00');
    expect(soPrimeiro).not.toContain('duplicados para consorcios');
  });

  test('a ordem dos trechos nao altera a janela resultante', () => {
    expect(janela(PARENT, [childCauda, childCabeca])).toBe(
      janela(PARENT, [childCabeca, childCauda]),
    );
  });

  test('um unico trecho continua produzindo a janela centrada nele', () => {
    const meio = PARENT.slice(3000, 3120);
    const out = janela(PARENT, [meio]);
    expect(out.length).toBeLessThan(PARENT.length);
    expect(out).toContain(meio.slice(0, 40));
  });

  test('trechos sem anchor localizavel nao quebram a janela', () => {
    const out = janela(PARENT, ['XYZ conteudo inexistente no parent aqui']);
    expect(out).toBe(PARENT);
  });
});

describe('snapWindowStart / snapWindowEnd', () => {
  test('start recua para o inicio da sentenca corrente', () => {
    const content = 'Primeira sentenca completa. Segunda sentenca que sera cortada no meio.';
    const mid = content.indexOf('que sera');
    expect(snapWindowStart(content, mid)).toBe(content.indexOf('Segunda'));
  });

  test('start em 0 permanece 0', () => {
    expect(snapWindowStart('qualquer texto', 0)).toBe(0);
  });

  test('sem fronteira no alcance de busca: mantem o start original', () => {
    const content = 'a'.repeat(400) + ' fim';
    expect(snapWindowStart(content, 350)).toBe(350);
  });

  test('start apos quebra de linha usa a quebra como fronteira', () => {
    const content = 'linha um\nlinha dois com mais conteudo aqui';
    const mid = content.indexOf('com mais');
    expect(snapWindowStart(content, mid)).toBe(content.indexOf('linha dois'));
  });

  test('end avanca ate o fim da sentenca corrente (inclui o ponto)', () => {
    const content = 'Primeira parte da sentenca que continua. Proxima sentenca aqui.';
    const end = snapWindowEnd(content, content.indexOf('continua'));
    expect(content.slice(0, end).endsWith('continua.')).toBe(true);
  });

  test('end no fim do conteudo permanece inalterado', () => {
    const content = 'Texto curto.';
    expect(snapWindowEnd(content, content.length)).toBe(content.length);
  });

  test('quebra de linha antes do ponto: para na quebra', () => {
    const content = 'linha um\nlinha dois. resto';
    expect(snapWindowEnd(content, 0)).toBe(content.indexOf('\n'));
  });
});

// ---------------------------------------------------------------------------
// buildSourceLabel / buildRagPrompt — citacoes estruturais e regras de
// fidelidade (fase de geracao). Testa invariantes estruturais do prompt,
// nao a redacao exata das instrucoes.
// ---------------------------------------------------------------------------
function makeDoc(metadata: Record<string, unknown>, pageContent = 'Conteudo do item.'): Document {
  return new Document({ pageContent, metadata });
}

describe('buildChunkEmbedText', () => {
  test('prepende contexto estrutural ao conteudo cru, separado por linha em branco', () => {
    const out = buildChunkEmbedText('a contratada devera entregar as certidoes...', {
      title: 'IN05',
      sectionHeading: 'ANEXO VIII-B Diretrizes para a fiscalizacao dos contratos',
      item: '2.1.',
    });
    expect(out).toBe(
      'IN05 — ANEXO VIII-B Diretrizes para a fiscalizacao dos contratos — Item 2.1.\n\na contratada devera entregar as certidoes...',
    );
    // o tema da secao ("fiscalizacao") passa a fazer parte do texto vetorizado
    expect(out).toContain('fiscalizacao');
  });

  test('o conteudo cru permanece integro apos o cabecalho (armazenamento inalterado)', () => {
    const raw = '10.2. Antes do pagamento, o fiscal deve consultar o SICAF.';
    const out = buildChunkEmbedText(raw, { title: 'IN05', sectionHeading: 'ANEXO VIII-B', item: '10.2.' });
    expect(out.endsWith(raw)).toBe(true);
  });

  test('sem contexto disponivel, retorna o conteudo cru sem prefixo', () => {
    expect(buildChunkEmbedText('texto cru', {})).toBe('texto cru');
  });
});

describe('normalizeDocumentTitle', () => {
  test('remove segmento repetido de titulo exportado (artefato de upload)', () => {
    expect(
      normalizeDocumentTitle(
        'LEI Nº 14.133, DE 1º DE ABRIL DE 2021 - LEI Nº 14.133, DE 1º DE ABRIL DE 2021 - DOU - Imprensa Nacional',
      ),
    ).toBe('LEI Nº 14.133, DE 1º DE ABRIL DE 2021 - DOU - Imprensa Nacional');
  });

  test('deduplica ignorando acento e caixa', () => {
    expect(normalizeDocumentTitle('Instrucao Normativa 5 - INSTRUÇÃO NORMATIVA 5 - DOU')).toBe(
      'Instrucao Normativa 5 - DOU',
    );
  });

  test('titulo sem separador passa inalterado', () => {
    expect(normalizeDocumentTitle('CONTRATO_N_06_2024-REITORIA')).toBe('CONTRATO_N_06_2024-REITORIA');
  });

  test('titulo com segmentos distintos e preservado por completo', () => {
    expect(normalizeDocumentTitle('INSTRUÇÃO NORMATIVA Nº 5, DE 26 DE MAIO DE 2017 - Imprensa Nacional')).toBe(
      'INSTRUÇÃO NORMATIVA Nº 5, DE 26 DE MAIO DE 2017 - Imprensa Nacional',
    );
  });

  test('preserva a ordem dos segmentos mantidos', () => {
    expect(normalizeDocumentTitle('A - B - A - C')).toBe('A - B - C');
  });
});

describe('buildSourceLabel', () => {
  test('o rotulo usa o titulo normalizado (sem segmento repetido)', () => {
    const doc = makeDoc({
      title: 'LEI Nº 14.133, DE 2021 - LEI Nº 14.133, DE 2021 - DOU',
      n1_header: 'CAPÍTULO I',
      n2_header: 'Art. 95',
      sectionHeader: 'Art. 95',
    });
    expect(buildSourceLabel(doc, 0)).toBe(
      '[Trecho 1] Documento: "LEI Nº 14.133, DE 2021 - DOU" | CAPÍTULO I | Art. 95',
    );
  });

  test('rotulo completo: titulo + anexo + item', () => {
    const doc = makeDoc({
      title: 'Edital de Credenciamento 2026',
      n1_header: 'ANEXO VIII-B',
      n2_header: '10.2.',
      sectionHeader: '10.2.',
    });
    expect(buildSourceLabel(doc, 0)).toBe(
      '[Trecho 1] Documento: "Edital de Credenciamento 2026" | ANEXO VIII-B | Item 10.2.',
    );
  });

  test('artigo nao recebe prefixo "Item"', () => {
    const doc = makeDoc({
      title: 'Portaria 15',
      n1_header: 'CAPÍTULO II',
      n2_header: 'Art. 39',
      sectionHeader: 'Art. 39',
    });
    expect(buildSourceLabel(doc, 2)).toBe(
      '[Trecho 3] Documento: "Portaria 15" | CAPÍTULO II | Art. 39',
    );
  });

  test('sem n2_header usa sectionHeader quando nao repete o n1', () => {
    const doc = makeDoc({
      title: 'Edital X',
      n1_header: 'ANEXO I',
      n2_header: '',
      sectionHeader: 'Disposicoes gerais',
    });
    expect(buildSourceLabel(doc, 0)).toContain('Item Disposicoes gerais');
  });

  test('metadados ausentes nao quebram o rotulo', () => {
    const doc = makeDoc({});
    expect(buildSourceLabel(doc, 0)).toBe('[Trecho 1] Documento: "Documento sem titulo"');
  });

  test('preambulo do documento nao vira "Item Secao" (rotulo sintetico da ingestao)', () => {
    // grupo de preambulo: sem anexo e sem item — o sectionHeader e o fallback
    const doc = makeDoc({
      title: 'CONTRATO_N_06_2024-REITORIA',
      n1_header: '',
      n2_header: '',
      sectionHeader: SECTION_HEADER_FALLBACK,
    });
    expect(buildSourceLabel(doc, 0)).toBe(
      '[Trecho 1] Documento: "CONTRATO_N_06_2024-REITORIA"',
    );
    expect(buildSourceLabel(doc, 0)).not.toContain('Item');
  });

  test('role interno definido no retrieval NAO vaza para o rotulo', () => {
    const principal = makeDoc({
      title: 'Edital A', n1_header: 'ANEXO VIII-B', n2_header: '10.2.', sectionHeader: '10.2.', role: 'PRINCIPAL',
    });
    const apoio = makeDoc({
      title: 'Edital A', n1_header: 'ANEXO VIII-B', n2_header: '9.', sectionHeader: '9.', role: 'COMPLEMENTAR',
    });
    // A prioridade e sinalizada pela ORDEM dos trechos, nunca por vocabulario
    // interno que o modelo poderia ecoar na resposta.
    expect(buildSourceLabel(principal, 0)).toBe(
      '[Trecho 1] Documento: "Edital A" | ANEXO VIII-B | Item 10.2.',
    );
    expect(buildSourceLabel(apoio, 1)).toBe(
      '[Trecho 2] Documento: "Edital A" | ANEXO VIII-B | Item 9.',
    );
  });
});

describe('buildRagPrompt', () => {
  const docs = [
    makeDoc(
      { title: 'Edital A', n1_header: 'ANEXO VIII-B', n2_header: '9.', sectionHeader: '9.' },
      '9. Rotinas gerais de fiscalizacao aqui descritas.',
    ),
    makeDoc(
      { title: 'Edital A', n1_header: 'ANEXO VIII-B', n2_header: '10.2.', sectionHeader: '10.2.' },
      '10.2. Fiscalizacao mensal com suas alineas.',
    ),
  ];
  const prompt = buildRagPrompt(docs, 'Quais sao as rotinas da fiscalizacao mensal?');

  test('cada trecho aparece com rotulo estrutural e conteudo', () => {
    expect(prompt).toContain('[Trecho 1] Documento: "Edital A" | ANEXO VIII-B | Item 9.');
    expect(prompt).toContain('[Trecho 2] Documento: "Edital A" | ANEXO VIII-B | Item 10.2.');
    expect(prompt).toContain('9. Rotinas gerais de fiscalizacao aqui descritas.');
    expect(prompt).toContain('10.2. Fiscalizacao mensal com suas alineas.');
  });

  test('inclui a pergunta do usuario', () => {
    expect(prompt).toContain('Pergunta: Quais sao as rotinas da fiscalizacao mensal?');
  });

  test('mantem a string exata de recusa (comportamento downstream preservado)', () => {
    expect(prompt).toContain('"As informacoes disponiveis nao sao suficientes."');
  });

  test('nao usa mais o rotulo efemero "Documento Ref"', () => {
    expect(prompt).not.toContain('Documento Ref');
  });

  test('nao contem mais instrucoes que induzem resumo/reformatacao', () => {
    expect(prompt).not.toContain('Evite blocos longos');
    expect(prompt).not.toContain('marcadores (•)');
  });

  test('proibe abertura mecanica que descreve o sistema em vez de responder', () => {
    expect(prompt).toContain('A RESPOSTA E ORGANIZADA PELA PERGUNTA, NUNCA PELA NORMA');
    // A frase-modelo da versao anterior (meta-descricao do retrieval) sumiu
    expect(prompt).not.toContain(
      'Foram recuperados os seguintes dispositivos relacionados ao tema solicitado',
    );
    expect(prompt).not.toContain('HIERARQUIA DAS FONTES');
    expect(prompt).not.toContain('MAIS DE UM ITEM NORMATIVO');
  });

  test('classifica a pergunta pelos cinco tipos de resposta esperada', () => {
    expect(prompt).toContain('IDENTIFIQUE O TIPO DE RESPOSTA QUE A PERGUNTA PEDE');
    expect(prompt).toContain('a) DECISAO');
    expect(prompt).toContain('b) QUANTIDADE');
    expect(prompt).toContain('c) IDENTIDADE');
    expect(prompt).toContain('d) CONJUNTO ou PROCEDIMENTO');
    expect(prompt).toContain('e) REPRODUCAO');
    // a classificacao e pelo tipo de informacao, nunca pelas palavras da pergunta
    expect(prompt).toContain('Nao classifique a pergunta pelas palavras com que ela comeca');
    expect(prompt).toContain('nao resuma, nao reorganize, nao omita e nao acrescente nada');
    expect(prompt).toContain('nao copie secoes inteiras da norma');
  });

  // -------------------------------------------------------------------------
  // Modo direto — regressao do caso real: "Posso fazer um contrato verbal...?
  // Existe algum limite de valor?" respondia como resumo da norma ("A
  // legislacao permite...") com um bloco por dispositivo, sem dizer "Sim/Nao"
  // nem destacar o limite de R$ 10.000,00 na abertura.
  // -------------------------------------------------------------------------
  describe('resposta pontual (abertura tipada por tipo de pergunta)', () => {
    test('o tipo vem da pergunta, nao do volume recuperado', () => {
      expect(prompt).toContain('decida ANTES de escrever');
      expect(prompt).toContain('O tipo vem do que foi PERGUNTADO, nunca do volume do que foi recuperado');
      expect(prompt).toContain('DESEMPATE com (d)');
      // um contexto grande nao promove pergunta pontual a procedimental
      expect(prompt).toContain('nao transforma uma pergunta de quantidade em pergunta de conjunto');
    });

    test('cada tipo pontual tem a sua forma de abertura', () => {
      expect(prompt).toContain('A PRIMEIRA PALAVRA ja pertence ao tipo de resposta pedido');
      expect(prompt).toContain('DECISAO: abra pela propria decisao');
      expect(prompt).toContain('QUANTIDADE: abra pelo numero com a sua unidade');
      expect(prompt).toContain('IDENTIDADE: abra pela designacao exata, reproduzida como consta no trecho');
      // nada precede a resposta
      expect(prompt).toContain('NADA precede a resposta');
      expect(prompt).toContain('Quem ler apenas a abertura ja sabe o que fazer');
    });

    test('pergunta composta responde todos os tipos na abertura, sem virar procedimental', () => {
      expect(prompt).toContain('PERGUNTA COMPOSTA');
      expect(prompt).toContain('e DECISAO + QUANTIDADE');
      expect(prompt).toContain('Ter duas partes nao transforma a pergunta em (d)');
    });

    test('exige a resposta na abertura, sem preambulo sobre a norma', () => {
      expect(prompt).toContain('a resposta vem na ABERTURA — no maximo na segunda frase');
      // aberturas que descrevem a norma em vez de responder ficam proibidas
      expect(prompt).toContain('A legislacao permite...');
      expect(prompt).toContain('A norma estabelece as diretrizes...');
    });

    // -----------------------------------------------------------------------
    // Linha de entrada: a abertura interativa que situa quem perguntou.
    // O risco que ela reabre e o que as regras de abertura corrigiram um dia —
    // a resposta ficar soterrada. Por isso vem com teto e com teste proprio.
    // -----------------------------------------------------------------------
    test('a abertura tem entrada e resposta, nessa ordem', () => {
      const entrada = prompt.indexOf('a) LINHA DE ENTRADA');
      const resposta = prompt.indexOf('b) A RESPOSTA');
      expect(entrada).toBeGreaterThan(-1);
      expect(entrada).toBeLessThan(resposta);
      // a resposta continua tipada
      expect(prompt).toContain('A PRIMEIRA PALAVRA ja pertence ao tipo de resposta pedido');
    });

    test('a linha de entrada tem teto: uma frase e a resposta ate a segunda', () => {
      expect(prompt).toContain('UMA frase que situa quem perguntou');
      expect(prompt).toContain('E uma frase — nunca duas, nunca um paragrafo');
      expect(prompt).toContain('no maximo na segunda frase do texto');
    });

    test('a linha de entrada tem testes de descarte explicitos', () => {
      expect(prompt).toContain('TRES TESTES, aplicados sempre');
      // o criterio mecanico que separa orientacao de frase de tema
      expect(prompt).toContain('CONTEM UM FATO CONCRETO dos trechos');
      expect(prompt).toContain('A resposta perdeu alguma coisa? Se nao perdeu, era enchimento');
      expect(prompt).toContain('ELA SERVIRIA PARA QUALQUER PERGUNTA');
      expect(prompt).toContain('Na duvida, nao escreva');
    });

    test('a frase de tema e nomeada como o erro mais comum, com exemplos', () => {
      // Foi o que o modelo de fato produziu nas primeiras execucoes: o tema da
      // pergunta repetido em linguagem normativa, sem informar nada.
      expect(prompt).toContain('o mais dificil de enxergar, e a FRASE DE TEMA');
      expect(prompt).toContain('ERRADO (frase de tema)');
      expect(prompt).toContain('CERTO (orienta de fato)');
    });

    test('a personalidade fala por ultimo sobre o tom da entrada', () => {
      // Os exemplos genericos estao em voz neutra; se viessem depois do bloco
      // da persona, dominariam o tom das duas personalidades.
      const neutros = prompt.indexOf('Os exemplos acima estao em voz neutra');
      const persona = prompt.indexOf('Linha de entrada no registro');
      expect(neutros).toBeGreaterThan(-1);
      expect(neutros).toBeLessThan(persona);
    });

    test('a linha de entrada nao afrouxa o grounding', () => {
      expect(prompt).toContain('nomeia o que os trechos mostram, nunca uma suposicao sobre o caso de quem perguntou');
    });

    test('o que a entrada NAO pode ser continua barrado', () => {
      expect(prompt).toContain('fora a linha de entrada, NADA precede a resposta');
      expect(prompt).toContain('nem anuncio do que voce vai fazer');
      expect(prompt).toContain('Quem ler apenas a abertura ja sabe o que fazer');
    });

    test('no modo procedimental a abertura segue a mesma regra da linha de entrada', () => {
      expect(prompt).toContain('Valem aqui a regra e o teto da linha de entrada (5A.1a)');
      expect(prompt).toContain('um fato concreto dos trechos, UMA frase');
    });

    test('define as partes da resposta pontual na ordem abertura -> desenvolvimento -> fundamentacao', () => {
      expect(prompt).toContain('ESTRUTURA DA RESPOSTA PONTUAL');
      const abertura = prompt.indexOf('1) ABERTURA');
      const desenvolvimento = prompt.indexOf('2) DESENVOLVIMENTO');
      const fundamentacao = prompt.indexOf('4) FUNDAMENTACAO');
      expect(abertura).toBeGreaterThan(-1);
      expect(abertura).toBeLessThan(desenvolvimento);
      expect(desenvolvimento).toBeLessThan(fundamentacao);
      expect(prompt).toContain('## Fundamentacao');
    });

    test('proibe enumerar procedimento nao perguntado no modo direto', () => {
      expect(prompt).toContain('NAO enumere requisitos, condicoes de instrucao processual, etapas ou subitens de um procedimento que a pergunta nao pediu');
      // a centralidade e sinal de recuperacao, nunca ordem de cobertura — e o
      // ponto que impedia o modelo de parar de enumerar os subitens do proprio
      // dispositivo que responde
      expect(prompt).toContain('a marcacao de centralidade e um sinal interno de recuperacao, nunca uma ordem de cobertura');
      expect(prompt).toContain('diga que existem em UMA frase');
    });

    test('a fundamentacao cita apenas dispositivos efetivamente usados', () => {
      expect(prompt).toContain('Cite APENAS os dispositivos de onde saiu algum fato efetivamente afirmado na resposta');
      expect(prompt).toContain('os subitens que voce corretamente deixou de enumerar');
    });

    test('o gabarito da referencia usa placeholders, nunca as palavras-modelo literais', () => {
      expect(prompt).toContain('nunca as palavras-modelo "Anexo Y" ou "Documento Z"');
      expect(prompt).toContain('nao prefixe o nome do documento com "Documento"');
    });

    test('escopa explicitamente as regras procedimentais (4, 5B e 6) ao seu tipo', () => {
      expect(prompt).toContain('As regras 4, 5B e 6 valem SOMENTE aqui');
      expect(prompt).toContain('SOMENTE no modo procedimental');
      expect(prompt).toContain('NAO se aplicam a resposta pontual');
    });

    test('secoes opcionais tem limiar explicito e sao tituladas pela duvida do leitor', () => {
      expect(prompt).toContain('SECOES OPCIONAIS');
      // limiar objetivo — evita transformar resposta curta em relatorio
      expect(prompt).toContain('TRES ou mais pontos distintos, ou passar de dois paragrafos');
      expect(prompt).toContain('uma resposta curta com titulos vira um relatorio sobre duas frases');
      expect(prompt).toContain('## Limite');
      expect(prompt).toContain('## Excecao');
      expect(prompt).toContain('## Consequencia');
      // titular pelo dispositivo continua proibido na resposta pontual
      expect(prompt).toContain('NUNCA nomeie o dispositivo, a sua finalidade normativa ou a sua numeracao');
      // e a proibicao de "categorias" do modo procedimental nao vaza para ca
      expect(prompt).toContain('NAO vale aqui: ela e exclusiva do modo procedimental');
      // a abertura nunca fica sob titulo
      expect(prompt).toContain('A abertura (parte 1) nunca fica sob um titulo');
    });

    test('completude passa a ser medida pela pergunta, nao pelo contexto', () => {
      expect(prompt).toContain('A completude e medida pelo que a PERGUNTA pede');
      expect(prompt).toContain('enumerar o procedimento inteiro nao a torna mais completa');
    });

    test('citacao e sensivel ao tipo (Fundamentacao na pontual, sob o titulo na procedimental)', () => {
      expect(prompt).toContain('resposta pontual (decisao, quantidade, identidade): agrupada ao final');
      expect(prompt).toContain('modo procedimental: UMA unica vez por bloco');
    });
  });

  test('sinaliza ordenacao por pertinencia e cita a fonte em linha propria abaixo do titulo', () => {
    expect(prompt).toContain('ordenados por pertinencia');
    expect(prompt).toContain('CITACAO DA FONTE');
    // A origem vive numa linha em negrito sob o titulo, nunca num bloco de
    // metadados e nunca mais entre parenteses no proprio titulo.
    expect(prompt).toContain('linha em negrito imediatamente abaixo do titulo');
    expect(prompt).toContain('**Item X – Anexo Y – Documento Z**');
    expect(prompt).not.toContain('entre parenteses no TITULO');
    expect(prompt).not.toContain('FONTES AO FINAL');
  });

  test('instrui a selecionar dispositivos por processo, nao por tema (recuperacao != resposta)', () => {
    expect(prompt).toContain('PENSE EM PROCESSO, NAO EM DISPOSITIVOS');
    expect(prompt).toContain('universo de CANDIDATOS');
    // eixo de precisao (remover correlato) e de recall (etapa indispensavel)
    expect(prompt).toContain('etapa indispensavel');
    expect(prompt).toContain('COBERTURA COMPLETA DOS DISPOSITIVOS SELECIONADOS');
  });

  // O modo procedimental produzia uma resposta com o formato do INDICE DA
  // NORMA: um bloco por item, titulado pela finalidade do item, com a citacao
  // embaixo. Estes testes travam o que passou a distingui-la de um roteiro de
  // trabalho — sem abrir mao de nenhuma garantia de cobertura.
  describe('modo procedimental — roteiro de trabalho, nao indice da norma', () => {
    test('a abertura orienta o trabalho em vez de anunciar a lista', () => {
      expect(prompt).toContain('ABERTURA (uma frase, no lugar da antiga introducao)');
      expect(prompt).toContain('em quantos momentos ela se divide e quais sao');
      // o exemplo antigo era, ele proprio, a frase de tema que o modelo copiava
      expect(prompt).toContain('ERRADO (sumario / frase de tema)');
      expect(prompt).toContain('A fiscalizacao mensal se divide em tres momentos');
      expect(prompt).not.toContain(
        'Introducao: um unico paragrafo curto resumindo o contexto',
      );
    });

    test('o titulo pode nomear o momento QUANDO a norma o declara', () => {
      expect(prompt).toContain('o MOMENTO do trabalho em que ele incide');
      expect(prompt).toContain('SOMENTE quando o proprio dispositivo declara esse momento');
      expect(prompt).toContain('Titular pelo momento que a NORMA declara nao e interpretacao sua');
    });

    test('categoria inventada continua proibida, e o momento nao pode ser deduzido', () => {
      expect(prompt).toContain('PROIBIDAS continuam as categorias INVENTADAS por voce');
      expect(prompt).toContain('Outras verificacoes');
      expect(prompt).toContain('Se o momento nao estiver escrito no dispositivo, titule pela finalidade — nunca deduza o momento');
      // a proibicao larga (qualquer titulo-fase) saiu: era ela que mantinha a
      // resposta com o formato do indice da norma
      expect(prompt).not.toContain('PROIBIDO transformar dispositivos em fases');
    });

    test('a frase do bloco e traducao para o trabalho, nao recorte da norma', () => {
      expect(prompt).toContain('e uma TRADUCAO, nunca um recorte');
      expect(prompt).toContain('ERRADO (recorte da norma)');
      expect(prompt).toContain('CERTO (traducao)');
      expect(prompt).toContain('o que menos tolera a redacao da norma recolada');
    });

    test('as garantias de cobertura e citacao seguem intactas', () => {
      expect(prompt).toContain('ESTRUTURA E FORMATO');
      expect(prompt).toContain('um dispositivo por bloco');
      expect(prompt).toContain('UM DISPOSITIVO = UM BLOCO (regra inviolavel)');
      expect(prompt).toContain('E PROIBIDO: fundir dois dispositivos num mesmo bloco');
      expect(prompt).toContain('**Item X – Anexo Y – Documento Z**');
      expect(prompt).toContain('COBERTURA COMPLETA');
    });
  });

  test('define o contrato de Markdown da resposta (titulo, referencia, listas e espacamento)', () => {
    expect(prompt).toContain('REGRAS DE MARKDOWN');
    // titulo de nivel 2 e referencia em negrito em linha propria
    expect(prompt).toContain('dois sustenidos seguidos de espaco');
    // marcador de lista obrigatorio: hifen — nunca bullet tipografico
    expect(prompt).toContain('iniciado por hifen e espaco');
    expect(prompt).toContain('NUNCA use "•"');
    // um item por linha, nada de lista em texto corrido
    expect(prompt).toContain('UM item por linha');
    expect(prompt).toContain('nunca uma lista escrita em texto corrido');
    // espacamento entre os elementos do bloco
    expect(prompt).toContain('deixe UMA linha em branco entre');
  });

  test('o template de bloco nao usa mais bullet tipografico nem referencia no titulo', () => {
    // o gabarito antigo ("## N. <Nome> (Item X)" + bullets "•") saiu por completo
    expect(prompt).not.toContain('• <acao 1>');
    expect(prompt).toContain('- <acao 1>;');
    expect(prompt).toContain('## <Nome da atividade / finalidade do dispositivo>');
  });

  test('proibe fusao/absorcao entre dispositivos e conta apenas os selecionados', () => {
    // a unidade de organizacao e o dispositivo, nunca o tema
    expect(prompt).toContain('UM DISPOSITIVO = UM BLOCO');
    expect(prompt).toContain('a afinidade tematica nunca autoriza fusao');
    // so referencia cruzada, nunca absorcao
    expect(prompt).toContain('So e permitida REFERENCIA CRUZADA');
    // contagem escopada aos selecionados: correlatos/apoio nao viram bloco
    expect(prompt).toContain('deve COINCIDIR com esse total de selecionados');
    expect(prompt).toContain('estar no contexto nunca obriga a incluir');
  });

  test('separa contexto em dispositivos centrais e material de apoio pelo role da proveniencia', () => {
    const docs = [
      new Document({ pageContent: 'central 9', metadata: { title: 'IN05', n1_header: 'ANEXO VIII-B', n2_header: '9.', role: 'PRINCIPAL' } }),
      new Document({ pageContent: 'apoio 10.4', metadata: { title: 'IN05', n1_header: 'ANEXO VIII-B', n2_header: '10.4.', role: 'COMPLEMENTAR' } }),
    ];
    const p = buildRagPrompt(docs, 'Quais as rotinas mensais?');

    // o cabecalho de contexto "=== MATERIAL DE APOIO" so aparece quando ha apoio
    expect(p).toContain('=== MATERIAL DE APOIO');
    expect(p).toContain('NAO gere bloco proprio para estes');
    // no bloco de contexto: central antes do cabecalho de apoio, apoio depois
    const apoioHeader = p.indexOf('=== MATERIAL DE APOIO');
    expect(p.indexOf('central 9')).toBeLessThan(apoioHeader);
    expect(apoioHeader).toBeLessThan(p.indexOf('apoio 10.4'));
  });

  test('sem material de apoio, nao insere o cabecalho de contexto de apoio', () => {
    const docs = [
      new Document({ pageContent: 'central A', metadata: { title: 'IN05', n1_header: 'ANEXO I', n2_header: '1.', role: 'PRINCIPAL' } }),
    ];
    // a mencao nas REGRAS pode existir; o cabecalho "===" do contexto, nao
    expect(buildRagPrompt(docs, 'x')).not.toContain('=== MATERIAL DE APOIO');
  });

  test('instrui a sinalizar subitem referido cujo texto nao consta dos trechos', () => {
    expect(prompt).toContain('nao consta dos trechos');
  });

  // -------------------------------------------------------------------------
  // Registro e principio organizador — o que separava a resposta do GeFi
  // ("parecer juridico resumido") de uma resposta que conversa com o usuario.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Sintese x transcricao
  //
  // O prompt sabia dizer o que NAO fazer (68 proibicoes) e nunca dizia que a
  // resposta e escrita pelo modelo. Como copiar satisfaz todas as proibicoes de
  // uma vez, a saida vinha literal. Estes testes travam o contrapeso.
  // -------------------------------------------------------------------------
  describe('a resposta e redigida, nao copiada', () => {
    test('declara que a resposta e escrita pelo modelo, e o trecho e so a fonte', () => {
      expect(prompt).toContain('A RESPOSTA E ESCRITA POR VOCE, NAO COPIADA DA NORMA');
      expect(prompt).toContain('sao a FONTE do que voce afirma, nunca o TEXTO que voce entrega');
    });

    test('delimita as tres situacoes em que a copia literal e devida', () => {
      // Sem uma fronteira explicita, "seja fiel" e lido como "copie".
      expect(prompt).toContain('Reproduza a redacao original em apenas tres situacoes');
      expect(prompt).toContain('numeros, prazos, valores, percentuais, nomes e designacoes');
      expect(prompt).toContain('uma expressao curta cuja redacao exata muda o sentido');
      expect(prompt).toContain('o tipo REPRODUCAO (secao 2e)');
    });

    test('mostra o contraste colagem x sintese fiel com exemplo concreto', () => {
      expect(prompt).toContain('ERRADO (colagem)');
      expect(prompt).toContain('CERTO (sintese fiel)');
      // A confusao a desfazer: reescrever nao e resumir.
      expect(prompt).toContain('Reescrever assim NAO e resumir: resumir e deixar coisa de fora');
    });

    test('cobertura passa a ser de conteudo, nao de redacao', () => {
      expect(prompt).toContain('COBRIR NAO E TRANSCREVER');
      expect(prompt).toContain('um dispositivo com oito alineas vira oito frases suas, nunca oito trechos copiados');
      // As garantias de completude continuam de pe
      expect(prompt).toContain('o fim da lista importa tanto quanto o inicio');
      expect(prompt).toContain('entre outras rotinas');
      // e o mandato de transcricao que as acompanhava saiu
      expect(prompt).not.toContain('apresente-o por inteiro');
      expect(prompt).not.toContain('foi apresentado integralmente');
    });

    test('o bullet procedimental e uma acao na redacao propria', () => {
      expect(prompt).toContain('Cada bullet e UMA acao dita na sua redacao');
      expect(prompt).toContain('nao recole o paragrafo da norma dentro do bullet');
    });

    test('a conferencia final checa colagem antes de tudo', () => {
      expect(prompt).toContain('virou colagem do texto normativo');
      expect(prompt).toContain('reescreva-o dizendo a mesma coisa em frase propria');
      // A excecao continua explicita para nao quebrar o tipo REPRODUCAO
      expect(prompt).toContain('Vale para o tipo REPRODUCAO ao contrario: la a copia e obrigatoria');
    });

    test('o modo REPRODUCAO segue intacto (copia continua sendo o pedido la)', () => {
      expect(prompt).toContain('reproduza o texto literalmente, completo e na ordem original');
      expect(prompt).toContain('nao resuma, nao reorganize, nao omita e nao acrescente nada');
    });
  });

  describe('registro conversacional e inversao do principio organizador', () => {
    test('a persona define a TAREFA (ajudar a decidir), nao o objeto (a norma)', () => {
      expect(prompt).toContain('Voce ajuda um servidor publico a resolver uma duvida concreta');
      expect(prompt).toContain('As normas sao a sua FONTE — nunca o roteiro da sua resposta');
      // a moldura antiga, centrada no objeto, saiu
      expect(prompt).not.toContain('Voce e um assistente especializado em normas');
    });

    test('declara explicitamente o caminho certo e o caminho errado', () => {
      expect(prompt).toContain('Caminho CERTO:  pergunta -> resposta -> explicacao do necessario -> fundamentacao');
      expect(prompt).toContain('Caminho ERRADO: norma -> resumo do artigo -> resposta implicita');
      expect(prompt).toContain('a ordem dos assuntos e a ordem em que a pessoa perguntou');
    });

    test('a secao de LINGUAGEM E REGISTRO define registro institucional impessoal', () => {
      expect(prompt).toContain('LINGUAGEM E REGISTRO (vale em todos os modos)');
      expect(prompt).toContain('Registro INSTITUCIONAL e impessoal');
      expect(prompt).toContain('Nem parecer juridico, nem conversa informal');
      // segunda pessoa proibida — era o que produzia "voce pode..."
      expect(prompt).toContain('NAO se dirija ao leitor na segunda pessoa');
      expect(prompt).toContain('Evite "voce pode", "voce deve"');
      expect(prompt).toContain('A Administracao podera');
      // proibe a narracao da norma no corpo
      expect(prompt).toContain('Fale da ACAO e do seu efeito, nao do texto que a preve');
      expect(prompt).toContain('o dispositivo estabelece');
      // jargao explicado com o proprio trecho — grounding preservado
      expect(prompt).toContain('explique-o na primeira vez com o que o PROPRIO trecho diz');
      expect(prompt).toContain('Se o trecho nao definir o termo, use-o sem inventar definicao');
    });

    test('prefere transicoes curtas a condicionais longas', () => {
      expect(prompt).toContain('Nessa hipotese');
      expect(prompt).toContain('Acima desse limite');
      expect(prompt).toContain('Caso o valor do servico venha a ultrapassar o limite estabelecido');
    });

    test('naturalidade nunca autoriza opiniao nem afrouxar o grounding', () => {
      expect(prompt).toContain('muda o TOM, nunca o conteudo');
      expect(prompt).toContain('em caso de duvida entre soar melhor e ser fiel, escolha SEMPRE ser fiel');
    });

    test('a conferencia final checa abertura tipada, registro e fidelidade', () => {
      expect(prompt).toContain('CONFERENCIA FINAL (todos os modos)');
      expect(prompt).toContain('A resposta chegou ate a SEGUNDA frase');
      expect(prompt).toContain('virou a ordem dos artigos?');
      expect(prompt).toContain('Sobrou "voce" dirigido ao leitor');
      expect(prompt).toContain('sai de algum trecho fornecido?');
      // titulos so quando ganham a leitura
      expect(prompt).toContain('transformaram tres frases num relatorio? Na duvida, remova-os');
    });
  });
});

// ---------------------------------------------------------------------------
// stripInvisibleArtifacts — normalizacao segura de artefatos de PDF.
// Nenhum conteudo visivel e alterado: apenas caracteres invisiveis,
// NBSP e ligaturas tipograficas.
// ---------------------------------------------------------------------------
describe('stripInvisibleArtifacts', () => {
  test('remove soft hyphen invisivel no meio de palavra', () => {
    expect(stripInvisibleArtifacts('fiscali­zacao')).toBe('fiscalizacao');
  });

  test('normaliza NBSP para espaco comum', () => {
    expect(stripInvisibleArtifacts('Art. 39')).toBe('Art. 39');
  });

  test('remove zero-width chars e BOM', () => {
    expect(stripInvisibleArtifacts('a​b‌c‍d﻿e')).toBe('abcde');
  });

  test('expande ligaturas tipograficas de PDF', () => {
    expect(stripInvisibleArtifacts('ﬁscalizacao')).toBe('fiscalizacao');
    expect(stripInvisibleArtifacts('conﬂito')).toBe('conflito');
  });

  test('expande a pseudo-ligadura "Ɵ" (U+019F) de fontes de termo de contrato para "ti"', () => {
    expect(stripInvisibleArtifacts('conƟnuado')).toBe('continuado');
    expect(stripInvisibleArtifacts('garanƟa')).toBe('garantia');
    expect(stripInvisibleArtifacts('serviços conƟnuados com dedicação exclusiva')).toBe(
      'serviços continuados com dedicação exclusiva',
    );
  });

  test('texto limpo passa inalterado', () => {
    const text = '10.2. Fiscalizacao mensal dos servicos.';
    expect(stripInvisibleArtifacts(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// dehyphenateAttested — de-hifenizacao atestada pelo proprio documento:
// so une quando a palavra integra ocorre em outro ponto do texto.
// ---------------------------------------------------------------------------
describe('dehyphenateAttested', () => {
  test('une palavra hifenizada quando a forma integra ocorre no documento', () => {
    const text = 'A fiscalizacao mensal e obrigatoria. A fiscali-\nzacao deve ocorrer todo mes.';
    const out  = dehyphenateAttested(text);
    expect(out).toContain('A fiscalizacao deve ocorrer todo mes.');
    expect(out).not.toContain('fiscali-\nzacao');
  });

  test('preserva composto legitimo quebrado no proprio hifen (sem atestado)', () => {
    const text = 'Nos termos do decreto-\nlei aplicavel ao caso concreto.';
    expect(dehyphenateAttested(text)).toBe(text);
  });

  test('sem atestado nada e alterado (nao inventa palavras)', () => {
    const text = 'A fiscali-\nzacao deve ocorrer todo mes.';
    expect(dehyphenateAttested(text)).toBe(text);
  });

  test('texto sem hifenizacao de quebra passa inalterado', () => {
    const text = 'Texto comum sem quebras hifenizadas, incluindo decreto-lei intacto.';
    expect(dehyphenateAttested(text)).toBe(text);
  });
});
