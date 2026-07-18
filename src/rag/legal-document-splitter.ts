// ---------------------------------------------------------------------------
// Regex de transição de estado — nível 1 (estrutura do documento)
// Cada padrão ancora no início da linha (^)
// ---------------------------------------------------------------------------
const RE_ANEXO    = /^ANEXO\s+([A-Z0-9][A-Z0-9\-]*)/i;
const RE_CAPITULO = /^CAP[ÍI]TULO\s+([IVXLCDM]+)/i;
const RE_SECAO    = /^Se[çc][ãa]o\s+([IVXLCDM]+)/i;
const RE_SUBSECAO = /^Subse[çc][ãa]o\s+([IVXLCDM]+)/i;
const RE_TITULO   = /^T[ÍI]TULO\s+([IVXLCDM]+)/i;
const RE_LIVRO    = /^LIVRO\s+([IVXLCDM]+)/i;

// ---------------------------------------------------------------------------
// Regex auxiliares — apenas localizam/extraem, nunca decidem
// ---------------------------------------------------------------------------

// Prefixo multi-nível:  "10.2.", "3.5", "2.1.", "10.2.1."
const RE_ITEM_PREFIX_MULTI  = /^(\d+\.\d+(?:\.\d+)*\.?)/;
// Prefixo nível único:  "1.", "2."  — ponto obrigatório para não confundir
// com números soltos no meio de frases ("item 3 do contrato")
const RE_ITEM_PREFIX_SINGLE = /^(\d+\.)/;
// Prefixo de artigo: "Art. 10", "Art.10°", "Art. 66-A", "Art 47", "Art. 5º"
const RE_ARTIGO_PREFIX = /^Art\.?\s*\d+[\-\w°º]*/i;

// Referências legislativas que NUNCA são cabeçalhos estruturais.
// Padrões que começam com número seguido de vírgula, barra, "de", "nº", "n°"
// ou que são precedidos por palavras como Lei, Decreto, Portaria, etc.
const RE_LEGISLATIVE_REF_LINE = [
  /^\d[\d.]*,/,                          // "8.666, de 1993"  — vírgula após número
  /^\d[\d.]*(\/)\d/,                     // "14.133/2021"     — barra após número
  /^\d[\d.]*\s+de\s+\d/i,               // "8.666 de 1993"   — "de" + ano
  /^(Lei|Decreto|Portaria|Resolução|Instrução|Medida|Emenda|Súmula)\b/i,
  /^n[°º]\s*\d/i,                        // "nº 8.666"
];

// ---------------------------------------------------------------------------
// ParsedItem
//
// Estrutura produzida por parseItemNumber(). Evita re-parse da mesma string
// em múltiplas funções.
// ---------------------------------------------------------------------------
export interface ParsedItem {
  raw:     string;    // prefixo original, ex: "10.2."
  numbers: number[]; // componentes numéricos, ex: [10, 2]
  level:   number;   // profundidade, ex: 2
}

// ---------------------------------------------------------------------------
// parseItemNumber
//
// Converte um prefixo numérico em ParsedItem.
// Nunca decide se o item é estrutural — apenas interpreta.
//
//   "10.2."   → { raw: "10.2.",  numbers: [10, 2],    level: 2 }
//   "3.5.1."  → { raw: "3.5.1.", numbers: [3, 5, 1],  level: 3 }
//   "1."      → { raw: "1.",     numbers: [1],         level: 1 }
//   "14.133"  → { raw: "14.133", numbers: [14, 133],   level: 2 }
//
// Retorna null para entradas inválidas.
// ---------------------------------------------------------------------------
export function parseItemNumber(header: string): ParsedItem | null {
  if (!header) return null;
  const clean = header.replace(/\.$/, '');
  const parts = clean.split('.');
  const nums  = parts.map(Number);
  if (nums.some(isNaN) || nums.length < 1 || nums[0] === 0) return null;
  return { raw: header, numbers: nums, level: nums.length };
}

