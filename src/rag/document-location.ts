// ---------------------------------------------------------------------------
// document-location.ts
//
// Camada de LOCALIZACAO do pipeline RAG: responde "onde, dentro do documento
// original, esta o texto que fundamentou a resposta?".
//
// Todo o mapeamento e DETERMINISTICO — indexOf sobre o proprio texto, nunca
// heuristica semantica nem chamada ao LLM. Quando um trecho nao pode ser
// localizado com certeza, as funcoes retornam null: a fonte continua valida
// como referencia ao documento, apenas sem localizacao (nunca inventada).
//
// Sistema de coordenadas
// ----------------------
// Todas as posicoes persistidas (char_start / char_end / page_map) sao offsets
// no TEXTO LIMPO (saida de cleanExtractedText, guardado em
// NormativeDocument.indexed_content) — nao no PDF nem no texto cru. E esse o
// texto que a ingestao dividiu em ParentChunks, entao e o unico sistema de
// coordenadas em que as posicoes sao verificaveis.
//
// O casamento e feito sobre uma forma NORMALIZADA (whitespace colapsado),
// porque a extracao de PDF varia livremente entre espaco, tab e quebra de
// linha, e o splitter re-junta linhas com '\n'. buildNormalizedIndex mantem,
// para cada caractere normalizado, o indice de origem — assim o resultado da
// busca volta exato para as coordenadas do texto limpo.
// ---------------------------------------------------------------------------

/**
 * Texto normalizado (whitespace colapsado, extremidades aparadas) + o indice
 * de origem de cada caractere no texto de partida.
 *
 * `normalized[i]` corresponde a `source[offsets[i]]`.
 */
export interface NormalizedIndex {
  normalized: string;
  offsets: number[];
}

/** Intervalo de caracteres [start, end) no texto de origem. */
export interface CharRange {
  start: number;
  end: number;
}

/**
 * Faixa de paginas coberta por um intervalo do texto limpo.
 * `page_start` e `page_end` sao numeros de pagina do PDF (1-based) e podem ser
 * iguais quando o intervalo cabe numa unica pagina.
 */
export interface PageSpan {
  page_start: number;
  page_end: number;
}

/** Uma faixa do texto limpo atribuida a uma faixa de paginas do PDF. */
export interface PageMapEntry extends PageSpan, CharRange {}

/** Pagina extraida do PDF, antes de qualquer limpeza. */
export interface PageInput {
  page: number;
  text: string;
}

// Tamanhos de anchor tentados quando o texto integro da pagina nao casa —
// diferencas residuais de limpeza no fim da pagina nao devem custar a
// localizacao dela. Em ordem decrescente: quanto maior o anchor, menor a
// chance de casar no lugar errado.
const PAGE_ANCHOR_SIZES = [240, 120, 60, 30] as const;

// ---------------------------------------------------------------------------
// buildNormalizedIndex
//
// Equivalente a `text.replace(/\s+/g, ' ').trim()` (normalizeForSearch), porem
// preservando a origem de cada caractere. Uma sequencia de whitespace vira UM
// espaco cujo offset de origem e o do PRIMEIRO caractere da sequencia.
// ---------------------------------------------------------------------------
export function buildNormalizedIndex(text: string): NormalizedIndex {
  const chars: string[] = [];
  const offsets: number[] = [];

  let i = 0;
  while (i < text.length && /\s/.test(text[i])) i++; // trim inicial

  let pendingSpaceAt = -1;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (pendingSpaceAt === -1) pendingSpaceAt = i;
      continue;
    }
    if (pendingSpaceAt !== -1) {
      chars.push(' ');
      offsets.push(pendingSpaceAt);
      pendingSpaceAt = -1;
    }
    chars.push(ch);
    offsets.push(i);
  }
  // whitespace final nunca e emitido — equivale ao trim final

  return { normalized: chars.join(''), offsets };
}

/**
 * Converte um intervalo [start, end) em coordenadas NORMALIZADAS para as
 * coordenadas do texto de origem. Retorna null para intervalos vazios ou fora
 * dos limites — nada e extrapolado.
 */
export function toSourceRange(
  index: NormalizedIndex,
  normStart: number,
  normEnd: number,
): CharRange | null {
  const { offsets } = index;
  if (offsets.length === 0) return null;
  if (normStart < 0 || normEnd <= normStart) return null;
  if (normStart >= offsets.length) return null;

  const lastIncluded = Math.min(normEnd, offsets.length) - 1;
  return { start: offsets[normStart], end: offsets[lastIncluded] + 1 };
}

/**
 * Converte um offset do texto de origem para a coordenada normalizada mais
 * proxima a direita (primeiro caractere normalizado cuja origem e >= offset).
 * Offsets dentro de uma sequencia de whitespace caem no proximo caractere
 * visivel — o comportamento desejado para bordas de janela.
 */
