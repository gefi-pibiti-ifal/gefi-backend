// ---------------------------------------------------------------------------
// Regex de transição de estado — nível 1 (estrutura do documento)
// Cada padrão ancora no início da linha (^)
// ---------------------------------------------------------------------------
// ANEXO e propositalmente CASE-SENSITIVE: cabecalhos de anexo em documentos
// normativos brasileiros sao tipografados em caixa alta ("ANEXO VIII-B"),
// enquanto REFERENCIAS em prosa usam caixa mista/baixa ("anexo do Edital.",
// "Anexo V-B, ou outro instrumento..."). Com /i, uma referencia que caia no
// inicio de linha (quebra de linha do PDF) dispara uma transicao de estado
// falsa e todo o resto do documento e rotulado com um anexo fantasma
// (observado no corpus: n1_header "ANEXO DO" contaminando 21 de 22 parents
// de um contrato). Os demais niveis (Secao, Capitulo) mantem /i porque seus
// cabecalhos legitimos SAO em caixa mista ("Seção I") — e nenhuma captura de
// prosa desses padroes foi observada no corpus.
const RE_ANEXO    = /^ANEXO\s+([A-Z0-9][A-Z0-9\-]*)/;
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
// com números soltos no meio de frases ("item 3 do contrato").
// Tolera UM espaço entre o número e o ponto ("1 . CLÁUSULA PRIMEIRA") —
// artefato comum de extração de PDF em termos de contrato; a forma canônica
// é restaurada em extractItemHeader.
const RE_ITEM_PREFIX_SINGLE = /^(\d+ ?\.)/;
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
// [REMOVIDO] looksLikeHeading
//
// A segunda camada de "reconhecimento positivo de titulo" foi removida da
// decisao de fronteira. Motivo: itens numerados de documentos juridicos NAO
// tem forma de titulo — o texto apos o numero e prosa normativa comum, e a
// allowlist de padroes rejeitava sistematicamente aberturas legitimas:
//   "3.1. O prazo de vigencia..."      (maiuscula isolada + espaco)
//   "2.1. A presente contratacao..."   (idem)
//   "9. E permitida a licitacao:"      (idem, acentuada)
//   "3. CLAUSULA TERCEIRA – VIGENCIA"  (caixa alta)
// Medido no corpus real: 30% das fronteiras da IN 05 e 48% das fronteiras de
// um termo de contrato eram descartadas por essa camada, fundindo clausulas
// inteiras num mesmo ParentChunk (ex.: tabela de precos + clausula de
// fundamento legal + clausula de vigencia num unico blob).
//
// A decisao continua protegida pelas camadas restantes:
//   - isLegislativeReferenceLine  (guard explicita de referencias a leis)
//   - isValidTitleSuffix          (rejeita ",", "/", "de 1993", "no 8.666")
//   - isSequentialItem            (coerencia numerica com o estado corrente,
//                                  incluindo guard de numero de lei N.NNN)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// isSequentialItem
//
// Decide se a transição de `current` para `candidate` é numericamente
// plausível. Bloqueia apenas retrocessos absurdos — não exige sequência
// estrita (aceita saltos de irmão como 10.2 → 10.5).
//
// A comparação é GENÉRICA em profundidade: mesmo nível e subida de nível são
// decididos comparando os componentes comuns dos dois números — a transição é
// válida quando o primeiro componente divergente AVANÇA. As regras antigas,
// codificadas apenas para nível 2, rejeitavam TODA transição de irmãos em
// profundidade >= 3 (3.1.1 → 3.1.2 retornava false), fundindo os subitens de
// uma cláusula num único ParentChunk (observado no corpus: o parent "3.2.1."
// de um contrato absorvia 3.2.2 a 3.2.11, 3.3 e 3.4).
//
// Aceita:
//   10.2   → 10.3     próximo irmão
//   10.2   → 10.5     salto de irmão (seções podem ser omitidas no documento)
//   10.2   → 10.2.1   primeiro filho
//   3.1.1  → 3.1.2    próximo irmão em profundidade 3
//   3.1.6  → 3.2.1    novo bloco em profundidade 3
//   3.2.11 → 3.3      subida de nível
//   10.5   → 11.1     nova seção
//   1      → 2        nível único sequencial
//   1      → 1.1      nível único → filho
//
// Rejeita:
//   10.2 → 8.666     número de lei (segundo componente > MAX_MINOR_COMPONENT)
//   10.2 → 14.133    número de lei
//   5.1  → 1.2       retrocesso de seção
//   10.2 → 10.1      retrocesso de item
//   2    → 1         retrocesso de nível único
//   17   → 2024      salto absurdo (> MAX_MAJOR_JUMP) — ano/valor em prosa
//   10.2 → 10.2.1.1  descida de mais de um nível de uma vez
//
// Se `current` for vazio ou não-numérico, aceita qualquer candidato numérico
// que não tenha forma de número de lei.
// ---------------------------------------------------------------------------

