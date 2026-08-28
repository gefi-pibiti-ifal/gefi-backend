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
 * Elevado de 8 para 14 com a expansão descendente (caput + subitens de um
 * dispositivo enumerado ja passava de 8) e de 14 para 20 com as perguntas
 * transversais: uma consulta que atravessa corpo da norma + varios anexos +
 * contrato produz 5-7 clusters legitimos, e com 14 o flatten cortava os
 * clusters da cauda inteiros. A selecao round-robin do flatten garante um
 * representante por cluster antes de aprofundar; o teto de chars segue sendo
 * o freio real de orcamento.
 */
export const MAX_EXPANDED_PARENTS = 20;

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

/**
 * Dominancia entre HITs irmaos — precisao DENTRO de uma mesma familia
 * estrutural (mesmo item pai + mesmo nivel; ex.: 10.1/10.2/10.4/10.5 sob "10.").
 *
 * A busca vetorial pode devolver, dentro do MESMO grupo de irmaos, mais de um
 * HIT direto: nao so o dispositivo realmente pedido, mas tambem "modalidades"
 * vizinhas que compartilham vocabulario com a pergunta (mesmo titulo
 * generico da secao, mesmo preambulo injetado no contextual embedding, termos
 * incidentais em comum — ex.: um item sobre fiscalizacao por amostragem cujo
 * texto cita "qualquer mes" tambem ressoa com uma pergunta sobre rotina
 * MENSAL). Sem este ajuste, todo HIT vira PRINCIPAL com o mesmo peso do hit
 * mais forte, mesmo quando o proprio score do retriever ja indica que ele e
 * um "carona" fraco dentro da familia.
 *
 * O limiar e RELATIVO ao espalhamento (spread) de scores observado ENTRE OS
 * HITS desta recuperacao especifica — nunca um valor absoluto fixo. Se a
 * pergunta legitimamente abrange varias modalidades (todas com score
 * parecido), nenhuma e rebaixada: o mecanismo so age quando ha uma folga
 * clara entre o hit-ancora da familia e os demais. Deterministico, auditavel
 * e geral — usa apenas a arvore do documento (deriveSiblingPrefix, generico
 * para qualquer norma numerada) e o score vetorial ja calculado; nenhuma
 * regra por norma ou por dispositivo especifico.
 */
export const SIBLING_HIT_DOMINANCE_FRACTION = 0.3;

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
// `retrievedScopeHits`: mapa `${document_id}|||${n1_header}` -> nº de CHILD HITS
//   do retriever naquele escopo (nao expandidos). Contar CHILDS, e nao parents,
//   e essencial: um dispositivo longo (ex.: um artigo de lei com dezenas de
//   incisos) monopoliza o Top-K com varios childs que colapsam num unico
//   parent. Contando parents ele valeria "1" e perderia a dominancia para dois
//   artigos curtos e irrelevantes — foi exatamente assim que o Art. 75 da Lei
//   14.133, primeiro colocado do ranking com 6 dos 12 childs, foi podado de uma
//   consulta sobre os limites de dispensa que ele mesmo responde.
//
// `topScope`: escopo do hit de MELHOR score. Nunca e podado, aconteca o que
//   acontecer na contagem — o primeiro colocado da busca vetorial e a evidencia
//   mais forte que o sistema tem, e nenhuma heuristica de corroboracao pode
//   descarta-lo. Guarda de seguranca independente da contagem.
//
// Criterio de REMOCAO (assinatura real da contaminacao): um escopo estrangeiro
// fraco so e removido se o seu conteudo for QUASE-DUPLICATA de algum parent do
// escopo dominante presente no conjunto candidato. E essa a assinatura do
// boilerplate paralelo (a rotina do fiscal tecnico espelhando a do fiscal
// administrativo): texto redundante que nada acrescenta. Conteudo DIFERENTE
// vindo de outro anexo/secao e, em geral, complementar — perguntas transversais
// legitimamente atravessam corpo da norma + varios anexos + contrato. Medido no
// corpus real: conteudo transversal legitimo fica com containment 0.07–0.13
// contra o dominante; espelhos ficam acima de NEAR_DUPLICATE_CONTAINMENT.
// (Antes, a corroboracao por contagem sozinha removia dispositivos centrais:
// numa pergunta sobre pagamento direto de salarios, o Art. 65 da IN — fonte dos
// recursos e prazo de 15 dias — era podado por ter 1 hit contra 4 do anexo
// dominante, apesar de nao ter NADA redundante com ele.)
// ---------------------------------------------------------------------------

/**
 * Limiar de containment de tokens (fracao dos tokens do candidato presentes no
 * parent dominante) acima do qual o conteudo e tratado como duplicata
 * paralela. Calibrado no corpus: transversal legitimo <= ~0.13; espelho >= ~0.5.
 */
export const NEAR_DUPLICATE_CONTAINMENT = 0.6;

// Minimo de tokens para o containment ser estatisticamente significativo;
// abaixo disso, so a igualdade exata do texto normalizado conta como duplicata.
const NEAR_DUPLICATE_MIN_TOKENS = 8;