export function toNormalizedOffset(
  index: NormalizedIndex,
  sourceOffset: number,
): number {
  const { offsets } = index;
  let lo = 0;
  let hi = offsets.length; // resposta em [0, length]
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < sourceOffset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// locateSequentialSegments
//
// Localiza, EM ORDEM, uma lista de segmentos dentro do texto normalizado.
// O cursor so avanca: segmentos identicos (comuns em documentos normativos —
// "Paragrafo unico." repetido) sao resolvidos na ordem em que aparecem, sem
// que o segundo case na posicao do primeiro.
//
// Um segmento que nao casa a partir do cursor retorna null e NAO move o
// cursor: um unico trecho irreconhecivel nao desalinha os seguintes.
// ---------------------------------------------------------------------------
export function locateSequentialSegments(
  index: NormalizedIndex,
  segments: string[],
): Array<CharRange | null> {
  const result: Array<CharRange | null> = [];
  let cursor = 0;

  for (const segment of segments) {
    const needle = normalizeSegment(segment);
    if (!needle) {
      result.push(null);
      continue;
    }
    const at = index.normalized.indexOf(needle, cursor);
    if (at === -1) {
      result.push(null);
      continue;
    }
    result.push(toSourceRange(index, at, at + needle.length));
    cursor = at + needle.length;
  }

  return result;
}

function normalizeSegment(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// buildPageMap
//
// Alinha as paginas do PDF (ja limpas com a MESMA funcao de limpeza aplicada
// ao documento inteiro) contra o texto limpo completo, produzindo faixas de
// caracteres por pagina.
//
// Paginas que nao puderem ser ancoradas NAO sao inventadas: elas sao
// absorvidas pela faixa da pagina anterior, que entao passa a declarar um
// INTERVALO ("entre as paginas 4 e 5") em vez de uma pagina exata. E uma
// resposta menos precisa, nunca uma resposta errada.
// ---------------------------------------------------------------------------
export function buildPageMap(
  index: NormalizedIndex,
  cleanedPages: PageInput[],
): PageMapEntry[] {
  if (cleanedPages.length === 0 || index.normalized.length === 0) return [];

  const anchors: Array<{ page: number; normStart: number }> = [];
  let cursor = 0;

  for (const page of cleanedPages) {
    const needle = normalizeSegment(page.text);
    if (!needle) continue;

    let at = index.normalized.indexOf(needle, cursor);
    let matchedLength = needle.length;

    if (at === -1) {
      for (const size of PAGE_ANCHOR_SIZES) {
        if (needle.length < size) continue;
        const anchor = needle.slice(0, size);
        at = index.normalized.indexOf(anchor, cursor);
        if (at !== -1) {
          matchedLength = anchor.length;
          break;
        }
      }
    }
    if (at === -1) continue; // pagina nao ancorada: absorvida pela anterior

    anchors.push({ page: page.page, normStart: at });
    cursor = at + matchedLength;
  }

  if (anchors.length === 0) return [];

  const lastPage = cleanedPages[cleanedPages.length - 1].page;
  const entries: PageMapEntry[] = [];

  for (let i = 0; i < anchors.length; i++) {
    const normStart = i === 0 ? 0 : anchors[i].normStart; // texto antes da 1a ancora pertence a ela
    const normEnd =
      i + 1 < anchors.length ? anchors[i + 1].normStart : index.normalized.length;
    if (normEnd <= normStart) continue;

    const range = toSourceRange(index, normStart, normEnd);
    if (!range) continue;

    // Sem a proxima ancora, a faixa vai ate a ultima pagina conhecida; com
    // ela, ate a pagina imediatamente anterior a proxima ancorada.
    const nextPage = i + 1 < anchors.length ? anchors[i + 1].page - 1 : lastPage;

    entries.push({
      page_start: anchors[i].page,
      page_end: Math.max(anchors[i].page, nextPage),
      start: range.start,
      end: range.end,
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// resolvePageSpan
//
// Traduz um intervalo de caracteres do texto limpo na faixa de paginas que ele
// atravessa. Retorna null quando nao ha mapa ou o intervalo cai fora dele —
// a fonte segue utilizavel, apenas sem pagina.
// ---------------------------------------------------------------------------
export function resolvePageSpan(
  pageMap: PageMapEntry[],
  range: CharRange | null | undefined,
): PageSpan | null {
  if (!pageMap?.length || !range) return null;

  const first = findEntry(pageMap, range.start);
  const last = findEntry(pageMap, Math.max(range.start, range.end - 1));
  if (!first && !last) return null;

  const startEntry = first ?? last!;
  const endEntry = last ?? first!;
  return {
    page_start: startEntry.page_start,
    page_end: Math.max(startEntry.page_start, endEntry.page_end),
  };
}

function findEntry(pageMap: PageMapEntry[], offset: number): PageMapEntry | null {
  for (const entry of pageMap) {
    if (offset >= entry.start && offset < entry.end) return entry;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Partes de um ParentChunk
//
// Um ParentChunk e formado por uma ou mais PARTES emitidas pelo splitter e
// unidas por '\n'. Elas quase sempre sao uma so, mas grupos com a mesma chave
// estrutural (ex.: duas secoes sob o mesmo anexo, ambas sem item) sao
// consolidados num unico parent e ficam separados no documento pelo cabecalho
// que o splitter consome. Guardando o intervalo de cada parte, um offset
// interno do parent (a janela de um child chunk) volta exato para as
// coordenadas do documento — sem depender do parent ser contiguo.
// ---------------------------------------------------------------------------
export interface LocatedPart {
  /** Intervalo da parte dentro do conteudo do parent. */
  parentStart: number;
  parentEnd: number;
  /** Intervalo da parte no texto limpo do documento; null se nao localizada. */
  range: CharRange | null;
  /** Indice normalizado do texto da propria parte. */
  index: NormalizedIndex;
}

export function buildLocatedParts(
  parts: string[],
  ranges: Array<CharRange | null>,
  joiner = '\n',
): LocatedPart[] {
  const located: LocatedPart[] = [];
  let cursor = 0;
  parts.forEach((part, i) => {
    located.push({
      parentStart: cursor,
      parentEnd: cursor + part.length,
      range: ranges[i] ?? null,
      index: buildNormalizedIndex(part),
    });
    cursor += part.length + joiner.length;
  });
  return located;
}

/**
 * Traduz uma janela [parentStart, parentEnd) do conteudo de um ParentChunk
 * para as coordenadas do texto limpo do documento. Retorna null quando a parte
 * envolvida nao foi localizada — nunca aproxima.
 */
export function locateInDocument(
  docIndex: NormalizedIndex,
  parts: LocatedPart[],
  parentStart: number,
  parentEnd: number,
): CharRange | null {
  if (parts.length === 0 || parentEnd <= parentStart) return null;

  const startPart = parts.find((p) => parentStart < p.parentEnd) ?? null;
  const endPart =
    [...parts].reverse().find((p) => parentEnd > p.parentStart) ?? null;
  if (!startPart?.range || !endPart?.range) return null;

  const localStart = Math.max(0, parentStart - startPart.parentStart);
  const localEnd = Math.min(
    endPart.parentEnd - endPart.parentStart,
    Math.max(0, parentEnd - endPart.parentStart),
  );

  const normStart =
    toNormalizedOffset(docIndex, startPart.range.start) +
    toNormalizedOffset(startPart.index, localStart);
  const normEnd =
    toNormalizedOffset(docIndex, endPart.range.start) +
    toNormalizedOffset(endPart.index, localEnd);

  return toSourceRange(docIndex, normStart, normEnd);
}

/** Une varias faixas de pagina na faixa envolvente. */
export function mergePageSpans(
  spans: Array<PageSpan | null | undefined>,
): PageSpan | null {
  let start = Infinity;
  let end = -Infinity;
  for (const span of spans) {
    if (!span) continue;
    start = Math.min(start, span.page_start);
    end = Math.max(end, span.page_end);
  }
  return Number.isFinite(start) && Number.isFinite(end)
    ? { page_start: start, page_end: end }
    : null;
}

/** Une varios intervalos num unico intervalo envolvente. */
export function mergeRanges(
  ranges: Array<CharRange | null | undefined>,
): CharRange | null {
  let start = Infinity;
  let end = -Infinity;
  for (const range of ranges) {
    if (!range) continue;
    start = Math.min(start, range.start);
    end = Math.max(end, range.end);
  }
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
}

// ---------------------------------------------------------------------------
// Leitura tolerante das coordenadas gravadas em metadata (JSON)
//
// Documentos indexados ANTES desta funcionalidade nao tem esses campos; a
// leitura devolve null em vez de falhar — a fonte continua sendo apresentada
// normalmente, so que sem localizacao.
// ---------------------------------------------------------------------------
export function readCharRange(metadata: unknown): CharRange | null {
  const md = metadata as Record<string, unknown> | null | undefined;
  if (!md) return null;
  const start = readInt(md.char_start);
  const end = readInt(md.char_end);
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

export function readPageSpan(metadata: unknown): PageSpan | null {
  const md = metadata as Record<string, unknown> | null | undefined;
  if (!md) return null;
  const start = readInt(md.page_start);
  const end = readInt(md.page_end);
  if (start === null) return null;
  return { page_start: start, page_end: end === null ? start : Math.max(start, end) };
}

export function readPageMap(value: unknown): PageMapEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: PageMapEntry[] = [];
  for (const raw of value) {
    const item = raw as Record<string, unknown> | null;
    if (!item) continue;
    const pageStart = readInt(item.page_start);
    const pageEnd = readInt(item.page_end);
    const start = readInt(item.start);
    const end = readInt(item.end);
    if (pageStart === null || start === null || end === null || end <= start) continue;
    entries.push({
      page_start: pageStart,
      page_end: pageEnd === null ? pageStart : Math.max(pageStart, pageEnd),
      start,
      end,
    });
  }
  return entries;
}

function readInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}
