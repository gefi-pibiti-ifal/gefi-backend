// ---------------------------------------------------------------------------
// hierarchical-context.ts
//
// Camada de Hierarchical Context Expansion do pipeline RAG.
//
// Responsabilidades:
//   1. Agrupar ParentChunks recuperados em RetrievalClusters por (documentId, n1Header).
//   2. Aplicar boost hierárquico: clusters com mais hits do retriever sobem na ordem.
//   3. Receber ParentChunks candidatos à expansão (vizinhos do mesmo n1Header)
//      e incorporá-los respeitando os limites de contexto.
//   4. Deduplificar e limitar o conjunto final antes do prompt.
//
// Este módulo é PURO: não faz I/O, não acessa banco, não usa Logger.
// Toda a lógica de busca de vizinhos fica em rag.service.ts, que chama
// expandWithNeighbors() após buscar os candidatos no Prisma.
//
// Extensibilidade:
//   - Multi-Query Retrieval: passar múltiplas listas de parents para buildClusters.
//   - HyDE: os parents já chegam aqui normalizados; nenhuma mudança necessária.
//   - Reranking: substituir applyHierarchicalBoost por um reranker externo.
// ---------------------------------------------------------------------------

import { parseItemNumber } from './legal-document-splitter';
import type { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Constantes de expansão hierárquica
// ---------------------------------------------------------------------------

/**
 * Número máximo de ParentChunks enviados ao LLM após expansão.
 * Elevado de 8 para 14 com a expansão descendente: um dispositivo enumerado
 * (caput + subitens 10.2.1..N) somado ao Item 9 e a poucos irmãos já passava
 * de 8, e o flatten cortava justamente a cauda dos subitens — reintroduzindo
 * a resposta incompleta que a expansão busca resolver.
 */
export const MAX_EXPANDED_PARENTS = 14;

/**
 * Limite total de caracteres do contexto enviado ao LLM.
 * Com parents integros (janela deslizante so acima de 3500 chars) e a expansão
 * descendente trazendo os filhos do dispositivo, 24k voltou a cortar subitens
 * no flatten. 40k chars (~10k tokens) segue trivial para a janela de 1M do
 * gemini-2.5-flash.
 */
export const MAX_EXPANDED_CHARS = 40_000;

/**
 * Distância máxima (em posição de inserção no banco) entre o top parent
 * e um vizinho para ser considerado "próximo".
 * Usado apenas como critério de ordenação dos candidatos — não filtra.
 */
export const MAX_NEIGHBOR_DISTANCE = 10;

/** Ativa o boost hierárquico na ordenação final dos clusters. */
export const HIERARCHICAL_BOOST_ENABLED = true;

/** Quando true, a expansão só busca vizinhos do mesmo documento. */
export const EXPAND_ONLY_SAME_DOCUMENT = true;

/**
 * Coerência de anexo — precisão entre processos administrativos.
 *
 * Um dispositivo pode ter texto quase idêntico ao de outro anexo do mesmo
 * documento (ex.: o "recebimento provisório" do fiscal técnico no ANEXO V-B
 * espelha o do fiscal administrativo no ANEXO VIII-B). Numa consulta ampla, sem
 * filtro de anexo, a busca vetorial traz os dois e o anexo estranho contamina a
 * resposta com um dispositivo de OUTRO processo.
 *
 * MIN_DOMINANT_SCOPE_HITS: só podamos quando existe um anexo claramente
 *   dominante — com pelo menos este número de hits do retriever. Abaixo disso a
 *   recuperação é ambígua e nada é removido.
 * MIN_FOREIGN_ANEXO_HITS: um anexo diferente do dominante, no MESMO documento,
 *   só permanece se tiver ao menos esta corroboração (hits do retriever). Um
 *   único hit isolado é tratado como boilerplate paralelo e removido.
 */
export const MIN_DOMINANT_SCOPE_HITS = 2;
export const MIN_FOREIGN_ANEXO_HITS  = 2;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/**
 * Representa um ParentChunk recuperado do banco, com os campos mínimos
 * necessários para a expansão hierárquica.
 * Compatível com o tipo gerado pelo Prisma para `ParentChunk`.
 */
export interface ParentChunkRow {
  id:             string;
  document_id:    string;
  section_header: string;
  content:        string;
  metadata:       Prisma.JsonValue; // Json do Prisma
  created_at:     Date;
}

/**
 * Cluster hierárquico: agrupa ParentChunks do mesmo (documentId, n1Header).
 * O bestScore é o menor valor de distância coseno entre os hits do retriever
 * (menor = mais relevante no pgvector com distância L2/coseno).
 */
export interface RetrievalCluster {
  documentId: string;
  n1Header:   string;
  parents:    ParentChunkRow[];
  /** Número de hits do retriever vetorial que caíram neste cluster. */
  hitCount:   number;
  /** Score do melhor hit (menor distância = mais relevante). */
  bestScore:  number;
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

function metaField(row: ParentChunkRow, field: string): string {
  const m = row.metadata as Record<string, unknown> | null;
  return (m && typeof m[field] === 'string') ? (m[field] as string) : '';
}

/** Extrai n1_header dos metadados do ParentChunk. */
export function getN1Header(row: ParentChunkRow): string {
  return metaField(row, 'n1_header');
}

/** Extrai n2_header dos metadados do ParentChunk. */
export function getN2Header(row: ParentChunkRow): string {
  return metaField(row, 'n2_header');
}

export function deriveSiblingPrefix(n2Header: string): { parentPrefix: string; parentNumbers: number[]; level: number } | null {
  const parsed = parseItemNumber(n2Header);
  if (!parsed || parsed.level <= 1) return null;

  const parentNumbers = parsed.numbers.slice(0, -1);
  if (parentNumbers.length === 0) return null;

  return {
    parentPrefix: `${parentNumbers.join('.')}.`,
    parentNumbers,
    level: parsed.level,
  };
}

function compareParsedNumbers(a: number[], b: number[]): number {
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export function compareParentsByStructuralOrder(a: ParentChunkRow, b: ParentChunkRow): number {
  const aHeader = getN2Header(a) || a.section_header || '';
  const bHeader = getN2Header(b) || b.section_header || '';
  const aParsed = parseItemNumber(aHeader);
  const bParsed = parseItemNumber(bHeader);

  if (aParsed && bParsed) {
    return compareParsedNumbers(aParsed.numbers, bParsed.numbers);
  }

  if (aParsed && !bParsed) return -1;
  if (!aParsed && bParsed) return 1;

  return aHeader.localeCompare(bHeader, undefined, { numeric: true, sensitivity: 'base' });
}

export function sortParentsByStructuralOrder(parents: ParentChunkRow[]): ParentChunkRow[] {
  return [...parents].sort(compareParentsByStructuralOrder);
}

// ---------------------------------------------------------------------------
// buildClusters
//
// Agrupa os ParentChunks recuperados pelo retriever em RetrievalClusters.
// A ordem dos clusters reflete a ordem de primeira aparição no array `parents`
// (que já está ordenado pelo ranking do retriever).
//
// `scoreByParentId`: mapa de parentId → score vetorial (distância coseno).
//   Scores menores = mais relevantes. Usado para calcular bestScore do cluster.
// ---------------------------------------------------------------------------
export function buildClusters(
  parents:         ParentChunkRow[],
  scoreByParentId: Map<string, number>,
): RetrievalCluster[] {
  const clusterMap = new Map<string, RetrievalCluster>();
  const order:      string[] = []; // preserva ordem de primeira aparição

  for (const row of parents) {
    const key = `${row.document_id}|||${getN1Header(row)}`;

    if (!clusterMap.has(key)) {
      clusterMap.set(key, {
        documentId: row.document_id,
        n1Header:   getN1Header(row),
        parents:    [],
        hitCount:   0,
        bestScore:  Infinity,
      });
      order.push(key);
    }

    const cluster = clusterMap.get(key)!;
    cluster.parents.push(row);
    cluster.hitCount += 1;

    const score = scoreByParentId.get(row.id) ?? Infinity;
    if (score < cluster.bestScore) cluster.bestScore = score;
  }

  return order.map(k => clusterMap.get(k)!);
}

// ---------------------------------------------------------------------------
// applyHierarchicalBoost
//
// Reordena os clusters priorizando aqueles com mais hits do retriever.
// Clusters com hitCount igual mantêm a ordem original (estável).
// Não altera os scores vetoriais — apenas a posição na lista final.
//
// Habilitado apenas quando HIERARCHICAL_BOOST_ENABLED = true.
// ---------------------------------------------------------------------------
export function applyHierarchicalBoost(clusters: RetrievalCluster[]): RetrievalCluster[] {
  if (!HIERARCHICAL_BOOST_ENABLED) return clusters;

  // Ordena por hitCount decrescente; empate: melhor score vetorial primeiro
  // (menor distancia = mais relevante). Antes o empate preservava apenas a
  // ordem de insercao e o bestScore ja calculado era ignorado — dois hits
  // medianos superavam um hit excelente sem criterio de qualidade.
  return [...clusters].sort((a, b) => {
    if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
    if (a.bestScore !== b.bestScore) return a.bestScore - b.bestScore;
    return 0; // estável: preserva ordem de inserção
  });
}

// ---------------------------------------------------------------------------
// pruneForeignAnexoContamination
//
// Remove dispositivos de um anexo "estranho" que contaminam uma resposta cujo
// processo administrativo vive em outro anexo do MESMO documento.
//
// O sinal decisivo é a contagem de hits do RETRIEVER (pré-expansão) por escopo
// (documento + n1_header): o processo que a pergunta realmente trata acumula
// vários hits (ex.: ANEXO VIII-B com Itens 9 e 10.2), enquanto uma duplicata
// paralela de outro anexo entra com um único hit (ex.: ANEXO V-B, Item 4). A
// contagem pós-expansão NAO serve — a expansão de irmãos/filhos infla ambos.
//
// Regras (conservadoras, para nunca podar recuperação legítima):
//   - só age quando ha um escopo dominante com >= MIN_DOMINANT_SCOPE_HITS;
//   - só remove escopos do MESMO documento e anexo DIFERENTE do dominante;
//   - preserva anexos estrangeiros corroborados (>= MIN_FOREIGN_ANEXO_HITS) e
//     qualquer conteudo de OUTROS documentos (respostas multi-norma legitimas).
//
// `retrievedScopeHits`: mapa `${document_id}|||${n1_header}` -> nº de parents
//   efetivamente recuperados pelo vetor naquele escopo (nao expandidos).
// ---------------------------------------------------------------------------
export function pruneForeignAnexoContamination(
  parents:            ParentChunkRow[],
  retrievedScopeHits: Map<string, number>,
): ParentChunkRow[] {
  if (retrievedScopeHits.size <= 1) return parents;

  let dominantScope = '';
  let dominantHits  = -1;
  for (const [scope, hits] of retrievedScopeHits) {
    if (hits > dominantHits) { dominantHits = hits; dominantScope = scope; }
  }
  if (dominantHits < MIN_DOMINANT_SCOPE_HITS) return parents;

  const sep          = dominantScope.lastIndexOf('|||');
  const dominantDoc  = dominantScope.slice(0, sep);
  const dominantN1   = dominantScope.slice(sep + 3);

  return parents.filter((row) => {
    const n1 = getN1Header(row);
    const sameDocForeignAnexo = row.document_id === dominantDoc && n1 !== dominantN1;
    if (!sameDocForeignAnexo) return true; // dominante e outros documentos permanecem
    const hits = retrievedScopeHits.get(`${row.document_id}|||${n1}`) ?? 0;
    return hits >= MIN_FOREIGN_ANEXO_HITS;
  });
}

// ---------------------------------------------------------------------------
// Selecao por PROVENIENCIA (precisao pos-recuperacao, deterministica)
//
// Cada dispositivo do conjunto candidato carrega COMO entrou nele:
//   HIT        — acerto direto da busca vetorial (casou com o tema perguntado);
//   DESCENDANT — filho de um hit; completa o MESMO dispositivo (ex.: 10.2.1 sob
//                10.2) -> central;
//   SIBLING    — irmao trazido pela expansao (vizinho numerico do hit, ex.:
//                10.4/10.5 ao lado de 10.2); provavelmente OUTRO dispositivo,
//                modalidade ou variante -> apoio.
//
// Politica: e CENTRAL (PRINCIPAL) quem tem HIT ou DESCENDANT; e COMPLEMENTAR
// quem entrou APENAS por SIBLING. Nada e removido — so a prioridade muda, com os
// centrais a frente (ordem estavel). Substitui o antigo criterio por score.
//
// Limite conhecido: nao distingue papeis ORTOGONAIS a estrutura — um hit direto
// que e excecao/variante (ex.: "comunicar em caso de irregularidade") e
// estruturalmente identico a um hit central e permanece PRINCIPAL. Esse residuo
// semantico so uma camada de intencao (LLM/classificador) resolve.
// ---------------------------------------------------------------------------
export type Provenance = 'HIT' | 'DESCENDANT' | 'SIBLING';

export interface RankedParent {
  row:        ParentChunkRow;
  role:       'PRINCIPAL' | 'COMPLEMENTAR';
  provenance: Provenance[];
}

export function rankByProvenance(
  parents:        ParentChunkRow[],
  provenanceById: Map<string, Set<Provenance>>,
): RankedParent[] {
  const classified: RankedParent[] = parents.map((row) => {
    const prov = provenanceById.get(row.id);
    // Sem proveniencia conhecida: conservador — mantem como central (nao rebaixa
    // o que nao conseguimos explicar, preservando recall).
    const isCentral = !prov || prov.has('HIT') || prov.has('DESCENDANT');
    return {
      row,
      role: (isCentral ? 'PRINCIPAL' : 'COMPLEMENTAR') as RankedParent['role'],
      provenance: prov ? [...prov] : [],
    };
  });

  // Estavel: centrais primeiro (preservando a ordem estrutural), apoio depois.
  return [
    ...classified.filter((c) => c.role === 'PRINCIPAL'),
    ...classified.filter((c) => c.role === 'COMPLEMENTAR'),
  ];
}

// ---------------------------------------------------------------------------
// expandWithNeighbors
//
// Incorpora ParentChunks vizinhos (candidatos) ao cluster principal.
// Candidatos são ParentChunks do mesmo (documentId, n1Header) que não
// foram recuperados pelo retriever vetorial.
//
// Regras:
//   - Nunca adiciona duplicatas (verifica por id).
//   - Respeita MAX_EXPANDED_PARENTS e MAX_EXPANDED_CHARS.
//   - Candidatos são adicionados na ordem em que chegam (ordem de inserção
//     no banco, controlada pelo chamador).
//   - Não altera a ordem dos parents já presentes no cluster.
// ---------------------------------------------------------------------------
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function contentSignature(row: ParentChunkRow): string {
  return `${row.document_id}|||${row.section_header}|||${normalizeWhitespace(row.content).slice(0, 200)}`;
}

function getCandidateProximityScore(
  existingParents: ParentChunkRow[],
  candidates: ParentChunkRow[],
  candidateIndex: number,
): number {
  const existingIndexes = new Set<number>();
  const candidateIds = new Map(candidates.map((row, idx) => [row.id, idx]));

  for (const parent of existingParents) {
    const idx = candidateIds.get(parent.id);
    if (idx !== undefined) existingIndexes.add(idx);
  }

  if (existingIndexes.size === 0) return MAX_NEIGHBOR_DISTANCE + 1;

  let minDistance = MAX_NEIGHBOR_DISTANCE + 1;
  for (const idx of existingIndexes) {
    const distance = Math.abs(candidateIndex - idx);
    if (distance < minDistance) minDistance = distance;
  }

  return Math.min(minDistance, MAX_NEIGHBOR_DISTANCE + 1);
}

function sortCandidatesByProximity(
  existingParents: ParentChunkRow[],
  candidates: ParentChunkRow[],
): ParentChunkRow[] {
  return [...candidates].map((candidate, index) => ({
    candidate,
    score: getCandidateProximityScore(existingParents, candidates, index),
    index,
  }))
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return a.index - b.index;
    })
    .map((entry) => entry.candidate);
}

export function expandWithNeighbors(
  existingParents: ParentChunkRow[],
  candidates:      ParentChunkRow[],
): ParentChunkRow[] {
  const seen      = new Set(existingParents.map(p => p.id));
  const seenSig   = new Set(existingParents.map(contentSignature));
  const result    = [...existingParents];
  let totalChars  = result.reduce((acc, p) => acc + p.content.length, 0);

  const orderedCandidates = sortCandidatesByProximity(existingParents, candidates);

  for (const candidate of orderedCandidates) {
    if (seen.has(candidate.id)) continue;
    const signature = contentSignature(candidate);
    if (seenSig.has(signature)) continue;
    if (result.length >= MAX_EXPANDED_PARENTS) break;
    if (totalChars + candidate.content.length > MAX_EXPANDED_CHARS) continue;

    seen.add(candidate.id);
    seenSig.add(signature);
    result.push(candidate);
    totalChars += candidate.content.length;
  }

  return result;
}

// ---------------------------------------------------------------------------
// flattenClusters
//
// Converte a lista de clusters em uma lista plana de ParentChunkRows,
// preservando a ordem dos clusters e, dentro de cada cluster, a ordem
// dos parents.
//
// Aplica deduplicação global (um parent pode aparecer em apenas um cluster)
// e respeita MAX_EXPANDED_PARENTS e MAX_EXPANDED_CHARS.
// ---------------------------------------------------------------------------
export function flattenClusters(clusters: RetrievalCluster[]): ParentChunkRow[] {
  const seen      = new Set<string>();
  const seenSig   = new Set<string>();
  const result:   ParentChunkRow[] = [];
  let totalChars  = 0;

  for (const cluster of clusters) {
    for (const row of cluster.parents) {
      const signature = contentSignature(row);
      if (seen.has(row.id) || seenSig.has(signature)) continue;
      if (result.length >= MAX_EXPANDED_PARENTS) break;
      if (totalChars + row.content.length > MAX_EXPANDED_CHARS) continue;

      seen.add(row.id);
      seenSig.add(signature);
      result.push(row);
      totalChars += row.content.length;
    }
    if (result.length >= MAX_EXPANDED_PARENTS) break;
  }

  return result;
}