// ---------------------------------------------------------------------------
// isValidTitleSuffix
//
// Valida POSITIVAMENTE o texto após o prefixo numérico.
// Pergunta: "isso parece o início de um título?"
//
// Aceita:  " Fiscalização mensal" | "Fiscalização" | ".Fiscalização"
//          "No caso de empresas"  | " Das sanções"  | " Do pagamento"
//
// Rejeita: ", de 1993" | "/2021" | " de 1993" | " nº 8.666" | "12345"
// ---------------------------------------------------------------------------
const RE_TITLE_START = /^[.\s]*[A-Za-zÀ-ú]/;

const RE_LEGISLATIVE_CONTINUATION = [
  /^[.\s]*de\s+\d/i,    // "de 1993", "de 2021"
  /^[.\s]*n[°º]\s*\d/i, // "nº 8.666", "n° 14.133"
];

export function isValidTitleSuffix(afterPrefix: string): boolean {
  if (!afterPrefix) return false;
  const first = afterPrefix.trimStart()[0];
  if (first === ',' || first === '/' || first === undefined) return false;
  if (!RE_TITLE_START.test(afterPrefix)) return false;
  for (const re of RE_LEGISLATIVE_CONTINUATION) {
    if (re.test(afterPrefix)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// looksLikeHeading
//
// Complementa isValidTitleSuffix com reconhecimento de padrões estruturais
// específicos de documentos normativos brasileiros.
//
// Aceita explicitamente:
//   - Palavras que iniciam títulos de seções (Fiscalização, Avaliação, ...)
//   - Marcadores estruturais (§, Parágrafo único, Inciso, Alínea)
//   - Numerais romanos isolados (I, II, III, IV, V, ...)
//   - Cabeçalhos de nível 1 (CAPÍTULO, SEÇÃO, SUBSEÇÃO, ANEXO)
//
// Esta função é chamada sobre o sufixo (texto após o prefixo numérico),
// já validado por isValidTitleSuffix. Ela adiciona uma segunda camada de
// confirmação para casos ambíguos.
// ---------------------------------------------------------------------------
const RE_STRUCTURAL_MARKERS = [
  /^[.\s]*[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÇ][a-záéíóúâêîôûãõç]/,  // Palavra com inicial maiúscula seguida de minúscula
  /^[.\s]*[a-záéíóúâêîôûãõç]{3,}/,                  // Palavra minúscula com 3+ letras (preposições: "das", "do", "no")
  /^[.\s]*§/,                                         // Parágrafo (§)
  /^[.\s]*(I{1,3}|IV|VI{0,3}|IX|X{1,3})\b/,         // Numerais romanos I–XIII
  /^[.\s]*Par[aá]grafo\s+[uú]nico/i,                 // "Parágrafo único"
  /^[.\s]*Inciso\b/i,                                 // "Inciso"
  /^[.\s]*Al[ií]nea\b/i,                              // "Alínea"
  /^[.\s]*(CAP[ÍI]TULO|SE[ÇC][ÃA]O|SUBSE[ÇC][ÃA]O|ANEXO|T[ÍI]TULO|LIVRO)\b/i,
];

export function looksLikeHeading(suffix: string): boolean {
  if (!suffix) return false;
  return RE_STRUCTURAL_MARKERS.some(re => re.test(suffix));
}

// ---------------------------------------------------------------------------
// isSequentialItem
//
// Decide se a transição de `current` para `candidate` é numericamente
// plausível. Bloqueia apenas retrocessos absurdos — não exige sequência
// estrita (aceita saltos de irmão como 10.2 → 10.5).
//
// Aceita:
//   10.2 → 10.3    próximo irmão
//   10.2 → 10.5    salto de irmão (seções podem ser omitidas no documento)
//   10.2 → 10.2.1  primeiro filho
//   10.5 → 11.1    nova seção
//   3.5  → 4.1     reinício de seção
//   1    → 2       nível único sequencial
//   1    → 3       nível único com salto
//   1    → 1.1     nível único → filho
//
// Rejeita:
//   10.2 → 8.666   retrocesso de seção (8 < 10)
//   10.2 → 14.133  salto de seção absurdo (14 > 10+3)
//   5.1  → 1.2     retrocesso de seção
//   3.5  → 999.999 salto impossível
//   10.2 → 10.1    retrocesso de item
//   2    → 1       retrocesso de nível único
//
// Se `current` for vazio ou não-numérico, aceita qualquer candidato.
// ---------------------------------------------------------------------------

// Limiar máximo de salto permitido no componente principal (ex: 10 → 13 ok, 10 → 50 não)
export const MAX_MAJOR_JUMP = 20;
// Segundo componente >= este valor indica número de lei (8.666, 14.133, 10.520)
// e nunca é um item estrutural de documento
export const MAX_MINOR_COMPONENT = 99;

export function isSequentialItem(current: string, candidate: string): boolean {
  const cand = parseItemNumber(candidate);
  if (!cand) return false;

  if (!current) return true;

  const curr = parseItemNumber(current);
  if (!curr) return true; // estado não-numérico (ex: "Art. 5"): aceita qualquer item

  const cn = cand.numbers;
  const cr = curr.numbers;

  // --- Candidato de nível único ---
  // Aceita tanto nível único → nível único quanto multi-nível → nível único,
  // desde que haja avanço numérico no componente principal.
  // Ex: 10.2.1. → 11.  (cn[0]=11 > cr[0]=10) ✓
  //     10.2.1. →  9.  (cn[0]=9  < cr[0]=10) ✗
  if (cn.length === 1) {
    return cn[0] > cr[0];
  }
  // Estado de nível único, candidato multi-nível:
  //   - filho direto: cn[0] === cr[0]  (ex: 10. → 10.1, 3. → 3.1)
  //   - novo bloco:   cn[0] >  cr[0]  (ex: 1.  → 2.1,  9. → 10.1)
  if (cr.length === 1) return cn[0] >= cr[0];

  const [cMaj, cMin] = cr;
  const [nMaj, nMin] = cn;

  // Filho direto: prefixo do pai presente, último componente = 1
  if (cn.length === cr.length + 1) {
    const parentMatches = cr.every((v, i) => cn[i] === v);
    return parentMatches && cn[cn.length - 1] === 1;
  }

  // Mesmo nível de dois componentes
  if (cn.length === 2 && cr.length === 2) {
    if (nMin > MAX_MINOR_COMPONENT) return false;           // segundo componente de lei (ex: 8.666)
    if (nMaj < cMaj) return false;                          // retrocesso de seção
    if (nMaj > cMaj + MAX_MAJOR_JUMP) return false;         // salto absurdo
    if (nMaj === cMaj) return nMin > cMin;                  // mesmo bloco, avança
    return true;                                            // novo bloco (nMaj > cMaj)
  }

  // Subindo de nível: candidato mais raso que o estado atual
  if (cn.length < cr.length && cn.length === 2) {
    if (nMin > MAX_MINOR_COMPONENT) return false;           // segundo componente de lei
    if (nMaj < cMaj) return false;
    if (nMaj > cMaj + MAX_MAJOR_JUMP) return false;
    if (nMaj === cMaj) return nMin > cMin;
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// isLegislativeReferenceLine
//
// Guard de pré-filtragem: retorna true para linhas que são claramente
// referências legislativas e NUNCA devem ser tratadas como cabeçalhos.
//
// Exemplos bloqueados:
//   "8.666, de 1993."        — número de lei com vírgula
//   "14.133/2021"            — número de lei com barra
//   "8.666 de 1993"          — número de lei com "de"
//   "Lei nº 8.666"           — linha começando com "Lei"
//   "nº 8.666"               — linha começando com "nº"
//
// Chamada ANTES de isStructuralItem para evitar que essas linhas
// sequer cheguem às guards internas.
// ---------------------------------------------------------------------------
export function isLegislativeReferenceLine(line: string): boolean {
  return RE_LEGISLATIVE_REF_LINE.some(re => re.test(line));
}

// ---------------------------------------------------------------------------
// isStructuralItem
//
// Único ponto de decisão da máquina de estados.
// Combina: formato da linha + validação do sufixo + coerência com contexto.
//
// Fluxo:
//   0. Referência legislativa?    → false  (guard explícita, antes de tudo)
//   1. Artigo?                    → true   (nunca são referências no início de linha)
//   2. Prefixo numérico presente? → false se ausente
//   3. Sufixo parece título?      → false se não (isValidTitleSuffix)
//   4. Sufixo tem marcadores?     → false se não (looksLikeHeading)
//   5. Transição coerente?        → false se incompatível (isSequentialItem)
//   → true
//
// Se retornar false, a linha é acumulada no buffer atual — sem perda de conteúdo.
// ---------------------------------------------------------------------------
export function isStructuralItem(line: string, currentArtigoItem = ''): boolean {
  // Ramo 0: guard explícita contra referências legislativas
  if (isLegislativeReferenceLine(line)) return false;

  // Ramo 1: Artigo
  if (RE_ARTIGO_PREFIX.test(line)) return true;

  // Ramo 2: Item multi-nível (N.N, N.N.N, ...)
  const multiMatch = line.match(RE_ITEM_PREFIX_MULTI);
  if (multiMatch) {
    const prefix      = multiMatch[0];
    const afterPrefix = line.slice(prefix.length);
    if (!isValidTitleSuffix(afterPrefix)) return false;
    if (!looksLikeHeading(afterPrefix))   return false;
    if (!isSequentialItem(currentArtigoItem, prefix)) return false;
    return true;
  }

  // Ramo 3: Item de nível único (N.) — ponto obrigatório
  const singleMatch = line.match(RE_ITEM_PREFIX_SINGLE);
  if (singleMatch) {
    const prefix      = singleMatch[0];
    const afterPrefix = line.slice(prefix.length);
    if (!isValidTitleSuffix(afterPrefix)) return false;
    if (!looksLikeHeading(afterPrefix))   return false;
    if (!isSequentialItem(currentArtigoItem, prefix)) return false;
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// extractItemHeader
//
// Extrai o header canônico. Chamado apenas após isStructuralItem() = true.
// Não toma decisões.
// ---------------------------------------------------------------------------
export function extractItemHeader(line: string): string {
  if (RE_ARTIGO_PREFIX.test(line)) return line.match(RE_ARTIGO_PREFIX)![0];
  const multi = line.match(RE_ITEM_PREFIX_MULTI);
  if (multi) return multi[0];
  return line.match(RE_ITEM_PREFIX_SINGLE)![0];
}

// ---------------------------------------------------------------------------
// Splitter — máquina de estados hierárquica
// ---------------------------------------------------------------------------
export const CHILD_CHUNK_SIZE    = 600;
export const CHILD_CHUNK_OVERLAP = 80;

export interface HierarchicalChunk {
  content: string;
  metadata: {
    n1_header: string;
    n2_header: string;
  };
}

function splitIntoChildChunks(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + CHILD_CHUNK_SIZE));
    start += CHILD_CHUNK_SIZE - CHILD_CHUNK_OVERLAP;
  }
  return chunks;
}

/**
 * Máquina de estados hierárquica para documentos normativos brasileiros.
 *
 * Estados rastreados:
 *   currentAnexo      — ex: "ANEXO VIII-B"
 *   currentCapitulo   — ex: "CAPÍTULO III"
 *   currentSecao      — ex: "Seção I"
 *   currentArtigoItem — ex: "Art. 39" | "10.2." | "1."
 *
 * Suporte a cabeçalhos quebrados em múltiplas linhas:
 *   Se uma linha contém apenas um prefixo numérico (ex: "10.2.") sem sufixo,
 *   ela é armazenada em `pendingPrefix`. A linha seguinte é testada como
 *   sufixo. Se parecer um título, as duas linhas são tratadas como um único
 *   cabeçalho. Caso contrário, ambas são acumuladas no buffer.
 *
 * Mapeamento para HierarchicalChunk:
 *   n1_header ← estado de nível-1 mais específico (Anexo > Seção > Capítulo)
 *   n2_header ← currentArtigoItem
 */
export function splitLegalDocument(cleanedText: string): HierarchicalChunk[] {
  const lines  = cleanedText.split('\n');
  const result: HierarchicalChunk[] = [];

  let currentAnexo      = '';
  let currentCapitulo   = '';
  let currentSecao      = '';
  let currentArtigoItem = '';
  let buffer            = '';
  // Prefixo numérico isolado aguardando sufixo na próxima linha
  let pendingPrefix     = '';

  function resolveN1(): string {
    return currentAnexo || currentSecao || currentCapitulo;
  }

  function flush() {
    const trimmed = buffer.trim();
    if (trimmed.length < 20) {
      if (trimmed.length > 0) {
        console.warn(
          `[splitLegalDocument] Grupo descartado (< 20 chars) | ` +
          `n1="${resolveN1()}" n2="${currentArtigoItem}" | ` +
          `conteúdo="${trimmed.replace(/\n/g, '↵')}"`
        );
      }
      return;
    }
    const n1         = resolveN1();
    const n2         = currentArtigoItem;
    const childTexts = trimmed.length > CHILD_CHUNK_SIZE
      ? splitIntoChildChunks(trimmed)
      : [trimmed];
    for (const content of childTexts) {
      result.push({ content, metadata: { n1_header: n1, n2_header: n2 } });
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // --- Resolução de cabeçalho quebrado ---
    // Se há um prefixo pendente da linha anterior, testa se esta linha
    // é o sufixo do cabeçalho.
    if (pendingPrefix) {
      if (isValidTitleSuffix(line) && looksLikeHeading(line) &&
          isSequentialItem(currentArtigoItem, pendingPrefix)) {
        // Confirma a transição: as duas linhas formam um cabeçalho
        flush();
        buffer            = '';
        currentArtigoItem = pendingPrefix;
        buffer           += pendingPrefix + ' ' + line + '\n';
        pendingPrefix     = '';
        continue;
      } else {
        // Não é sufixo: trata o prefixo pendente como conteúdo
        buffer       += pendingPrefix + '\n';
        pendingPrefix = '';
        // Continua processando `line` normalmente abaixo
      }
    }

    // Transição: ANEXO
    if (RE_ANEXO.test(line)) {
      flush();
      buffer            = '';
      currentAnexo      = line.match(RE_ANEXO)![0].toUpperCase();
      currentCapitulo   = '';
      currentSecao      = '';
      currentArtigoItem = '';
      continue;
    }

    // Transição: CAPÍTULO
    if (RE_CAPITULO.test(line)) {
      flush();
      buffer            = '';
      currentCapitulo   = line.match(RE_CAPITULO)![0].toUpperCase();
      currentSecao      = '';
      currentArtigoItem = '';
      continue;
    }

    // Transição: SEÇÃO
    if (RE_SECAO.test(line)) {
      flush();
      buffer            = '';
      currentSecao      = line.match(RE_SECAO)![0];
      currentArtigoItem = '';
      continue;
    }

    // Transição: ARTIGO / ITEM
    if (isStructuralItem(line, currentArtigoItem)) {
      flush();
      buffer            = '';
      currentArtigoItem = extractItemHeader(line);
      buffer           += line + '\n';
      continue;
    }

    // Detecção de prefixo isolado (cabeçalho quebrado em duas linhas)
    // Ex: "10.2." sozinho na linha, sem sufixo
    const multiOnly  = line.match(/^(\d+\.\d+(?:\.\d+)*\.)$/);
    const singleOnly = line.match(/^(\d+\.)$/);
    if (multiOnly || singleOnly) {
      pendingPrefix = (multiOnly ?? singleOnly)![0];
      continue;
    }

    // Linha de conteúdo: acumula no buffer atual
    buffer += line + '\n';
  }

  // Prefixo pendente não resolvido: trata como conteúdo
  if (pendingPrefix) buffer += pendingPrefix + '\n';

  flush();
  return result;
}
