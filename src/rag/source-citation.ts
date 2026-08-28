// ---------------------------------------------------------------------------
// source-citation.ts
//
// Formatacao da referencia estrutural de um trecho (documento, anexo, item).
// Vive fora de rag.service.ts porque e usada em tres lugares que nao podem
// depender do servico: o rotulo do prompt, o DTO de fontes da resposta e o
// mapeamento do historico.
// ---------------------------------------------------------------------------

import { Document } from '@langchain/core/documents';

// Rotulo sintetico dado pela ingestao ao grupo de PREAMBULO — o texto que
// antecede qualquer cabecalho estrutural (capa e qualificacao das partes num
// contrato, ementa de uma norma). Nao e a designacao de um item real, entao
// nunca deve ser citado como "Item Secao" na resposta.
export const SECTION_HEADER_FALLBACK = 'Secao';

// ---------------------------------------------------------------------------
// normalizeDocumentTitle
//
// O titulo vem do upload (tipicamente o nome do arquivo ou o titulo extraido da
// pagina de origem) e costuma trazer o MESMO segmento repetido — artefato de
// exportacao: "LEI X - LEI X - DOU - Imprensa Nacional". O segmento repetido
// nao carrega informacao e polui a citacao que o modelo reproduz na resposta.
// Removemos apenas duplicatas exatas (comparacao sem acento/caixa) preservando
// a ordem e o primeiro exemplar de cada segmento; nada de conteudo e inventado
// ou descartado por juizo semantico.
// ---------------------------------------------------------------------------
export function normalizeDocumentTitle(title: string): string {
  const segments = title
    .split(/\s+[-–|]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length <= 1) return title.trim();

  const seen = new Set<string>();
  const kept: string[] = [];
  for (const segment of segments) {
    const key = segment
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(segment);
  }
  return kept.join(' - ');
}

export interface StructuralReference {
  title: string;
  n1Header: string;
  /** Item/artigo ja formatado ("Item 10.2", "Art. 39") ou string vazia. */
  item: string;
}

// ---------------------------------------------------------------------------
// resolveStructuralReference
//
// Extrai do metadado do trecho os niveis que EXISTEM — nunca inventa um nivel
// ausente. n2 e o item ("10.2.") ou artigo ("Art. 39"); sem n2, usa
// sectionHeader quando ele nao repete o n1 e nao e o rotulo sintetico de
// preambulo — este ultimo nao designa item algum, e citar "Item Secao" seria
// inventar uma referencia que nao existe no documento.
// ---------------------------------------------------------------------------
export function resolveStructuralReference(
  metadata: Record<string, unknown> | null | undefined,
): StructuralReference {
  const md = metadata ?? {};
  const rawTitle = typeof md.title === 'string' ? md.title : '';
  const title = rawTitle ? normalizeDocumentTitle(rawTitle) : 'Documento sem titulo';
  const n1Header = typeof md.n1_header === 'string' ? md.n1_header : '';
  const n2Header = typeof md.n2_header === 'string' ? md.n2_header : '';
  const section = typeof md.sectionHeader === 'string' ? md.sectionHeader : '';

  const usableSection =
    section !== n1Header && section !== SECTION_HEADER_FALLBACK ? section : '';
  const rawItem = n2Header || usableSection;
  const item = rawItem ? formatItemReference(rawItem) : '';

  return { title, n1Header, item };
}

/** "10.2." -> "Item 10.2." | "Art. 39" -> "Art. 39" (artigos ja se nomeiam). */
export function formatItemReference(item: string): string {
  return /^art/i.test(item) ? item : `Item ${item}`;
}

// ---------------------------------------------------------------------------
// buildSourceLabel
//
// Monta o cabecalho estrutural de cada fonte no prompt a partir dos metadados
// que ja chegam no Document (title, n1_header, n2_header, sectionHeader).
// Ex: [Trecho 1] Documento: "Edital X" | ANEXO VIII-B | Item 10.2.
//
// "Trecho N" e apenas o identificador posicional do bloco dentro do prompt;
// o modelo e instruido a citar SEMPRE pela referencia estrutural (documento,
// anexo, item), que e estavel e rastreavel fora desta requisicao.
//
// A prioridade definida no retrieval (metadado role PRINCIPAL/COMPLEMENTAR)
// NAO e renderizada no rotulo: a ordem dos trechos ja carrega o sinal (o
// primeiro e o mais pertinente) e vocabulario interno do pipeline nao deve
// induzir a resposta a falar em "fontes principais/complementares".
// ---------------------------------------------------------------------------
export function buildSourceLabel(doc: Document, index: number): string {
  const ref = resolveStructuralReference(doc.metadata as Record<string, unknown>);

  const parts: string[] = [`Documento: "${ref.title}"`];
  if (ref.n1Header) parts.push(ref.n1Header);
  if (ref.item) parts.push(ref.item);

  return `[Trecho ${index + 1}] ${parts.join(' | ')}`;
}

// ---------------------------------------------------------------------------
// buildCitation
//
// Referencia legivel de um trecho, no mesmo formato que o prompt manda o
// modelo usar na fundamentacao ("Item 10.2 – Anexo VIII-B – IN 05/2017"). Usar
// o mesmo formato aproxima a citacao da fonte do texto que aparece na resposta
// — util para o frontend relacionar as duas —, mas a redacao final e do
// modelo: a ligacao confiavel entre resposta e fonte continua sendo o proprio
// registro da fonte, nao o casamento de strings.
//
// Niveis ausentes sao simplesmente omitidos. O ponto final do numero do item
// ("10.2.") e retirado: ele e um artefato de como o cabecalho foi extraido do
// documento, nao parte da designacao do dispositivo.
// ---------------------------------------------------------------------------
export function buildCitation(
  metadata: Record<string, unknown> | null | undefined,
): string {
  const ref = resolveStructuralReference(metadata);
  const item = ref.item.replace(/^(Item\s+\d[\d.]*?)\.$/, '$1');
  return [item, ref.n1Header, ref.title].filter(Boolean).join(' – ');
}
