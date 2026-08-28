import type { Prisma } from '@prisma/client';
import { Document } from '@langchain/core/documents';
import {
  buildClusters,
  applyHierarchicalBoost,
  expandWithNeighbors,
  flattenClusters,
  pruneForeignAnexoContamination,
  isNearDuplicateContent,
  rankByProvenance,
  deriveSiblingPrefix,
  sortParentsByStructuralOrder,
  compareParentsByStructuralOrder,
  MAX_EXPANDED_PARENTS,
  MAX_EXPANDED_CHARS,
  MAX_NEIGHBOR_DISTANCE,
  SIBLING_HIT_DOMINANCE_FRACTION,
  ParentChunkRow,
  Provenance,
} from './hierarchical-context';
import { buildRagPrompt } from './rag.service';

type SimpleParent = Omit<ParentChunkRow, 'created_at'>;

function makeRow(overrides: Partial<SimpleParent> & { id: string; document_id: string; section_header: string; content: string; created_at?: Date; }): ParentChunkRow {
  const metadata = typeof overrides.metadata === 'object' && overrides.metadata !== null
    ? overrides.metadata as Record<string, unknown>
    : {};
 
  return {
    id: overrides.id,
    document_id: overrides.document_id,
    section_header: overrides.section_header,
    content: overrides.content,
    metadata: {
      documentId: overrides.document_id,
      title: `Title ${overrides.document_id}`,
      n1_header: overrides.section_header,
      n2_header: '10.2.',
      ...metadata,
    } as Prisma.JsonValue,
    created_at: overrides.created_at ?? new Date('2024-01-01T00:00:00Z'),
  };
}

