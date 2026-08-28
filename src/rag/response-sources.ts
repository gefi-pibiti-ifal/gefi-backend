// ---------------------------------------------------------------------------
// response-sources.ts
//
// Contrato das FONTES entregues ao frontend e a sua construcao a partir do que
// realmente entrou no prompt.
//
// A cadeia de rastreabilidade que este modulo materializa:
//
//   resposta  ->  fonte (documento)  ->  trecho recuperado  ->  localizacao
//
// Uma fonte e sempre um DOCUMENTO (compativel com o contrato antigo
// `{ id, title }`), e cada fonte carrega os TRECHOS dela que fundamentaram a
// resposta. Cada trecho carrega a sua citacao estrutural, o texto que foi ao
// prompt e — quando os dados permitem — a localizacao dentro do documento.
//
// Regra inviolavel: localizacao ausente NAO invalida a fonte. `location: null`
// e um resultado legitimo (documento indexado antes desta funcionalidade,
// trecho que nao pode ser ancorado); a fonte continua abrindo o documento.
// Nenhuma pagina ou posicao e estimada por aproximacao.
// ---------------------------------------------------------------------------

import { buildCitation } from './source-citation';

/** Prefixo das rotas de documento (o app usa setGlobalPrefix('api')). */
export const DOCUMENTS_API_PREFIX = '/api/documents';

export type SourceRole = 'PRINCIPAL' | 'COMPLEMENTAR';

/**
 * Precisao da localizacao:
 *   TRECHO      — intervalo dos child chunks que a busca vetorial de fato
 *                 recuperou: a regiao que fundamentou a resposta;
 *   DISPOSITIVO — intervalo do ParentChunk inteiro (item/artigo), usado quando
 *                 nao ha localizacao mais fina (ex.: dispositivo trazido pela
 *                 expansao hierarquica, sem hit vetorial proprio).
 */
export type LocationPrecision = 'TRECHO' | 'DISPOSITIVO';

export interface SourceLocation {
  /** Pagina do PDF (1-based). null quando a extracao nao preservou paginas. */
  page_start: number | null;
  page_end: number | null;
  /** Offsets em NormativeDocument.indexed_content (ver document-location.ts). */
  char_start: number | null;
  char_end: number | null;
  precision: LocationPrecision;
}

export interface SourceExcerpt {
  parent_chunk_id: string | null;
  /** "Item 10.2 – ANEXO VIII-B – IN 05/2017" — mesmo formato citado na resposta. */
  citation: string;
  section_header: string | null;
  n1_header: string | null;
  n2_header: string | null;
  role: SourceRole;
  /** Texto exato que foi enviado ao modelo (pode conter marcadores [...]). */
  excerpt: string;
  location: SourceLocation | null;
}

export interface SourceDocumentFile {
  available: boolean;
  name: string | null;
  mime_type: string | null;
  size: number | null;
}

export interface ResponseSource {
  /** documentId — preservado do contrato antigo. */
  id: string;
  /** titulo do documento — preservado do contrato antigo. */
  title: string;
  document_type: string | null;
  total_pages: number | null;
  file: SourceDocumentFile;
  /** Visualizacao inline do arquivo original; null quando nao ha arquivo. */
  view_url: string | null;
  /** Download do arquivo original; null quando nao ha arquivo. */
  download_url: string | null;
  /** Texto indexado — coordenadas de char_start/char_end. Sempre disponivel. */
  content_url: string;
  excerpts: SourceExcerpt[];
}

/** Dados do documento necessarios para montar a fonte (sem o binario). */
export interface SourceDocumentInfo {
  id: string;
  title: string;
  document_type?: string | null;
  total_pages?: number | null;
  file_name?: string | null;
  file_mime_type?: string | null;
  file_size?: number | null;
}

export function buildDocumentLinks(
  documentId: string,
  hasFile: boolean,
): { view_url: string | null; download_url: string | null; content_url: string } {
  const base = `${DOCUMENTS_API_PREFIX}/${documentId}`;
  return {
    view_url: hasFile ? `${base}/file` : null,
    download_url: hasFile ? `${base}/file?download=1` : null,
    content_url: `${base}/content`,
  };
}

