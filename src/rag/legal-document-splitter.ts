// ---------------------------------------------------------------------------
// Regex de transição de estado — cada padrão ancora no início da linha (^)
// ---------------------------------------------------------------------------
const RE_ANEXO       = /^ANEXO\s+([A-Z0-9][A-Z0-9\-]*)/i;
const RE_CAPITULO    = /^CAP[ÍI]TULO\s+([IVXLCDM]+)/i;
const RE_SECAO       = /^Se[çc][ãa]o\s+([IVXLCDM]+)/i;
const RE_SUBSECAO    = /^Subse[çc][ãa]o\s+([IVXLCDM]+)/i;
const RE_TITULO      = /^T[ÍI]TULO\s+([IVXLCDM]+)/i;
const RE_LIVRO       = /^LIVRO\s+([IVXLCDM]+)/i;
// Artigo (Art. 10, Art.10°) OU item numerado (1., 10.2, 10.2.1)
const RE_ARTIGO_ITEM = /^(Art\.?\s*\d+[°º]?|\d+\.\d+\.?)/i;

const CHILD_CHUNK_SIZE    = 600;
const CHILD_CHUNK_OVERLAP = 80;

export interface HierarchicalChunk {
  content: string;
  metadata: {
    n1_header: string; // mapeado de: anexo > capítulo > seção (o mais específico presente)
    n2_header: string; // mapeado de: artigo / item numerado
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
 * Estados rastreados (do mais amplo ao mais específico):
 *   currentAnexo      — ex: "ANEXO VIII-B"
 *   currentCapitulo   — ex: "CAPÍTULO III"
 *   currentSecao      — ex: "Seção I"
 *   currentArtigoItem — ex: "Art. 39" | "10.2."
 *
 * Mapeamento para a interface HierarchicalChunk:
 *   n1_header ← o estado de nível-1 mais específico presente
 *               (prioridade: Anexo > Seção > Capítulo)
 *   n2_header ← currentArtigoItem
 */
export function splitLegalDocument(cleanedText: string): HierarchicalChunk[] {
  const lines  = cleanedText.split('\n');
  const result: HierarchicalChunk[] = [];

  // --- Estado da máquina ---
  let currentAnexo      = '';
  let currentCapitulo   = '';
  let currentSecao      = '';
  let currentArtigoItem = '';
  let buffer            = '';

  // Retorna o n1_header mais específico disponível no momento do flush
  function resolveN1(): string {
    return currentAnexo || currentSecao || currentCapitulo;
  }

  function flush() {
    const trimmed = buffer.trim();
    if (trimmed.length < 20) return;

    const n1 = resolveN1();
    const n2 = currentArtigoItem;

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

    // Transição: ANEXO 
    if (RE_ANEXO.test(line)) {
      flush();
      buffer            = '';
      currentAnexo      = line.match(RE_ANEXO)![0].toUpperCase(); // Extrai só "ANEXO VIII-B"
      currentCapitulo   = '';
      currentSecao      = '';
      currentArtigoItem = '';
      continue;
    }

    // Transição: CAPÍTULO 
    if (RE_CAPITULO.test(line)) {
      flush();
      buffer            = '';
      currentCapitulo   = line.match(RE_CAPITULO)![0].toUpperCase(); // Extrai só "CAPÍTULO X"
      currentSecao      = '';
      currentArtigoItem = '';
      continue;
    }

    // Transição: SEÇÃO 
    if (RE_SECAO.test(line)) {
      flush();
      buffer            = '';
      currentSecao      = line.match(RE_SECAO)![0]; // Extrai só "Seção Y"
      currentArtigoItem = '';
      continue;
    }

    // Transição: ARTIGO / ITEM 
    if (RE_ARTIGO_ITEM.test(line)) {
      flush();
      buffer            = '';
      currentArtigoItem = line.match(RE_ARTIGO_ITEM)![0]; // Extrai só "Art. 40" ou "10.2"
      
      // A linha do cabeçalho abre o novo buffer
      buffer += line + '\n';
      continue;
    }

    // ── Linha de conteúdo: acumula no buffer atual ──
    buffer += line + '\n';
  } // <-- A chave que fecha o laço 'for' deve ficar aqui!

  flush(); // garante que o último bloco não seja perdido

  return result;
}