describe('hierarchical-context', () => {
  test('buildClusters agrupa parents por documentId e n1_header preservando ordem', () => {
    const rows = [
      makeRow({ id: 'p1', document_id: 'doc-1', section_header: 'ANEXO I', content: 'A' }),
      makeRow({ id: 'p2', document_id: 'doc-1', section_header: 'ANEXO I', content: 'B' }),
      makeRow({ id: 'p3', document_id: 'doc-1', section_header: 'ANEXO II', content: 'C' }),
      makeRow({ id: 'p4', document_id: 'doc-2', section_header: 'ANEXO I', content: 'D' }),
    ];

    const scoreByParentId = new Map<string, number>([
      ['p1', 0.1],
      ['p2', 0.2],
      ['p3', 0.3],
      ['p4', 0.4],
    ]);

    const clusters = buildClusters(rows, scoreByParentId);

    expect(clusters).toHaveLength(3);
    expect(clusters[0].documentId).toBe('doc-1');
    expect(clusters[0].n1Header).toBe('ANEXO I');
    expect(clusters[0].hitCount).toBe(2);
    expect(clusters[0].bestScore).toBe(0.1);
    expect(clusters[1].n1Header).toBe('ANEXO II');
    expect(clusters[2].documentId).toBe('doc-2');
  });

  test('applyHierarchicalBoost prioriza hitCount e desempata pelo melhor score vetorial', () => {
    const clusters = [
      { documentId: 'doc-1', n1Header: 'ANEXO I', parents: [], hitCount: 1, bestScore: 0.3 },
      { documentId: 'doc-1', n1Header: 'ANEXO II', parents: [], hitCount: 2, bestScore: 0.2 },
      { documentId: 'doc-1', n1Header: 'ANEXO III', parents: [], hitCount: 2, bestScore: 0.1 },
    ];

    const boosted = applyHierarchicalBoost(clusters);

    // Empate em hitCount (ANEXO II e III): vence o de melhor score (menor
    // distancia). ANEXO I, com menos hits, fica por ultimo.
    expect(boosted[0].n1Header).toBe('ANEXO III');
    expect(boosted[1].n1Header).toBe('ANEXO II');
    expect(boosted[2].n1Header).toBe('ANEXO I');
  });

  test('applyHierarchicalBoost preserva ordem de insercao em empate total', () => {
    const clusters = [
      { documentId: 'doc-1', n1Header: 'ANEXO A', parents: [], hitCount: 1, bestScore: 0.2 },
      { documentId: 'doc-1', n1Header: 'ANEXO B', parents: [], hitCount: 1, bestScore: 0.2 },
    ];

    const boosted = applyHierarchicalBoost(clusters);

    expect(boosted[0].n1Header).toBe('ANEXO A');
    expect(boosted[1].n1Header).toBe('ANEXO B');
  });

  test('deriveSiblingPrefix retorna prefixo de irmãos e nível correto', () => {
    expect(deriveSiblingPrefix('10.2.')).toEqual({ parentPrefix: '10.', parentNumbers: [10], level: 2 });
    expect(deriveSiblingPrefix('10.2.1.')).toEqual({ parentPrefix: '10.2.', parentNumbers: [10, 2], level: 3 });
    expect(deriveSiblingPrefix('1.')).toBeNull();
    expect(deriveSiblingPrefix('Art. 47')).toBeNull();
  });

  test('sortParentsByStructuralOrder ordena n2_headers numericamente', () => {
    const rows = [
      makeRow({ id: 'p1', document_id: 'doc-1', section_header: '10.4.', content: 'D', metadata: { n2_header: '10.4.' } }),
      makeRow({ id: 'p2', document_id: 'doc-1', section_header: '10.2.', content: 'B', metadata: { n2_header: '10.2.' } }),
      makeRow({ id: 'p3', document_id: 'doc-1', section_header: '10.2.1.', content: 'C', metadata: { n2_header: '10.2.1.' } }),
      makeRow({ id: 'p4', document_id: 'doc-1', section_header: '10.1.', content: 'A', metadata: { n2_header: '10.1.' } }),
    ];

    const sorted = sortParentsByStructuralOrder(rows);
    expect(sorted.map((row) => row.section_header)).toEqual(['10.1.', '10.2.', '10.2.1.', '10.4.']);
  });

  test('compareParentsByStructuralOrder coloca entradas parseáveis antes de não-parseáveis', () => {
    const a = makeRow({ id: 'p1', document_id: 'doc-1', section_header: '10.2.', content: 'A', metadata: { n2_header: '10.2.' } });
    const b = makeRow({ id: 'p2', document_id: 'doc-1', section_header: 'ANEXO I', content: 'B', metadata: { n2_header: '' } });
    expect(compareParentsByStructuralOrder(a, b)).toBeLessThan(0);
  });

  test('expandWithNeighbors preserva parents originais e adiciona vizinhos proximos sem duplicatas', () => {
    const existing = [
      makeRow({ id: 'p1', document_id: 'doc-1', section_header: 'ANEXO I', content: 'Conteudo A', created_at: new Date('2024-01-01T00:00:00Z') }),
    ];
    const candidates = [
      makeRow({ id: 'p3', document_id: 'doc-1', section_header: 'ANEXO I', content: 'Conteudo C', created_at: new Date('2024-01-01T00:00:03Z') }),
      makeRow({ id: 'p1', document_id: 'doc-1', section_header: 'ANEXO I', content: 'Conteudo A', created_at: new Date('2024-01-01T00:00:01Z') }),
      makeRow({ id: 'p2', document_id: 'doc-1', section_header: 'ANEXO I', content: 'Conteudo B', created_at: new Date('2024-01-01T00:00:02Z') }),
      makeRow({ id: 'p4', document_id: 'doc-1', section_header: 'ANEXO I', content: 'Conteudo C', created_at: new Date('2024-01-01T00:00:04Z') }),
    ];

    const expanded = expandWithNeighbors(existing, candidates);

    expect(expanded[0].id).toBe('p1');
    expect(expanded.map((row) => row.id)).toEqual(['p1', 'p3', 'p2']);
    expect(expanded).toHaveLength(3);
  });

  test('flattenClusters deduplica por id e por conteudo e respeita o limite de chars', () => {
    const longContent = 'x'.repeat(MAX_EXPANDED_CHARS + 1);
    const clusters = [
      {
        documentId: 'doc-1',
        n1Header: 'ANEXO I',
        parents: [
          makeRow({ id: 'p1', document_id: 'doc-1', section_header: 'ANEXO I', content: 'Conteudo A' }),
          makeRow({ id: 'p2', document_id: 'doc-1', section_header: 'ANEXO I', content: 'Conteudo A' }),
        ],
        hitCount: 1,
        bestScore: 0.1,
      },
      {
        documentId: 'doc-1',
        n1Header: 'ANEXO II',
        parents: [
          makeRow({ id: 'p3', document_id: 'doc-1', section_header: 'ANEXO II', content: longContent }),
          makeRow({ id: 'p4', document_id: 'doc-1', section_header: 'ANEXO II', content: 'Conteudo B' }),
        ],
        hitCount: 1,
        bestScore: 0.2,
      },
    ];

    const flattened = flattenClusters(clusters as any);

    expect(flattened.map((row) => row.id)).toEqual(['p1', 'p4']);
    expect(flattened).toHaveLength(2);
  });

  test('flattenClusters nao deixa cluster da cauda sem representante (round-robin)', () => {
    // Regressao: numa pergunta transversal, o cluster dominante consumia o teto
    // inteiro e os escopos da cauda (corpo da norma, conta vinculada, lei)
    // eram cortados por completo — mesmo tendo hit direto do retriever.
    const mk = (id: string, n1: string) =>
      makeRow({ id, document_id: 'doc-1', section_header: n1, content: `Conteudo proprio e distinto do parent ${id}.`, metadata: { n1_header: n1, n2_header: `${id}.` } });

    const grande = Array.from({ length: MAX_EXPANDED_PARENTS + 5 }, (_, i) => mk(`a${i}`, 'ANEXO A'));
    const clusters = [
      { documentId: 'doc-1', n1Header: 'ANEXO A', parents: grande, hitCount: grande.length, bestScore: 0.1 },
      { documentId: 'doc-1', n1Header: 'ANEXO B', parents: [mk('b0', 'ANEXO B'), mk('b1', 'ANEXO B')], hitCount: 2, bestScore: 0.2 },
      { documentId: 'doc-1', n1Header: 'ANEXO C', parents: [mk('c0', 'ANEXO C')], hitCount: 1, bestScore: 0.3 },
    ];

    const flat = flattenClusters(clusters as any);

    expect(flat.length).toBeLessThanOrEqual(MAX_EXPANDED_PARENTS);
    // todo cluster tem ao menos um representante
    expect(flat.some((r) => r.id.startsWith('a'))).toBe(true);
    expect(flat.some((r) => r.id.startsWith('b'))).toBe(true);
    expect(flat.some((r) => r.id === 'c0')).toBe(true);
    // a emissao mantem os clusters contiguos (leitura continua do dispositivo)
    const rotulos = flat.map((r) => r.id[0]);
    const transicoes = rotulos.filter((c, i) => i > 0 && c !== rotulos[i - 1]).length;
    expect(transicoes).toBe(2); // a -> b -> c, sem intercalar
  });

  test('flattenClusters com prioridade de selecao: HIT nunca perde vaga para irmao de expansao', () => {
    // Regressao: a clausula 12.8 (HIT direto) era cortada pelo teto enquanto os
    // irmaos 12.3/12.6 (expansao) entravam — a fila estrutural do cluster
    // consumia as vagas na ordem numerica, ignorando a proveniencia.
    const mk = (id: string, n1: string) =>
      makeRow({ id, document_id: 'doc-1', section_header: n1, content: `Conteudo proprio e distinto do parent ${id}.`, metadata: { n1_header: n1, n2_header: `${id}.` } });

    // cluster com 12.3(sib), 12.5(hit), 12.6(sib), 12.7(sib), 12.8(hit) em ordem estrutural
    const contrato = ['s3', 'h5', 's6', 's7', 'h8'].map((id) => mk(id, 'CONTRATO'));
    // outros clusters grandes para apertar o teto
    const enchimento = Array.from({ length: MAX_EXPANDED_PARENTS * 2 }, (_, i) => mk(`f${i}`, 'ANEXO F'));
    const clusters = [
      { documentId: 'doc-1', n1Header: 'CONTRATO', parents: contrato, hitCount: 2, bestScore: 0.1 },
      { documentId: 'doc-1', n1Header: 'ANEXO F', parents: enchimento, hitCount: 1, bestScore: 0.2 },
    ];

    const prioridade = (row: ParentChunkRow) => (row.id.startsWith('h') ? 0 : 2);
    const flat = flattenClusters(clusters as any, prioridade);

    // os dois hits do cluster entram antes de qualquer irmao dele
    expect(flat.some((r) => r.id === 'h5')).toBe(true);
    expect(flat.some((r) => r.id === 'h8')).toBe(true);
    // e a emissao continua na ordem estrutural do cluster (nao na de selecao)
    const doCluster = flat.filter((r) => ['s3', 'h5', 's6', 's7', 'h8'].includes(r.id)).map((r) => r.id);
    expect(doCluster).toEqual(['s3', 'h5', 's6', 's7', 'h8'].filter((id) => doCluster.includes(id)));
  });

  test('buildRagPrompt anota a origem estrutural dos trechos e cita a fonte inline', () => {
    const contexts = [
      new Document({ pageContent: 'Conteudo do item 10.1', metadata: { documentId: 'doc-1', title: 'Documento A', n1_header: 'ANEXO I', n2_header: '10.1.' } }),
      new Document({ pageContent: 'Conteudo do item 10.2', metadata: { documentId: 'doc-1', title: 'Documento A', n1_header: 'ANEXO I', n2_header: '10.2.' } }),
    ];

    const prompt = buildRagPrompt(contexts, 'O que diz o Anexo I?');

    // Cada trecho carrega sua identidade estrutural (base das citacoes por secao)
    expect(prompt).toContain('[Trecho 1] Documento: "Documento A" | ANEXO I | Item 10.1.');
    expect(prompt).toContain('[Trecho 2] Documento: "Documento A" | ANEXO I | Item 10.2.');
    // A prioridade e comunicada pela ordem; a fonte e citada inline por secao
    expect(prompt).toContain('ordenados por pertinencia');
    expect(prompt).toContain('CITACAO DA FONTE');
  });

  test('MAX_NEIGHBOR_DISTANCE e um numero positivo e usado para ordenar proximidade', () => {
    expect(typeof MAX_NEIGHBOR_DISTANCE).toBe('number');
    expect(MAX_NEIGHBOR_DISTANCE).toBeGreaterThan(0);
  });
});