function toFile(info: SourceDocumentInfo | undefined): SourceDocumentFile {
  const available = Boolean(info?.file_name);
  return {
    available,
    name: info?.file_name ?? null,
    mime_type: info?.file_mime_type ?? null,
    size: info?.file_size ?? null,
  };
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

// ---------------------------------------------------------------------------
// buildExcerptLocation
//
// Escolhe a localizacao MAIS FINA que os dados sustentam, nesta ordem:
//   1. intervalo dos child chunks recuperados (TRECHO);
//   2. intervalo do ParentChunk (DISPOSITIVO);
//   3. null — nenhuma coordenada conhecida.
// Um intervalo sem pagina (documento sem mapa de paginas) continua valido:
// paginas ficam null e os offsets de caractere seguem utilizaveis.
// ---------------------------------------------------------------------------
export function buildExcerptLocation(
  metadata: Record<string, unknown>,
): SourceLocation | null {
  const excerptStart = readNumber(metadata.excerptCharStart);
  const excerptEnd = readNumber(metadata.excerptCharEnd);
  if (excerptStart !== null && excerptEnd !== null && excerptEnd > excerptStart) {
    return {
      page_start: readNumber(metadata.excerptPageStart),
      page_end: readNumber(metadata.excerptPageEnd) ?? readNumber(metadata.excerptPageStart),
      char_start: excerptStart,
      char_end: excerptEnd,
      precision: 'TRECHO',
    };
  }

  const charStart = readNumber(metadata.charStart);
  const charEnd = readNumber(metadata.charEnd);
  const pageStart = readNumber(metadata.pageStart);
  if (charStart !== null && charEnd !== null && charEnd > charStart) {
    return {
      page_start: pageStart,
      page_end: readNumber(metadata.pageEnd) ?? pageStart,
      char_start: charStart,
      char_end: charEnd,
      precision: 'DISPOSITIVO',
    };
  }

  // Sem offsets, mas com pagina conhecida (ex.: metadados parciais): ainda e
  // uma localizacao util para abrir o documento na pagina certa.
  if (pageStart !== null) {
    return {
      page_start: pageStart,
      page_end: readNumber(metadata.pageEnd) ?? pageStart,
      char_start: null,
      char_end: null,
      precision: 'DISPOSITIVO',
    };
  }

  return null;
}

/** Documento minimo (pageContent + metadata) — evita depender do LangChain aqui. */
export interface ContextDocument {
  pageContent: string;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// buildResponseSources
//
// Converte os trechos que entraram no prompt na lista de fontes da resposta.
// A ordem das fontes e a de PRIMEIRA APARICAO no contexto — que ja e a ordem
// de pertinencia definida pelo retrieval — e a ordem dos trechos dentro de
// cada fonte segue a mesma regra. Documentos sem informacao carregada em
// `documents` ainda produzem fonte (id + titulo do proprio metadado): perder
// uma fonte por falta de metadado seria perder rastreabilidade.
// ---------------------------------------------------------------------------
export function buildResponseSources(
  contexts: ContextDocument[],
  documents: Map<string, SourceDocumentInfo> = new Map(),
): ResponseSource[] {
  const byDocument = new Map<string, ResponseSource>();

  for (const context of contexts) {
    const metadata = context.metadata ?? {};
    const documentId = readString(metadata.documentId);
    if (!documentId) continue;

    const info = documents.get(documentId);

    if (!byDocument.has(documentId)) {
      const hasFile = Boolean(info?.file_name);
      byDocument.set(documentId, {
        id: documentId,
        title: info?.title ?? readString(metadata.title) ?? '',
        document_type: info?.document_type ?? null,
        total_pages: info?.total_pages ?? null,
        file: toFile(info),
        ...buildDocumentLinks(documentId, hasFile),
        excerpts: [],
      });
    }

    byDocument.get(documentId)!.excerpts.push({
      parent_chunk_id: readString(metadata.parentId),
      citation: buildCitation(metadata),
      section_header: readString(metadata.sectionHeader),
      n1_header: readString(metadata.n1_header),
      n2_header: readString(metadata.n2_header),
      role: metadata.role === 'COMPLEMENTAR' ? 'COMPLEMENTAR' : 'PRINCIPAL',
      excerpt: context.pageContent,
      location: buildExcerptLocation(metadata),
    });
  }

  return [...byDocument.values()];
}

// ---------------------------------------------------------------------------
// Historico — reconstroi o MESMO contrato de fontes a partir do que foi
// persistido, para que reabrir uma conversa antiga entregue exatamente as
// mesmas informacoes de navegacao que a resposta original entregou.
// ---------------------------------------------------------------------------
export interface PersistedExcerpt {
  parent_chunk_id: string | null;
  section_header: string | null;
  n1_header: string | null;
  n2_header: string | null;
  citation: string | null;
  excerpt: string;
  role: string | null;
  rank: number;
  page_start: number | null;
  page_end: number | null;
  char_start: number | null;
  char_end: number | null;
  location_precision: string | null;
}

export interface PersistedResponseSource {
  normative_id: string;
  normative: SourceDocumentInfo | null;
  excerpts?: PersistedExcerpt[];
}

export function buildHistorySources(
  rows: PersistedResponseSource[],
): ResponseSource[] {
  return rows.map((row) => {
    const info = row.normative;
    const hasFile = Boolean(info?.file_name);
    const excerpts = [...(row.excerpts ?? [])].sort((a, b) => a.rank - b.rank);

    return {
      id: row.normative_id,
      title: info?.title ?? '',
      document_type: info?.document_type ?? null,
      total_pages: info?.total_pages ?? null,
      file: toFile(info ?? undefined),
      ...buildDocumentLinks(row.normative_id, hasFile),
      excerpts: excerpts.map((e) => ({
        parent_chunk_id: e.parent_chunk_id,
        citation: e.citation ?? '',
        section_header: e.section_header,
        n1_header: e.n1_header,
        n2_header: e.n2_header,
        role: e.role === 'COMPLEMENTAR' ? 'COMPLEMENTAR' : 'PRINCIPAL',
        excerpt: e.excerpt,
        location: toPersistedLocation(e),
      })),
    };
  });
}

function toPersistedLocation(excerpt: PersistedExcerpt): SourceLocation | null {
  const hasChars =
    excerpt.char_start !== null &&
    excerpt.char_end !== null &&
    excerpt.char_end > excerpt.char_start;
  if (!hasChars && excerpt.page_start === null) return null;

  return {
    page_start: excerpt.page_start,
    page_end: excerpt.page_end ?? excerpt.page_start,
    char_start: hasChars ? excerpt.char_start : null,
    char_end: hasChars ? excerpt.char_end : null,
    precision: excerpt.location_precision === 'TRECHO' ? 'TRECHO' : 'DISPOSITIVO',
  };
}