function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4),
  );
}

export function isNearDuplicateContent(candidate: string, reference: string): boolean {
  const normA = normalizeWhitespace(candidate);
  const normB = normalizeWhitespace(reference);
  if (normA === normB) return true;

  const ta = contentTokens(candidate);
  const tb = contentTokens(reference);
  if (ta.size < NEAR_DUPLICATE_MIN_TOKENS || tb.size < NEAR_DUPLICATE_MIN_TOKENS) return false;

  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / ta.size >= NEAR_DUPLICATE_CONTAINMENT;
}

export function pruneForeignAnexoContamination(
  parents:            ParentChunkRow[],
  retrievedScopeHits: Map<string, number>,
  topScope?:          string,
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

  const dominantRows = parents.filter(
    (row) => row.document_id === dominantDoc && getN1Header(row) === dominantN1,
  );

  return parents.filter((row) => {
    const n1    = getN1Header(row);
    const scope = `${row.document_id}|||${n1}`;
    if (scope === topScope) return true; // melhor hit da busca: imune
    const sameDocForeignAnexo = row.document_id === dominantDoc && n1 !== dominantN1;
    if (!sameDocForeignAnexo) return true; // dominante e outros documentos permanecem
    if ((retrievedScopeHits.get(scope) ?? 0) >= MIN_FOREIGN_ANEXO_HITS) return true;
    // Escopo fraco: remove apenas se REDUNDANTE com o dominante — conteudo
    // distinto e complementar e permanece (perguntas transversais).
    return !dominantRows.some((dom) => isNearDuplicateContent(row.content, dom.content));
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
// Excecao (dominancia entre HITs irmaos): quando o CONJUNTO CANDIDATO contem
// mais de um HIT direto dentro da MESMA familia estrutural (mesmo item pai +
// mesmo nivel — ver deriveSiblingPrefix) e um deles tem score muito mais fraco
// que o ancora da familia (ver SIBLING_HIT_DOMINANCE_FRACTION), esse HIT fraco
// e tratado como se fosse SIBLING — o proprio retriever ja sinalizou, pelo
// score, que ele e um "carona" e nao o dispositivo pedido. Continua central
// quem tem DESCENDANT (completa o MESMO dispositivo, nunca compete com irmaos).
//
// Limite conhecido: nao distingue papeis ORTOGONAIS a estrutura quando os
// scores dos HITs irmaos ficam proximos (dentro do limiar) — ex.: um hit direto
// que e excecao/variante mas com score parecido ao do hit central permanece
// PRINCIPAL. Esse residuo semantico, quando nao ha folga de score que o
// evidencie, so uma camada de intencao (LLM/classificador) resolveria.
// ---------------------------------------------------------------------------
export type Provenance = 'HIT' | 'DESCENDANT' | 'SIBLING';

export interface RankedParent {
  row:        ParentChunkRow;
  role:       'PRINCIPAL' | 'COMPLEMENTAR';
  provenance: Provenance[];
}

function siblingFamilyKey(row: ParentChunkRow, parentPrefix: string, level: number): string {
  return `${row.document_id}|||${getN1Header(row)}|||${parentPrefix}|||${level}`;
}

/**
 * Identifica HITs "dominados": irmaos estruturais de um HIT muito mais forte
 * dentro do MESMO grupo (mesmo item pai + mesmo nivel), cuja folga de score em
 * relacao ao ancora da familia excede SIBLING_HIT_DOMINANCE_FRACTION do
 * espalhamento observado entre os HITs desta recuperacao. Ver o comentario da
 * constante para o raciocinio completo.
 *
 * So considera rows com proveniencia HIT "pura" (sem DESCENDANT): um
 * descendente completa o MESMO dispositivo do seu hit-pai e nunca deve ser
 * rebaixado por este mecanismo, que trata apenas de competicao ENTRE
 * dispositivos irmaos — nunca entre um dispositivo e suas proprias partes.
 */
function findDominatedSiblingHits(
  parents:         ParentChunkRow[],
  provenanceById:  Map<string, Set<Provenance>>,
  scoreByParentId: Map<string, number>,
): Set<string> {
  const dominated = new Set<string>();
  if (scoreByParentId.size === 0) return dominated;

  const hitRows = parents.filter((row) => {
    const prov = provenanceById.get(row.id);
    return !!prov?.has('HIT') && !prov.has('DESCENDANT');
  });

  const hitScores = hitRows
    .map((row) => scoreByParentId.get(row.id))
    .filter((s): s is number => s !== undefined && Number.isFinite(s));
  if (hitScores.length < 2) return dominated; // sem 2+ scores nao ha spread para calibrar

  const spread = Math.max(...hitScores) - Math.min(...hitScores);
  if (spread <= 0) return dominated;

  const familyBestScore = new Map<string, number>();
  for (const row of hitRows) {
    const score = scoreByParentId.get(row.id);
    if (score === undefined) continue;
    const prefixInfo = deriveSiblingPrefix(getN2Header(row));
    if (!prefixInfo) continue; // itens de nivel 1 nao tem familia de irmaos
    const key = siblingFamilyKey(row, prefixInfo.parentPrefix, prefixInfo.level);
    const prevBest = familyBestScore.get(key);
    if (prevBest === undefined || score < prevBest) familyBestScore.set(key, score);
  }

  const threshold = SIBLING_HIT_DOMINANCE_FRACTION * spread;
  for (const row of hitRows) {
    const score = scoreByParentId.get(row.id);
    if (score === undefined) continue;
    const prefixInfo = deriveSiblingPrefix(getN2Header(row));
    if (!prefixInfo) continue;
    const key = siblingFamilyKey(row, prefixInfo.parentPrefix, prefixInfo.level);
    const best = familyBestScore.get(key);
    if (best !== undefined && score - best > threshold) dominated.add(row.id);
  }

  return dominated;
}

export function rankByProvenance(
  parents:         ParentChunkRow[],
  provenanceById:  Map<string, Set<Provenance>>,
  scoreByParentId: Map<string, number> = new Map(),
): RankedParent[] {
  const dominatedHitIds = findDominatedSiblingHits(parents, provenanceById, scoreByParentId);

  const classified: RankedParent[] = parents.map((row) => {
    const prov = provenanceById.get(row.id);
    // Sem proveniencia conhecida: conservador — mantem como central (nao rebaixa
    // o que nao conseguimos explicar, preservando recall).
    const isCentral =
      (!prov || prov.has('HIT') || prov.has('DESCENDANT')) &&
      !dominatedHitIds.has(row.id);
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
// Converte a lista de clusters em uma lista plana de ParentChunkRows.
//
// SELECAO round-robin, EMISSAO por cluster: quando os tetos apertam, a escolha
// de quem sobrevive percorre os clusters em rodadas (um parent de cada cluster
// por rodada, na ordem do boost) — assim TODA faceta recuperada garante ao
// menos um representante antes de qualquer cluster aprofundar. A selecao
// cluster-major anterior gastava o teto inteiro nos primeiros clusters e
// cortava os da cauda por completo, exatamente os escopos complementares de
// uma pergunta transversal (corpo da norma + anexos + contrato).
// A EMISSAO final preserva a ordem por cluster (e, dentro dele, a ordem
// estrutural ja estabelecida), mantendo a leitura continua de cada dispositivo
// no prompt.
//
// Aplica deduplicação global (por id e por assinatura de conteudo) e respeita
// MAX_EXPANDED_PARENTS e MAX_EXPANDED_CHARS.
//
// `selectionPriority` (opcional): ordena a FILA de cada cluster para a
// selecao (menor = mais prioritario), sem alterar a ordem de emissao. Uso: dar
// precedencia a HITs sobre irmaos de expansao quando o teto aperta — sem isso,
// um irmao trazido por vizinhanca podia consumir a vaga de um acerto direto do
// retriever no mesmo cluster (a clausula 12.8, hit direto, chegou a ser
// cortada enquanto os irmaos 12.3/12.6 entravam). A ordenacao e estavel:
// dentro da mesma prioridade permanece a ordem estrutural.
// ---------------------------------------------------------------------------
export function flattenClusters(
  clusters: RetrievalCluster[],
  selectionPriority?: (row: ParentChunkRow) => number,
): ParentChunkRow[] {
  const seen      = new Set<string>();
  const seenSig   = new Set<string>();
  const selected  = new Set<string>();
  let totalChars  = 0;
  let totalCount  = 0;

  // Fila por cluster, consumida em rodadas. A fila pode ser reordenada por
  // prioridade de selecao; a emissao final ignora essa ordem.
  const queues = clusters.map((c) => ({
    rows: selectionPriority
      ? [...c.parents].sort((a, b) => selectionPriority(a) - selectionPriority(b))
      : c.parents,
    next: 0,
  }));

  let progressed = true;
  while (progressed && totalCount < MAX_EXPANDED_PARENTS) {
    progressed = false;
    for (const queue of queues) {
      if (totalCount >= MAX_EXPANDED_PARENTS) break;
      // Avanca na fila do cluster ate conseguir selecionar UM parent valido
      // nesta rodada (pulando duplicatas e candidatos acima do orcamento).
      while (queue.next < queue.rows.length) {
        const row = queue.rows[queue.next++];
        const signature = contentSignature(row);
        if (seen.has(row.id) || seenSig.has(signature)) continue;
        seen.add(row.id);
        seenSig.add(signature);
        if (totalChars + row.content.length > MAX_EXPANDED_CHARS) continue;
        selected.add(row.id);
        totalChars += row.content.length;
        totalCount++;
        progressed = true;
        break;
      }
    }
  }

  // Emissao por cluster, filtrada aos selecionados — grupos continuam contiguos.
  const result: ParentChunkRow[] = [];
  for (const cluster of clusters) {
    for (const row of cluster.parents) {
      if (selected.has(row.id)) {
        selected.delete(row.id); // dedup de emissao caso o mesmo id aparecesse em 2 clusters
        result.push(row);
      }
    }
  }
  return result;
}