describe('pruneForeignAnexoContamination', () => {
  const anexoRow = (id: string, documentId: string, n1: string) =>
    makeRow({ id, document_id: documentId, section_header: n1, content: 'x'.repeat(120), metadata: { n1_header: n1 } });

  test('remove anexo estranho do mesmo documento com apoio fraco (1 hit) quando ha dominante', () => {
    const parents = [
      anexoRow('p1', 'in05', 'ANEXO VIII-B'),
      anexoRow('p2', 'in05', 'ANEXO VIII-B'),
      anexoRow('p3', 'in05', 'ANEXO V-B'), // fiscal tecnico — boilerplate paralelo
    ];
    const hits = new Map<string, number>([
      ['in05|||ANEXO VIII-B', 2],
      ['in05|||ANEXO V-B', 1],
    ]);

    const pruned = pruneForeignAnexoContamination(parents, hits);

    expect(pruned.map((r) => r.id)).toEqual(['p1', 'p2']);
  });

  test('preserva anexo estrangeiro corroborado (>= 2 hits)', () => {
    const parents = [
      anexoRow('p1', 'in05', 'ANEXO VIII-B'),
      anexoRow('p2', 'in05', 'ANEXO VIII-B'),
      anexoRow('p3', 'in05', 'ANEXO V-B'),
      anexoRow('p4', 'in05', 'ANEXO V-B'),
    ];
    const hits = new Map<string, number>([
      ['in05|||ANEXO VIII-B', 2],
      ['in05|||ANEXO V-B', 2],
    ]);

    const pruned = pruneForeignAnexoContamination(parents, hits);

    expect(pruned).toHaveLength(4);
  });

  test('preserva conteudo de OUTRO documento com 1 hit (resposta multi-norma)', () => {
    const parents = [
      anexoRow('p1', 'in05', 'ANEXO VIII-B'),
      anexoRow('p2', 'in05', 'ANEXO VIII-B'),
      anexoRow('p3', 'lei-8666', 'CAPITULO III'), // outro documento
    ];
    const hits = new Map<string, number>([
      ['in05|||ANEXO VIII-B', 2],
      ['lei-8666|||CAPITULO III', 1],
    ]);

    const pruned = pruneForeignAnexoContamination(parents, hits);

    expect(pruned.map((r) => r.id)).toEqual(['p1', 'p2', 'p3']);
  });

  test('nao poda quando nao ha escopo dominante claro (todos com 1 hit)', () => {
    const parents = [
      anexoRow('p1', 'in05', 'ANEXO VIII-B'),
      anexoRow('p2', 'in05', 'ANEXO V-B'),
    ];
    const hits = new Map<string, number>([
      ['in05|||ANEXO VIII-B', 1],
      ['in05|||ANEXO V-B', 1],
    ]);

    const pruned = pruneForeignAnexoContamination(parents, hits);

    expect(pruned).toHaveLength(2);
  });

  test('escopo unico passa inalterado', () => {
    const parents = [anexoRow('p1', 'in05', 'ANEXO VIII-B'), anexoRow('p2', 'in05', 'ANEXO VIII-B')];
    const hits = new Map<string, number>([['in05|||ANEXO VIII-B', 2]]);

    expect(pruneForeignAnexoContamination(parents, hits)).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Regressao do caso real: "Qual e o limite de valor para dispensa de
  // licitacao?" O Art. 75 da Lei 14.133 (Secao III) foi o PRIMEIRO colocado do
  // ranking e levou 6 dos 12 child hits — mas todos colapsavam num unico
  // parent gigante. Contando PARENTS ele valia 1, perdia a dominancia para
  // Art. 4o + Art. 95 (CAPITULO I, 2 parents, scores piores) e era podado como
  // "anexo estranho". A resposta virava "informacoes insuficientes".
  // -------------------------------------------------------------------------
  describe('dispositivo longo dominante nao pode ser podado', () => {
    const lei = (id: string, n1: string) =>
      makeRow({ id, document_id: 'lei14133', section_header: n1, content: 'x'.repeat(200), metadata: { n1_header: n1 } });

    test('contagem por CHILD HIT preserva o artigo que monopoliza o Top-K', () => {
      const parents = [lei('art75', 'Seção III'), lei('art4', 'CAPÍTULO I'), lei('art95', 'CAPÍTULO I')];
      // 6 childs do Art. 75 contra 1 child de cada artigo do CAPITULO I
      const hitsPorChild = new Map<string, number>([
        ['lei14133|||Seção III', 6],
        ['lei14133|||CAPÍTULO I', 2],
      ]);

      const pruned = pruneForeignAnexoContamination(parents, hitsPorChild);
      expect(pruned.map((r) => r.id)).toContain('art75');
      expect(pruned).toHaveLength(3);
    });

    test('o escopo do melhor score e imune mesmo perdendo a contagem', () => {
      const parents = [lei('art75', 'Seção III'), lei('art4', 'CAPÍTULO I'), lei('art95', 'CAPÍTULO I')];
      // cenario adverso: a contagem favorece o CAPITULO I
      const hits = new Map<string, number>([
        ['lei14133|||Seção III', 1],
        ['lei14133|||CAPÍTULO I', 2],
      ]);

      // sem a protecao, o Art. 75 sairia
      expect(pruneForeignAnexoContamination(parents, hits).map((r) => r.id)).not.toContain('art75');
      // com o escopo do melhor hit protegido, permanece
      const comTopScope = pruneForeignAnexoContamination(parents, hits, 'lei14133|||Seção III');
      expect(comTopScope.map((r) => r.id)).toContain('art75');
    });

    test('escopo estrangeiro fraco com conteudo DISTINTO sobrevive (pergunta transversal)', () => {
      // Regressao do caso real: pergunta sobre pagamento direto de salarios.
      // O ANEXO VIII-B dominou com 4 child hits; o Art. 65 (Secao IV, fonte dos
      // recursos e prazo de 15 dias), o ANEXO XII (conta vinculada) e o
      // VII-F 4.2 (falta grave) tinham 1 hit cada e eram podados — apesar de
      // nao terem NADA redundante com o dominante.
      const mkContent = (id: string, doc: string, n1: string, content: string) =>
        makeRow({ id, document_id: doc, section_header: n1, content, metadata: { n1_header: n1 } });
      const parents = [
        mkContent('viii-b-8', 'in05', 'ANEXO VIII-B', 'O descumprimento das obrigacoes trabalhistas pelo contratado podera dar ensejo a concessao de prazo para regularizacao das condicoes de habilitacao da empresa.'),
        mkContent('viii-b-9', 'in05', 'ANEXO VIII-B', 'Para efeito de recebimento provisorio o fiscal administrativo devera verificar a efetiva realizacao dos dispendios concernentes aos salarios do mes anterior.'),
        mkContent('art65', 'in05', 'Seção IV', 'Ate que a contratada comprove o disposto no artigo anterior o orgao contratante devera reter a garantia contratual e os valores das notas fiscais em valor proporcional ao inadimplemento.'),
        mkContent('xii-11', 'in05', 'ANEXO XII', 'A empresa contratada podera solicitar autorizacao para utilizar os valores da conta deposito vinculada bloqueada para movimentacao quitando obrigacoes trabalhistas.'),
      ];
      const hits = new Map<string, number>([
        ['in05|||ANEXO VIII-B', 4],
        ['in05|||Seção IV', 1],
        ['in05|||ANEXO XII', 1],
      ]);

      const pruned = pruneForeignAnexoContamination(parents, hits, 'in05|||ANEXO VIII-B');

      // conteudo distinto e complementar: nada e removido
      expect(pruned.map((r) => r.id)).toEqual(['viii-b-8', 'viii-b-9', 'art65', 'xii-11']);
    });

    test('escopo estrangeiro fraco com conteudo QUASE-DUPLICADO continua removido (boilerplate)', () => {
      const espelhoBase = 'Para efeito de recebimento provisorio ao final de cada periodo mensal o fiscal devera verificar a efetiva realizacao dos dispendios concernentes aos salarios e obrigacoes trabalhistas previdenciarias do mes anterior emitindo relatorio circunstanciado que sera encaminhado ao gestor do contrato';
      const parents = [
        makeRow({ id: 'dom1', document_id: 'in05', section_header: 'ANEXO VIII-B', content: espelhoBase + ' pelo fiscal administrativo.', metadata: { n1_header: 'ANEXO VIII-B' } }),
        makeRow({ id: 'dom2', document_id: 'in05', section_header: 'ANEXO VIII-B', content: 'Outra rotina do anexo dominante com redacao completamente propria e distinta.'.repeat(2), metadata: { n1_header: 'ANEXO VIII-B' } }),
        makeRow({ id: 'espelho', document_id: 'in05', section_header: 'ANEXO V-B', content: espelhoBase + ' pelo fiscal tecnico.', metadata: { n1_header: 'ANEXO V-B' } }),
      ];
      const hits = new Map<string, number>([
        ['in05|||ANEXO VIII-B', 2],
        ['in05|||ANEXO V-B', 1],
      ]);

      const pruned = pruneForeignAnexoContamination(parents, hits, 'in05|||ANEXO VIII-B');

      expect(pruned.map((r) => r.id)).toEqual(['dom1', 'dom2']);
    });

    test('isNearDuplicateContent separa espelho de conteudo transversal', () => {
      const dominante = 'O orgao devera verificar a realizacao dos dispendios concernentes aos salarios e obrigacoes trabalhistas previdenciarias do mes anterior dos empregados da contratada envolvidos na prestacao';
      const espelho = 'O orgao devera verificar a realizacao dos dispendios concernentes aos salarios e obrigacoes trabalhistas previdenciarias do mes anterior dos empregados da empresa envolvidos na execucao';
      const transversal = 'A empresa contratada podera solicitar autorizacao do orgao para utilizar os valores da conta deposito vinculada para quitar verbas rescisorias dos trabalhadores';
      expect(isNearDuplicateContent(espelho, dominante)).toBe(true);
      expect(isNearDuplicateContent(transversal, dominante)).toBe(false);
      // igualdade exata vale mesmo para conteudo curto/sintetico
      expect(isNearDuplicateContent('x'.repeat(120), 'x'.repeat(120))).toBe(true);
    });

    test('a protecao do melhor hit nao reabilita contaminacao de outro escopo', () => {
      const parents = [
        anexoRow('p1', 'in05', 'ANEXO VIII-B'),
        anexoRow('p2', 'in05', 'ANEXO VIII-B'),
        anexoRow('p3', 'in05', 'ANEXO V-B'), // boilerplate paralelo, 1 hit
      ];
      const hits = new Map<string, number>([
        ['in05|||ANEXO VIII-B', 2],
        ['in05|||ANEXO V-B', 1],
      ]);

      // o melhor hit esta no dominante — o anexo estranho continua sendo podado
      const pruned = pruneForeignAnexoContamination(parents, hits, 'in05|||ANEXO VIII-B');
      expect(pruned.map((r) => r.id)).toEqual(['p1', 'p2']);
    });
  });
});

describe('rankByProvenance', () => {
  const row = (id: string) =>
    makeRow({ id, document_id: 'in05', section_header: id, content: 'x'.repeat(120) });

  const provOf = (...pairs: Array<[string, Provenance[]]>) =>
    new Map(pairs.map(([id, ps]) => [id, new Set<Provenance>(ps)]));

  test('hit direto e descendente sao PRINCIPAL; irmao-so e COMPLEMENTAR', () => {
    // 9 (hit), 10.2 (hit), 10.2.1 (descendente de 10.2), 10.4/10.5 (irmaos de 10.2)
    const parents = [row('9'), row('10.2'), row('10.2.1'), row('10.4'), row('10.5')];
    const prov = provOf(
      ['9', ['HIT']],
      ['10.2', ['HIT']],
      ['10.2.1', ['DESCENDANT']],
      ['10.4', ['SIBLING']],
      ['10.5', ['SIBLING']],
    );

    const ranked = rankByProvenance(parents, prov);
    const roleById = new Map(ranked.map((r) => [r.row.id, r.role]));

    expect(roleById.get('9')).toBe('PRINCIPAL');
    expect(roleById.get('10.2')).toBe('PRINCIPAL');
    expect(roleById.get('10.2.1')).toBe('PRINCIPAL');
    expect(roleById.get('10.4')).toBe('COMPLEMENTAR');
    expect(roleById.get('10.5')).toBe('COMPLEMENTAR');
  });

  test('centrais vem antes dos complementares, preservando a ordem interna', () => {
    const parents = [row('10.4'), row('9'), row('10.5'), row('10.2')]; // apoio intercalado
    const prov = provOf(
      ['9', ['HIT']],
      ['10.2', ['HIT']],
      ['10.4', ['SIBLING']],
      ['10.5', ['SIBLING']],
    );

    const ranked = rankByProvenance(parents, prov);

    // ordem estavel: centrais (9, 10.2 na ordem de entrada) e depois apoio (10.4, 10.5)
    expect(ranked.map((r) => r.row.id)).toEqual(['9', '10.2', '10.4', '10.5']);
  });

  test('multipla proveniencia (hit + irmao) prevalece como PRINCIPAL', () => {
    const parents = [row('7')];
    const prov = provOf(['7', ['SIBLING', 'HIT']]);
    expect(rankByProvenance(parents, prov)[0].role).toBe('PRINCIPAL');
  });

  test('proveniencia desconhecida nao rebaixa (conservador, preserva recall)', () => {
    const parents = [row('desconhecido')];
    const ranked = rankByProvenance(parents, new Map());
    expect(ranked[0].role).toBe('PRINCIPAL');
    expect(ranked[0].provenance).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Dominancia entre HITs irmaos — regressao do caso real:
  // "Quais as rotinas da fiscalizacao mensal exigidas no Anexo VIII-B?"
  // O retriever devolvia, alem do hit correto (Item 10.2 "Fiscalizacao
  // mensal"), um HIT direto e muito mais fraco no Item 10.5 ("Fiscalizacao
  // por amostragem" — irmao estrutural de 10.2, mesmo item pai "10."), que
  // compartilhava vocabulario ("fiscalizacao", "qualquer mes") com a
  // pergunta. Sem distincao de forca entre os dois, ambos viravam PRINCIPAL
  // e o Item 10.5 ganhava um bloco proprio na resposta, quando deveria ser
  // apenas material de apoio. Os scores abaixo replicam os valores reais
  // observados na producao (menor = mais relevante).
  // -------------------------------------------------------------------------
  describe('rankByProvenance — dominancia entre HITs irmaos', () => {
    const famRow = (id: string, n2Header: string, n1Header = 'ANEXO VIII-B') =>
      makeRow({
        id,
        document_id: 'in05',
        section_header: n2Header,
        content: 'x'.repeat(120),
        metadata: { n1_header: n1Header, n2_header: n2Header },
      });

    test('HIT muito mais fraco que o ancora da mesma familia (item pai) e rebaixado a COMPLEMENTAR', () => {
      const parents = [famRow('9', '9.'), famRow('10.2', '10.2.'), famRow('10.5', '10.5.'), famRow('6', '6.')];
      const prov = provOf(
        ['9', ['HIT']],
        ['10.2', ['HIT']],
        ['10.5', ['HIT']],
        ['6', ['HIT']],
      );
      // Scores reais observados: 9=0.300448, 10.2=0.302121, 10.5=0.316299, 6=0.326961
      const scores = new Map([
        ['9', 0.300448],
        ['10.2', 0.302121],
        ['10.5', 0.316299],
        ['6', 0.326961],
      ]);

      const ranked = rankByProvenance(parents, prov, scores);
      const roleById = new Map(ranked.map((r) => [r.row.id, r.role]));

      expect(roleById.get('9')).toBe('PRINCIPAL');
      expect(roleById.get('10.2')).toBe('PRINCIPAL');
      expect(roleById.get('10.5')).toBe('COMPLEMENTAR');
      // proveniencia continua reportando HIT — so o papel (role) muda; nada e removido
      expect(ranked.find((r) => r.row.id === '10.5')!.provenance).toEqual(['HIT']);
    });

    test('HITs irmaos com score proximo (dentro do limiar) permanecem PRINCIPAL — preserva recall de perguntas multi-modalidade', () => {
      const parents = [famRow('9', '9.'), famRow('10.2', '10.2.'), famRow('10.4', '10.4.'), famRow('6', '6.')];
      const prov = provOf(
        ['9', ['HIT']],
        ['10.2', ['HIT']],
        ['10.4', ['HIT']],
        ['6', ['HIT']],
      );
      // 10.4 fica a apenas 0.003 de 10.2 — bem dentro do limiar relativo ao
      // espalhamento global (~0.027), diferente do caso de dominancia acima.
      const scores = new Map([
        ['9', 0.300448],
        ['10.2', 0.302121],
        ['10.4', 0.305121],
        ['6', 0.326961],
      ]);

      const ranked = rankByProvenance(parents, prov, scores);
      const roleById = new Map(ranked.map((r) => [r.row.id, r.role]));

      expect(roleById.get('10.2')).toBe('PRINCIPAL');
      expect(roleById.get('10.4')).toBe('PRINCIPAL');
    });

    test('DESCENDANT nunca e rebaixado por dominancia, mesmo com score fraco dentro da familia', () => {
      const parents = [famRow('10.2', '10.2.'), famRow('10.2.1', '10.2.1.')];
      const prov = provOf(
        ['10.2', ['HIT']],
        ['10.2.1', ['HIT', 'DESCENDANT']],
      );
      const scores = new Map([
        ['10.2', 0.30],
        ['10.2.1', 0.50], // score muito pior — mas e descendente do proprio 10.2, nao um irmao
      ]);

      const ranked = rankByProvenance(parents, prov, scores);
      const roleById = new Map(ranked.map((r) => [r.row.id, r.role]));

      expect(roleById.get('10.2.1')).toBe('PRINCIPAL');
    });

    test('sem mapa de scores (parametro omitido), comportamento e identico ao anterior — retrocompatibilidade', () => {
      const parents = [famRow('10.2', '10.2.'), famRow('10.5', '10.5.')];
      const prov = provOf(['10.2', ['HIT']], ['10.5', ['HIT']]);

      const ranked = rankByProvenance(parents, prov); // sem terceiro argumento
      const roleById = new Map(ranked.map((r) => [r.row.id, r.role]));

      expect(roleById.get('10.2')).toBe('PRINCIPAL');
      expect(roleById.get('10.5')).toBe('PRINCIPAL');
    });

    test('menos de dois scores conhecidos: sem base para calcular espalhamento, nao rebaixa', () => {
      const parents = [famRow('10.2', '10.2.'), famRow('10.5', '10.5.')];
      const prov = provOf(['10.2', ['HIT']], ['10.5', ['HIT']]);
      const scores = new Map([['10.2', 0.30]]); // 10.5 sem score conhecido

      const ranked = rankByProvenance(parents, prov, scores);
      const roleById = new Map(ranked.map((r) => [r.row.id, r.role]));

      expect(roleById.get('10.5')).toBe('PRINCIPAL');
    });

    test('SIBLING_HIT_DOMINANCE_FRACTION e uma fracao positiva menor que 1', () => {
      expect(typeof SIBLING_HIT_DOMINANCE_FRACTION).toBe('number');
      expect(SIBLING_HIT_DOMINANCE_FRACTION).toBeGreaterThan(0);
      expect(SIBLING_HIT_DOMINANCE_FRACTION).toBeLessThan(1);
    });
  });
});