// Limiar máximo de salto permitido no componente principal (ex: 10 → 13 ok, 10 → 50 não)
export const MAX_MAJOR_JUMP = 20;
// Segundo componente >= este valor indica número de lei (8.666, 14.133, 10.520)
// e nunca é um item estrutural de documento
export const MAX_MINOR_COMPONENT = 99;

export function isSequentialItem(current: string, candidate: string): boolean {
  const cand = parseItemNumber(candidate);
  if (!cand) return false;

  const cn = cand.numbers;

  // Guard de número de lei: candidato de DOIS componentes com segundo
  // componente alto ("8.666", "14.133", "10.520") tem forma de número de
  // norma, nunca de item estrutural — independe do estado corrente.
  if (cn.length === 2 && cn[1] > MAX_MINOR_COMPONENT) return false;

  if (!current) return true;

  const curr = parseItemNumber(current);
  if (!curr) return true; // estado não-numérico (ex: "Art. 5"): aceita qualquer item

  const cr = curr.numbers;

  // --- Candidato de nível único ---
  // Aceita tanto nível único → nível único quanto multi-nível → nível único,
  // desde que haja avanço numérico plausível no componente principal.
  // Ex: 10.2.1. → 11.  (11 > 10, salto 1)  ✓
  //     10.2.1. →  9.  (9 < 10)            ✗
  //     17.     → 2024. (salto 2007)       ✗  (ano/valor em prosa)
  if (cn.length === 1) {
    return cn[0] > cr[0] && cn[0] <= cr[0] + MAX_MAJOR_JUMP;
  }
  // Estado de nível único, candidato multi-nível:
  //   - filho direto: cn[0] === cr[0]  (ex: 10. → 10.1, 3. → 3.1)
  //   - novo bloco:   cn[0] >  cr[0]  (ex: 1.  → 2.1,  9. → 10.1)
  if (cr.length === 1) {
    return cn[0] >= cr[0] && cn[0] <= cr[0] + MAX_MAJOR_JUMP;
  }

  // Filho direto: prefixo do estado presente e último componente = 1
  // (10.2 → 10.2.1 | 3.1 → 3.1.1). Vale para qualquer profundidade.
  if (cn.length === cr.length + 1) {
    const parentMatches = cr.every((v, i) => cn[i] === v);
    return parentMatches && cn[cn.length - 1] === 1;
  }

  // Descida de mais de um nível de uma vez (10.2 → 10.2.1.1): implausível.
  if (cn.length > cr.length + 1) return false;

  // Mesmo nível ou subida de nível (candidato até a profundidade do estado):
  // compara os componentes comuns; a transição é válida quando o PRIMEIRO
  // componente divergente AVANÇA (retrocesso rejeitado), com salto limitado
  // no componente principal. Componentes após o divergente reiniciam
  // livremente (3.1.6 → 3.2.1).
  for (let i = 0; i < cn.length; i++) {
    if (cn[i] === cr[i]) continue;
    if (cn[i] < cr[i]) return false;                             // retrocesso
    if (i === 0 && cn[0] > cr[0] + MAX_MAJOR_JUMP) return false; // salto absurdo
    return true;
  }
  return false; // componentes comuns todos iguais: não há avanço
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
//   4. Transição coerente?        → false se incompatível (isSequentialItem)
//   → true
//
// NÃO há reconhecimento positivo do "formato de título" do sufixo: o texto
// após o número de um item jurídico é prosa normativa comum ("O prazo de
// vigência...", "CLÁUSULA TERCEIRA..."), e qualquer allowlist de formas
// rejeita aberturas legítimas (ver nota [REMOVIDO] looksLikeHeading acima).
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
    if (!isSequentialItem(currentArtigoItem, prefix)) return false;
    return true;
  }

  // Ramo 3: Item de nível único (N.) — ponto obrigatório
  const singleMatch = line.match(RE_ITEM_PREFIX_SINGLE);
  if (singleMatch) {
    const prefix      = singleMatch[0];
    const afterPrefix = line.slice(prefix.length);
    if (!isValidTitleSuffix(afterPrefix)) return false;
    // Estado de ARTIGO: enumeracoes internas do proprio artigo usam numeracao
    // decimal de nivel unico CONTINUANDO a frase em minuscula ("1. do limite
    // de idade da crianca...; e"). Nesse estado, so abre grupo novo se o
    // sufixo comecar em maiuscula (titulo/caput de secao numerada, ex.:
    // "1. Introducao"). Fora do estado de artigo a numeracao decimal e a
    // propria espinha estrutural do documento e o guard nao se aplica.
    if (
      RE_ARTIGO_PREFIX.test(currentArtigoItem) &&
      !/^[.\s]*[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÇ]/.test(afterPrefix)
    ) {
      return false;
    }
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
  // O prefixo de nível único pode carregar o espaço de artefato de PDF
  // ("2 ."); normaliza para a forma canônica ("2.") antes de virar n2_header.
  return line.match(RE_ITEM_PREFIX_SINGLE)![0].replace(/\s+/g, '');
}

