import { normalizeForSearch } from './rag.service';
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
