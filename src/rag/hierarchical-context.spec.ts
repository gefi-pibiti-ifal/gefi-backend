import type { Prisma } from '@prisma/client';
import { Document } from '@langchain/core/documents';
import {
  buildClusters,
  applyHierarchicalBoost,
  expandWithNeighbors,
  flattenClusters,
  deriveSiblingPrefix,
  sortParentsByStructuralOrder,
  compareParentsByStructuralOrder,
  MAX_EXPANDED_PARENTS,
  MAX_EXPANDED_CHARS,
  MAX_NEIGHBOR_DISTANCE,
  ParentChunkRow,
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

  test('buildRagPrompt anota a origem estrutural dos trechos e pede fontes ao final', () => {
    const contexts = [
      new Document({ pageContent: 'Conteudo do item 10.1', metadata: { documentId: 'doc-1', title: 'Documento A', n1_header: 'ANEXO I', n2_header: '10.1.' } }),
      new Document({ pageContent: 'Conteudo do item 10.2', metadata: { documentId: 'doc-1', title: 'Documento A', n1_header: 'ANEXO I', n2_header: '10.2.' } }),
    ];

    const prompt = buildRagPrompt(contexts, 'O que diz o Anexo I?');

    // Cada trecho carrega sua identidade estrutural (base das citacoes finais)
    expect(prompt).toContain('[Trecho 1] Documento: "Documento A" | ANEXO I | Item 10.1.');
    expect(prompt).toContain('[Trecho 2] Documento: "Documento A" | ANEXO I | Item 10.2.');
    // A prioridade e comunicada pela ordem, e as referencias vao ao final
    expect(prompt).toContain('ordenados por pertinencia');
    expect(prompt).toContain('Fontes:');
  });

  test('MAX_NEIGHBOR_DISTANCE e um numero positivo e usado para ordenar proximidade', () => {
    expect(typeof MAX_NEIGHBOR_DISTANCE).toBe('number');
    expect(MAX_NEIGHBOR_DISTANCE).toBeGreaterThan(0);
  });
});