// ---------------------------------------------------------------------------
// Splitter — máquina de estados hierárquica
// ---------------------------------------------------------------------------
export const CHILD_CHUNK_SIZE    = 600;
export const CHILD_CHUNK_OVERLAP = 80;

// Um HierarchicalChunk representa um grupo estrutural COMPLETO (material do
// ParentChunk): o texto e a integra original do buffer, sem cortes.
// A derivacao dos child chunks (janelas de CHILD_CHUNK_SIZE com overlap)
// acontece na ingestao (rag.service), sobre o conteudo final do parent —
// nunca antes. Reconstruir o parent a partir de children com overlap
// duplicava ~80 chars a cada fronteira e inseria quebras no meio de palavra.
export interface HierarchicalChunk {
  content: string;
  metadata: {
    n1_header: string;
    n2_header: string;
  };
}

/**
 * Child chunk com a sua posicao [start, end) dentro do texto do parent.
 * As posicoes sao consequencia direta da janela deslizante — nao ha busca nem
 * heuristica — e sao o que permite localizar no documento a regiao que a busca
 * vetorial de fato recuperou.
 */
export interface ChildChunk {
  content: string;
  start: number;
  end: number;
}

export function splitIntoChildChunksWithOffsets(text: string): ChildChunk[] {
  const chunks: ChildChunk[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHILD_CHUNK_SIZE, text.length);
    chunks.push({ content: text.slice(start, end), start, end });
    start += CHILD_CHUNK_SIZE - CHILD_CHUNK_OVERLAP;
  }
  return chunks;
}

export function splitIntoChildChunks(text: string): string[] {
  return splitIntoChildChunksWithOffsets(text).map((chunk) => chunk.content);
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
    result.push({
      content: trimmed,
      metadata: { n1_header: resolveN1(), n2_header: currentArtigoItem },
    });
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // --- Resolução de cabeçalho quebrado ---
    // Se há um prefixo pendente da linha anterior, testa se esta linha
    // é o sufixo do cabeçalho.
    if (pendingPrefix) {
      if (isValidTitleSuffix(line) &&
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
