import {
  Injectable,
  OnModuleInit,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  splitLegalDocument,
  parseItemNumber,
  splitIntoChildChunksWithOffsets,
  CHILD_CHUNK_SIZE,
  type ChildChunk,
} from './legal-document-splitter';
import {
  buildLocatedParts,
  buildNormalizedIndex,
  buildPageMap,
  locateInDocument,
  locateSequentialSegments,
  mergePageSpans,
  mergeRanges,
  readCharRange,
  readPageSpan,
  resolvePageSpan,
  type CharRange,
  type PageInput,
  type PageSpan,
} from './document-location';
import {
  buildResponseSources,
  type ResponseSource,
  type SourceDocumentInfo,
} from './response-sources';
import {
  buildClusters,
  applyHierarchicalBoost,
  flattenClusters,
  pruneForeignAnexoContamination,
  rankByProvenance,
  getN1Header,
  getN2Header,
  sortParentsByStructuralOrder,
  deriveSiblingPrefix,
  type ParentChunkRow,
  type Provenance,
} from './hierarchical-context';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { Document } from '@langchain/core/documents';
import { Embeddings } from '@langchain/core/embeddings';
import { PGVectorStore } from '@langchain/pgvector';
import { PoolConfig } from 'pg';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';
import { HarmBlockThreshold, HarmCategory } from '@google/generative-ai';

dotenv.config();

// Flag de debug: ativa logs TRACE detalhados do pipeline RAG.
// Uso: DEBUG_RAG=true npm run start:dev
const DEBUG_RAG = process.env.DEBUG_RAG === 'true';

// ---------------------------------------------------------------------------
// Constantes do pipeline RAG
// ---------------------------------------------------------------------------

// Ingestão
const EMBEDDING_BATCH_SIZE = 15;
const EMBEDDING_BATCH_DELAY = 10_000; // ms entre lotes
const EMBEDDING_RETRY_DELAY = 65_000; // ms após rate-limit 429
const EMBEDDING_MAX_RETRIES = 5;

// Retrieval
// Quantos child chunks buscar no indice vetorial. Childs do mesmo parent
// colapsam na deduplicacao (com k=5 sobravam 2-3 parents efetivos); os tetos
// MAX_EXPANDED_PARENTS / MAX_EXPANDED_CHARS continuam limitando o que chega
// ao prompt.
const RETRIEVAL_FETCH_K = 12;
// Teto de irmaos adicionados por grupo na expansao hierarquica — apenas os
// numericamente mais proximos dos itens recuperados. Sem teto, um item com
// muitos irmaos inunda o orcamento de contexto e expulsa parents relevantes
// de outros grupos.
const MAX_SIBLINGS_PER_GROUP = 3;
// Teto de filhos diretos trazidos por item recuperado na expansao DESCENDENTE.
// Um item nao-folha ("10.2") costuma guardar so o caput; os subitens que
// compoem a resposta ("10.2.1", "10.2.2", ...) vivem em parents-filhos e
// precisam ser trazidos para o dispositivo chegar completo ao prompt. O teto
// evita que um dispositivo com dezenas de subitens monopolize o contexto.
const MAX_DESCENDANTS_PER_ITEM = 12;

// Filtro de qualidade dos ParentChunks
const MIN_PARENT_CONTENT_LENGTH = 80;

// Janela deslizante — aplicada SOMENTE a parents maiores que o limiar abaixo.
// Parents menores entram integros no prompt: truncar justamente o trecho mais
// relevante (o parent que disparou o hit) era uma das principais causas de
// respostas incompletas/resumidas.
const SLIDING_WINDOW_MIN_PARENT_LENGTH = 3500;
const SLIDING_WINDOW_BEFORE = 1200;
const SLIDING_WINDOW_AFTER = 2400;
// Tamanhos do anchor tentados em ordem decrescente (fallback progressivo)
const SLIDING_WINDOW_ANCHOR_SIZES = [50, 40, 30, 20] as const;
// Alcance maximo da busca por fronteira de sentenca ao ajustar a janela
const SENTENCE_SNAP_RANGE = 300;

// ---------------------------------------------------------------------------
// Helpers de throttling
// ---------------------------------------------------------------------------
const delay = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

function chunkArray<T>(arr: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < arr.length; i += size)
    batches.push(arr.slice(i, i + size));
  return batches;
}

// ---------------------------------------------------------------------------
// Embeddings via Gemini nativo (com throttling sequencial)
// ---------------------------------------------------------------------------
class NativeGeminiEmbeddings extends Embeddings {
  private model: ReturnType<
    InstanceType<typeof GoogleGenerativeAI>['getGenerativeModel']
  >;

  constructor(apiKey: string) {
    super({});
    const genAI = new GoogleGenerativeAI(apiKey);
    this.model = genAI.getGenerativeModel({ model: 'gemini-embedding-2' });
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const requests = texts.map((text) => ({
      content: { role: 'user', parts: [{ text }] },
    }));
    const response = await this.model.batchEmbedContents({ requests });
    return response.embeddings.map((e) => e.values);
  }

  async embedQuery(text: string): Promise<number[]> {
    const result = await this.model.embedContent(text);
    return result.embedding.values;
  }
}

// Identifica linhas que sao cabecalhos estruturais do direito brasileiro.
// Usada como guarda em cleanExtractedText para evitar que a regex de limpeza
// de maiusculas apague marcadores que a maquina de estados do splitter precisa.
function isStructuralHeading(line: string): boolean {
  return (
    /^ANEXO\s+[A-Z0-9]/i.test(line) ||
    /^CAP[ÍI]TULO\s+[IVXLCDM]/i.test(line) ||
    /^Se[çc][ãa]o\s+[IVXLCDM]/i.test(line) ||
    /^Subse[çc][ãa]o\s+[IVXLCDM]/i.test(line) ||
    /^T[ÍI]TULO\s+[IVXLCDM]/i.test(line) ||
    /^LIVRO\s+[IVXLCDM]/i.test(line)
  );
}

// Padrões de ruído típico de PDF que devem ser removidos mesmo em ALL-CAPS.
// Critério: linhas que são claramente artefatos de paginação ou cabeçalhos
// repetitivos, não conteúdo normativo.
// Exemplos removidos: "MINISTÉRIO DA FAZENDA", "SECRETARIA DE ESTADO",
//   "DIRETORIA DE CONTRATOS" (cabeçalhos de rodapé/cabeçalho de página)
// Exemplos preservados: "DAS OBRIGAÇÕES DO CONTRATADO", "DO PAGAMENTO",
//   "OBJETO", "DA EXECUÇÃO CONTRATUAL"
//
// Heurística: remove apenas linhas ALL-CAPS que NÃO contêm palavras
// normativas típicas de títulos de seção (prepositions: DA, DO, DAS, DOS,
// DE, DO, NO, NA, NOS, NAS + subst. como OBJETO, PRAZO, GARANTIA, etc.).
// Em vez de whitelist, usa blacklist de padrões de ruído conhecidos.
const RE_PDF_NOISE_ALLCAPS = [
  // Cabeçalhos institucionais: órgãos, ministérios, secretarias, diretorias
  /^(MINISTÉRIO|SECRETARIA|DIRETORIA|DEPARTAMENTO|COORDENAÇÃO|SUBSECRETARIA|SUPERINTENDÊNCIA|GERENCIA|ASSESSORIA)\b/i,
  // Linhas que são apenas siglas (2-5 letras maiúsculas sem espaço, sem acentos)
  // Ex: CGU, TCU, STF, ANTT — mas não "OBJETO", "PRAZO"
  /^[A-Z]{2,5}$/,
  // Linhas que são apenas números romanos isolados (artefato de PDF)
  /^(I{1,3}|IV|VI{0,3}|IX|X{1,3}|XI{1,3}|XIV|XV)$/,
];

function isPdfNoiseAllCaps(line: string): boolean {
  return RE_PDF_NOISE_ALLCAPS.some((re) => re.test(line.trim()));
}

// ---------------------------------------------------------------------------
// normalizeForSearch
//
// Normaliza whitespace para busca de substring.
// Substitui qualquer sequência de whitespace (espaços, tabs, quebras de linha)
// por um único espaço e remove espaços nas extremidades.
//
// Preserva: acentos, letras, pontuação.
// Não altera: conteúdo semântico.
//
// Uso: comparar anchor (do child chunk) com o conteúdo do parent,
// eliminando falhas causadas por diferenças de formatação de PDF.
// ---------------------------------------------------------------------------
export function normalizeForSearch(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// locationMetadata
//
// Campos de localizacao acrescentados ao metadata de parents e children. Chaves
// ausentes significam "nao foi possivel localizar" — nunca zero, nunca uma
// pagina estimada: um trecho sem localizacao continua sendo uma fonte valida,
// mas o frontend nao deve levar o usuario a lugar nenhum por conta propria.
// ---------------------------------------------------------------------------
export function locationMetadata(
  range: CharRange | null,
  pages: PageSpan | null,
): Record<string, number> {
  return {
    ...(range ? { char_start: range.start, char_end: range.end } : {}),
    ...(pages ? { page_start: pages.page_start, page_end: pages.page_end } : {}),
  };
}

// Log de TRACE condicionado a DEBUG_RAG — evita custo/ruido de console.log
// em producao (os TRACEs incluem dumps de embedding e do contexto completo).
function trace(...args: unknown[]): void {
  if (DEBUG_RAG) console.log(...args);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// findAnchorIndex
//
// Localiza o inicio do child chunk dentro do conteudo do parent.
// Tolerante a diferencas de whitespace (espaco vs quebra de linha — artefato
// comum de extracao de PDF): o anchor vira uma regex em que qualquer
// sequencia de whitespace casa com \s+.
// Tenta anchors progressivamente menores (SLIDING_WINDOW_ANCHOR_SIZES) ate
// encontrar. Retorna -1 se nenhum tamanho casar.
// ---------------------------------------------------------------------------
export function findAnchorIndex(
  parentContent: string,
  childContent: string,
): number {
  for (const size of SLIDING_WINDOW_ANCHOR_SIZES) {
    const anchor = childContent.slice(0, size).trim();
    if (anchor.length < 10) continue;
    const pattern = new RegExp(escapeRegExp(anchor).replace(/\s+/g, '\\s+'));
    const match = pattern.exec(parentContent);
    if (match) return match.index;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// snapWindowStart / snapWindowEnd
//
// Ajustam as bordas da janela deslizante para fronteiras de sentenca ou de
// linha, evitando cortar dispositivos no meio de uma frase. A busca e
// limitada a SENTENCE_SNAP_RANGE chars; sem fronteira nesse alcance, a borda
// original e mantida (o marcador [...] sinaliza o corte).
// ---------------------------------------------------------------------------
export function snapWindowStart(content: string, start: number): number {
  if (start <= 0) return start;
  const from = Math.max(0, start - SENTENCE_SNAP_RANGE);
  const region = content.slice(from, start);
  const breakAt = Math.max(region.lastIndexOf('\n'), region.lastIndexOf('. '));
  if (breakAt === -1) return start;
  const isSentence = region.slice(breakAt, breakAt + 2) === '. ';
  return from + breakAt + (isSentence ? 2 : 1);
}

export function snapWindowEnd(content: string, end: number): number {
  if (end >= content.length) return end;
  const region = content.slice(
    end,
    Math.min(content.length, end + SENTENCE_SNAP_RANGE),
  );
  const nl = region.indexOf('\n');
  const dot = region.indexOf('. ');
  const stops: number[] = [];
  if (nl !== -1) stops.push(nl); // fim de linha: nao inclui o \n
  if (dot !== -1) stops.push(dot + 1); // fim de sentenca: inclui o ponto
  if (stops.length === 0) return end;
  return end + Math.min(...stops);
}

// ---------------------------------------------------------------------------
// Limpeza pre-chunking
// ---------------------------------------------------------------------------

// Ligaturas tipograficas comuns em fontes de PDF -> forma expandida.
// Mapeamento 1:1 sem ambiguidade ("ﬁscalizacao" -> "fiscalizacao").
// U+019F ("Ɵ"): fontes usadas nos modelos de termo de contrato da CNMLC/AGU
// mapeiam a ligadura "ti" para esse glifo ("conƟnuado" -> "continuado");
// como letra genuina ele nao ocorre em portugues, a expansao e inequivoca.
const PDF_LIGATURES: Array<[RegExp, string]> = [
  [/ﬀ/g, 'ff'],
  [/ﬁ/g, 'fi'],
  [/ﬂ/g, 'fl'],
  [/ﬃ/g, 'ffi'],
  [/ﬄ/g, 'ffl'],
  [/Ɵ/g, 'ti'],
];

// Remove artefatos invisiveis de extracao de PDF. Operacoes 100% seguras:
// soft hyphen (U+00AD) e zero-width (U+200B..D, U+FEFF) nao tem representacao
// visual; NBSP (U+00A0) e visualmente identico ao espaco comum. Nada de
// conteudo e alterado — apenas a codificacao e normalizada.
export function stripInvisibleArtifacts(text: string): string {
  let out = text
    .replace(/[\u00AD\u200B\u200C\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ');
  for (const [re, expanded] of PDF_LIGATURES) out = out.replace(re, expanded);
  return out;
}

// Vocabulario de atestacao da de-hifenizacao. Extraido em separado para que a
// limpeza de UMA pagina possa usar o vocabulario do documento INTEIRO: sem
// isso, "fiscali-\nzacao" seria unido no texto completo e mantido na pagina
// isolada, e as duas versoes deixariam de casar no mapeamento de paginas.
export function collectAttestedWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const token of text.split(/[^\p{L}]+/u)) {
    if (token.length >= 4) words.add(token.toLowerCase());
  }
  return words;
}

// De-hifenizacao ATESTADA pelo proprio documento: une "fiscali-\nzacao" ->
// "fiscalizacao" SOMENTE se a palavra unida ocorre integra em algum outro
// ponto do texto. Sem atestado, o trecho fica exatamente como estava — nada
// e inventado. Compostos legitimos quebrados no proprio hifen ("decreto-\nlei")
// nao sao unidos, pois "decretolei" nao ocorre no documento.
export function dehyphenateAttested(
  text: string,
  vocabulary?: Set<string>,
): string {
  const words = vocabulary ?? collectAttestedWords(text);
  return text.replace(
    /(\p{L}{2,})-\n(\p{Ll}{2,})/gu,
    (match, a: string, b: string) =>
      words.has(`${a}${b}`.toLowerCase()) ? `${a}${b}` : match,
  );
}

export function cleanExtractedText(
  raw: string,
  vocabulary?: Set<string>,
): string {
  const preprocessed = dehyphenateAttested(
    stripInvisibleArtifacts(raw),
    vocabulary,
  );
  return preprocessed
    .replace(/^\s*[-–]?\s*\d+\s*[-–]?\s*$/gm, '')
    .replace(/^\s*[Pp]ágina\s+\d+\s+de\s+\d+\s*$/gm, '')
    .replace(/^[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÇ\s\/\-\.]{5,80}$/gm, (match) => {
      const trimmed = match.trim();
      // Sempre preserva cabeçalhos estruturais que a máquina de estados precisa
      if (isStructuralHeading(trimmed)) return match;
      // Preserva linhas com letras minúsculas (não são ALL-CAPS)
      if (/[a-záéíóúâêîôûãõç]/.test(match)) return match;
      // Remove apenas ruído de PDF conhecido; preserva títulos normativos
      if (isPdfNoiseAllCaps(trimmed)) return '';
      // Preserva títulos ALL-CAPS que parecem conteúdo normativo
      return match;
    })
    .replace(/[_\-\.]{4,}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim();
}

// ---------------------------------------------------------------------------
// resolveFinishReason
//
// Lê o finishReason na ordem de precedência correta para o adapter
// LangChain/Gemini, que pode expor o campo em locais diferentes dependendo
// da versão do SDK:
//   1. response.finishReason          (campo direto, algumas versões)
//   2. response_metadata.finishReason (camelCase — padrão atual do Gemini)
//   3. response_metadata.finish_reason (snake_case — fallback)
//   4. generationInfo.finishReason
//   5. generationInfo.finish_reason
//   6. 'unknown'
// ---------------------------------------------------------------------------
function resolveFinishReason(response: any): string {
  return (
    response?.finishReason ??
    response?.response_metadata?.finishReason ??
    response?.response_metadata?.finish_reason ??
    response?.generationInfo?.finishReason ??
    response?.generationInfo?.finish_reason ??
    'unknown'
  );
}

// A formatacao da referencia estrutural (rotulo do prompt e citacao da fonte)
// vive em source-citation.ts, compartilhada com o DTO de fontes e o historico.
// Re-exportada aqui porque rag.service segue sendo o ponto de entrada do
// pipeline para quem importa essas funcoes.
export {
  SECTION_HEADER_FALLBACK,
  normalizeDocumentTitle,
  buildSourceLabel,
  buildCitation,
} from './source-citation';
import { buildSourceLabel, SECTION_HEADER_FALLBACK } from './source-citation';

// ---------------------------------------------------------------------------
// buildChunkEmbedText
//
// Texto que vai para o EMBEDDING de cada child — NAO o texto armazenado.
// Prepende o contexto estrutural do trecho (titulo do documento, cabecalho
// descritivo do anexo/secao e o item) ao conteudo local. Assim o vetor do child
// carrega o TEMA da secao a que ele pertence, e nao apenas suas palavras
// locais: um dispositivo cujo texto proprio nao repete o tema da secao — ex.:
// uma obrigacao de entrega de documentos dentro de um anexo de fiscalizacao —
// deixa de "sumir" do Top-K quando a pergunta usa o vocabulario do tema.
// O texto ARMAZENADO (pageContent) segue sendo o conteudo cru: o prefixo vale
// so para a vetorizacao, entao a ancoragem da janela deslizante e o que o LLM
// le nao mudam. Tecnica geral (contextual retrieval), sem regra por norma.
// ---------------------------------------------------------------------------
export function buildChunkEmbedText(
  rawChild: string,
  ctx: { title?: string; sectionHeading?: string; item?: string },
): string {
  const parts: string[] = [];
  if (ctx.title?.trim()) parts.push(ctx.title.trim());
  if (ctx.sectionHeading?.trim()) parts.push(ctx.sectionHeading.trim());
  if (ctx.item?.trim()) parts.push(`Item ${ctx.item.trim()}`);
  const header = parts.join(' — ');
  return header ? `${header}\n\n${rawChild}` : rawChild;
}

export function buildRagPrompt(
  contexts: Document[],
  userQuery: string,
): string {
  // Separa o contexto pela proveniencia (role da camada deterministica):
  // dispositivos CENTRAIS (hit direto/descendente) x MATERIAL DE APOIO (irmao
  // trazido pela expansao). O apoio continua disponivel — mas rotulado como
  // "nao gerar bloco" para nao virar um topico proprio na resposta. A numeracao
  // [Trecho N] segue continua entre as duas camadas.
  const isApoio = (doc: Document) =>
    (doc.metadata as Record<string, unknown>).role === 'COMPLEMENTAR';
  const central = contexts.filter((d) => !isApoio(d));
  const apoio = contexts.filter(isApoio);

  let idx = 0;
  const render = (doc: Document) => `${buildSourceLabel(doc, idx++)}\n${doc.pageContent}`;
  const centralBlock = central.map(render).join('\n\n---\n\n');
  const apoioBlock = apoio.map(render).join('\n\n---\n\n');
  const contextBlock = apoio.length
    ? `${centralBlock}\n\n=== MATERIAL DE APOIO (dispositivos correlatos trazidos pela expansao; NAO gere bloco proprio para estes — use so para referencia cruzada ou se indispensaveis) ===\n\n${apoioBlock}`
    : centralBlock;

  return `Voce ajuda um servidor publico a resolver uma duvida concreta do trabalho dele. Ele nao quer estudar a norma: ele quer saber o que pode fazer, quanto, ate quando, e o que fazer quando a regra nao o alcanca. As normas sao a sua FONTE — nunca o roteiro da sua resposta.

Abaixo estao trechos de documentos normativos, cada um com uma anotacao interna de origem (documento, anexo, item). Os trechos estao ordenados por pertinencia — o primeiro e o mais diretamente relacionado a pergunta — e podem vir separados em dois niveis: DISPOSITIVOS CENTRAIS e MATERIAL DE APOIO (correlato). Eles sao um UNIVERSO DE CONSULTA, nao um roteiro: o numero de trechos recuperados nunca determina o tamanho nem o formato da resposta — quem determina isso e a pergunta (ver IDENTIFIQUE O TIPO DE RESPOSTA). Trechos consecutivos de um mesmo documento e anexo costumam ser partes (itens, subitens, alineas ou incisos) de um mesmo dispositivo; nesse caso formam uma sequencia continua, na ordem original da norma, e devem ser lidos em conjunto, pois juntos compoem a resposta completa. As anotacoes, os rotulos [Trecho N] e o mecanismo de selecao de trechos sao detalhes internos do sistema e nao fazem parte da resposta.

COMO RESPONDER:

1. A RESPOSTA E ORGANIZADA PELA PERGUNTA, NUNCA PELA NORMA
   Este e o principio que governa todos os outros. O esqueleto da resposta vem da DUVIDA de quem perguntou; a norma entra depois, para sustentar o que voce afirmou.
   Caminho CERTO:  pergunta -> resposta -> explicacao do necessario -> fundamentacao.
   Caminho ERRADO: norma -> resumo do artigo -> resposta implicita no meio do resumo.
   Na pratica isso significa:
   - a primeira frase contem a RESPOSTA, nunca um preambulo sobre o que a norma dispoe;
   - a ordem dos assuntos e a ordem em que a pessoa perguntou, nao a ordem dos artigos, itens ou incisos;
   - se a pergunta tem duas partes ("posso fazer X? ha limite de valor?"), as duas sao respondidas logo na abertura, na mesma ordem;
   - um dispositivo que nao ajuda a responder nao entra, por mais central que pareca no contexto.
   Nunca abra comentando os documentos ("Foram recuperados...", "Os dispositivos encontrados...", "O contexto contem...").
   Nunca abra descrevendo a norma em vez de responder ("A legislacao permite...", "A norma estabelece as diretrizes...", "As regras acerca de X obedecem as seguintes determinacoes...") quando a pergunta admitia um "Sim", um "Nao" ou um numero como primeira palavra.
   Nunca use na resposta termos internos como "Fonte 1", "Trecho 2", "documento principal", "documento complementar", "contexto recuperado".

2. IDENTIFIQUE O TIPO DE RESPOSTA QUE A PERGUNTA PEDE (decida ANTES de escrever)
   Nao classifique a pergunta pelas palavras com que ela comeca, e sim pelo TIPO DE INFORMACAO que a completaria. Sao cinco tipos: os tres primeiros mudam apenas COMO A RESPOSTA ABRE; o quarto muda toda a estrutura; o quinto suspende a redacao.
   a) DECISAO — a resposta e um juizo de permissao, obrigatoriedade ou aplicabilidade: pode/nao pode, e obrigatorio/nao e, aplica-se/nao se aplica, e permitido/e vedado, existe/nao existe — ainda que condicionado a uma excecao ou limite.
   b) QUANTIDADE — a resposta e um numero com a sua unidade: prazo, valor, limite, percentual, quantidade, data.
   c) IDENTIDADE — a resposta e a designacao exata de algo ou de alguem: a empresa, o orgao, o contrato, o documento, o instrumento aplicavel, o responsavel.
   d) CONJUNTO ou PROCEDIMENTO — a resposta e uma serie de elementos ou o encadeamento de uma atividade: rotinas, obrigacoes, requisitos, hipoteses, etapas, prazos ou documentos que compoem um procedimento; ou como executar/compreender uma tarefa administrativa.
   e) REPRODUCAO — pedido explicito de texto literal ("transcreva...", "copie...", "reproduza...", "mostre na integra...", "texto exato...").
   Encaminhamento:
   - (a), (b) e (c) sao RESPOSTAS PONTUAIS -> siga a secao 5A. As tres compartilham a mesma estrutura e diferem somente na forma da ABERTURA (5A.1). NAO use um bloco por dispositivo.
   - (d) -> siga PENSE EM PROCESSO (secao 4) e a ESTRUTURA E FORMATO do modo procedimental (secao 5B). As regras 4, 5B e 6 valem SOMENTE aqui.
   - (e) -> reproduza o texto literalmente, completo e na ordem original; mantenha a numeracao e a estrutura originais (itens, subitens, alineas, incisos); nao resuma, nao reorganize, nao omita e nao acrescente nada.
   PERGUNTA COMPOSTA: uma mesma pergunta pode conter mais de um tipo pontual — "posso fazer X? existe limite de valor?" e DECISAO + QUANTIDADE. A abertura responde TODOS os tipos presentes, na ordem em que foram perguntados. Ter duas partes nao transforma a pergunta em (d).
   DESEMPATE com (d): a resposta cabe em uma frase mais as suas condicoes? Entao NAO e (d). O tipo vem do que foi PERGUNTADO, nunca do volume do que foi recuperado — um contexto com vinte dispositivos correlatos nao transforma uma pergunta de quantidade em pergunta de conjunto.
   Em qualquer tipo: preserve com exatidao numeros, prazos, valores, percentuais e obrigacoes; transcreva literalmente apenas passagens curtas em que a redacao exata importa; e nao copie secoes inteiras da norma quando uma sintese fiel responde a pergunta.

3. LINGUAGEM E REGISTRO (vale em todos os modos)
   Registro INSTITUCIONAL e impessoal — o de um orgao respondendo a uma consulta interna. Nem parecer juridico, nem conversa informal.
   - NAO se dirija ao leitor na segunda pessoa. Evite "voce pode", "voce deve", "no seu caso", "se voce precisar". Use a forma impessoal ou o sujeito institucional: "E possivel...", "Admite-se...", "Exige-se...", "A Administracao podera...", "O prazo maximo e de...", "A contratacao devera...". Numa pergunta de decisao, "Sim." ou "Nao." sozinho ja e a melhor abertura possivel.
   - Fale da ACAO e do seu efeito, nao do texto que a preve. Evite "o dispositivo estabelece", "a norma preceitua", "nos termos do referido artigo", "consoante o disposto no item", "conforme estabelece a norma". A origem tem lugar proprio (ver CITACAO DA FONTE) e nao precisa ser repetida a cada frase.
   - Transicoes curtas que retomam o que ja foi dito, em vez de condicionais longas: prefira "Nessa hipotese", "Nesse caso", "Acima desse limite", "Fora dessa hipotese" a "Caso o valor do servico venha a ultrapassar o limite estabelecido...".
   - Frases curtas e voz ativa. Prefira "o fiscal deve verificar" a "devera ser procedida a verificacao".
   - Jargao: use o termo tecnico que a norma usa (ele e a linguagem do servico), mas explique-o na primeira vez com o que o PROPRIO trecho diz. Ex.: "servicos de pronto pagamento (aqueles de valor nao superior a R$ 10.000,00)". Se o trecho nao definir o termo, use-o sem inventar definicao.
   - Numeros por extenso so quando a norma os traz assim e a exatidao importa; nao repita "(dez mil reais)" a cada mencao.
   - Nao opine, nao recomende e nao avalie o caso do usuario alem do que os trechos sustentam. Um registro mais legivel muda o TOM, nunca o conteudo.
   - Nao use aberturas de conversa nem enfase vazia ("entendo sua duvida", "e importante destacar que", "vale ressaltar", "cumpre esclarecer"). Va direto.

4. PENSE EM PROCESSO, NAO EM DISPOSITIVOS (selecao — SOMENTE no modo procedimental)
   A pergunta e sobre uma tarefa administrativa que alguem precisa executar, nao sobre o que existe no documento. Os trechos recuperados sao um universo de CANDIDATOS, reunidos por proximidade de assunto — nao um roteiro a reproduzir. Recuperar um trecho significa apenas que ele esta disponivel; cabe a voce decidir se ele e necessario para responder.
   Aplique este raciocinio quando a pergunta for sobre executar ou compreender uma atividade ou procedimento; perguntas pontuais (um prazo, um valor, uma definicao) respondem direto.
   Antes de escrever, reconstrua mentalmente o processo perguntado: qual atividade o usuario quer executar, em que escopo e cadencia, e quais sao as suas etapas naturais (o que precisa ser providenciado, executado e verificado, e o que antecede a conclusao). Use como etapas APENAS o que os trechos descrevem — nunca invente fases ou passos. O processo e uma LENTE para selecionar e ordenar; nunca uma fonte de fatos.
   Para cada dispositivo recuperado, decida nesta ordem:
   a) Responde diretamente ao que foi perguntado? -> inclua.
   b) Senao: e uma etapa indispensavel para executar exatamente o processo perguntado, ainda que trate de obrigacao de outra parte (contratada, gestor, fiscal tecnico...) ou de um documento/insumo sem o qual a atividade nao ocorre? -> inclua.
   c) Senao — apenas complementa o assunto, detalha outra modalidade da atividade (ex.: por amostragem), trata de outra fase, de excecoes, de diretrizes gerais ou de procedimentos acessorios? -> NAO entra automaticamente. So aparece se a pergunta pedir explicitamente esse aprofundamento, ou se a sua ausencia tornar impossivel compreender ou executar o processo.
   Omita em silencio o que ficar de fora: nao os cite, nao avise que existem, nao justifique exclusoes.

5A. ESTRUTURA DA RESPOSTA PONTUAL (tipos DECISAO, QUANTIDADE e IDENTIDADE)
   O ESQUELETO VEM DA PERGUNTA (secao 1). Antes de escrever, separe a pergunta nas duvidas que ela contem e trate-as na ordem em que foram feitas. Depois monte:

   1) ABERTURA — as primeiras linhas, sem nenhum titulo antes delas. A PRIMEIRA PALAVRA ja pertence ao tipo de resposta pedido:
      - DECISAO: abra pela propria decisao — "Sim.", "Nao.", "Sim, desde que ...", "Nao, salvo ...". A condicao que qualifica a decisao vem na mesma frase ou na seguinte, nunca antes dela.
      - QUANTIDADE: abra pelo numero com a sua unidade — "O prazo maximo e de 60 (sessenta) meses.", "O limite e de R$ 10.000,00.".
      - IDENTIDADE: abra pela designacao exata, reproduzida como consta no trecho, sem abreviar nem corrigir — "A empresa contratada e a RELUZIR SERVICOS TERCEIRIZADOS LTDA.".
      Regra comum a todos: NADA precede a resposta — nem contextualizacao, nem mencao ao documento, nem reformulacao da pergunta. Quem ler apenas a abertura ja sabe o que fazer.
      Pergunta composta: responda os tipos presentes na ordem em que foram perguntados, ainda na abertura, em uma ou duas frases.
   2) DESENVOLVIMENTO — logo abaixo, o minimo necessario para a resposta ser APLICAVEL ao caso concreto:
      - a regra geral de que a resposta e excecao (ou vice-versa);
      - a condicao, o limite ou a hipotese que delimita a resposta;
      - a SAIDA para o caso que fica FORA da resposta, sempre que os trechos a indicarem: o que passa a ser exigido quando o limite e ultrapassado, a condicao nao se cumpre ou a hipotese nao se aplica. Isso faz parte da resposta — sem essa saida o servidor fica sabendo o que NAO pode, mas nao o que fazer no lugar.
      Escreva em paragrafos curtos; use lista com "- " quando a norma trouxer alternativas ou hipoteses paralelas, nunca para transformar a explicacao num resumo da norma.
      NAO enumere requisitos, condicoes de instrucao processual, etapas ou subitens de um procedimento que a pergunta nao pediu. Isso vale MESMO que eles estejam marcados como DISPOSITIVOS CENTRAIS e MESMO que sejam subitens do proprio dispositivo que responde — a marcacao de centralidade e um sinal interno de recuperacao, nunca uma ordem de cobertura. Se a existencia deles for util para quem perguntou, diga que existem em UMA frase, indicando onde estao (ex.: "a prorrogacao ainda depende do cumprimento dos requisitos de instrucao previstos no proprio Item 3.1"), sem lista-los um a um.
   3) SECOES OPCIONAIS — o desenvolvimento so vira secoes com "## " quando tiver TRES ou mais pontos distintos, ou passar de dois paragrafos. Abaixo disso, texto corrido le melhor: uma resposta curta com titulos vira um relatorio sobre duas frases.
      O titulo diz, em uma ou duas palavras do vocabulario do leitor, O QUE ELE ENCONTRA ali: "## Limite", "## Excecao", "## Consequencia", "## O que fazer acima do limite", "## Quando nao se aplica". NUNCA nomeie o dispositivo, a sua finalidade normativa ou a sua numeracao ("## Do instrumento de contrato", "## Art. 95", "## Regras de formalizacao").
      A proibicao de "categorias inventadas" da secao 5B NAO vale aqui: ela e exclusiva do modo procedimental, onde a unidade de organizacao e o dispositivo. Na resposta pontual a unidade de organizacao e a DUVIDA.
      A abertura (parte 1) nunca fica sob um titulo — ela vem antes de qualquer "## ".
   4) FUNDAMENTACAO — sempre a ultima parte, com o titulo "## Fundamentacao" e, abaixo dele, uma linha por dispositivo, cada uma inteira em negrito, montada com os dados da anotacao de origem: "**<artigo ou item> – <anexo, se houver> – <nome do documento>**" (ex.: "**Art. 95 – Lei no 14.133/2021**", "**Item 10.2 – Anexo VIII-B – IN 05/2017**"). Escreva os valores reais, nunca as palavras-modelo "Anexo Y" ou "Documento Z", e nao prefixe o nome do documento com "Documento".
      Cite APENAS os dispositivos de onde saiu algum fato efetivamente afirmado na resposta. Um dispositivo que voce leu mas nao usou nao entra na fundamentacao — em especial os subitens que voce corretamente deixou de enumerar.
   NAO se aplicam a resposta pontual: a selecao por processo (secao 4), o bloco por dispositivo com titulo e lista (secao 5B) e a cobertura integral de subitens com contagem de blocos (secao 6). Continuam valendo integralmente a LINGUAGEM E REGISTRO (secao 3), a FIDELIDADE (secao 7) e as regras de Markdown de titulo, lista e espacamento (secao 5B).

5B. ESTRUTURA E FORMATO (modo procedimental)
   Depois de selecionar os dispositivos, NAO reorganize o conteudo livremente: a resposta segue obrigatoriamente esta estrutura.
   - So geram bloco os DISPOSITIVOS CENTRAIS que voce selecionar (regra PENSE EM PROCESSO). O que estiver sob "MATERIAL DE APOIO", e o que for correlato, de outra modalidade, diretriz geral ou excecao, NUNCA gera bloco proprio — serve so para referencia cruzada ou quando sua ausencia tornar a resposta impossivel. Estar no contexto nao obriga a virar bloco.
   - Introducao: um unico paragrafo curto resumindo o contexto. Ex: "As rotinas da fiscalizacao mensal previstas no Anexo VIII-B da IN 05/2017 compreendem as seguintes obrigacoes e verificacoes."
   - Depois, um bloco para CADA dispositivo selecionado — exatamente um dispositivo por bloco, neste formato EXATO (inclusive as linhas em branco):

       ## <Nome da atividade / finalidade do dispositivo>

       **Item X – Anexo Y – Documento Z**

       <uma ou duas frases curtas e naturais introduzindo o bloco; aqui SIM cabem tempo e condicao, ex.: "Ao final de cada periodo mensal, o fiscal administrativo devera:">

       - <acao 1>;
       - <acao 2>;
       - <acao 3>.

   - REGRAS DE MARKDOWN (obrigatorias — a resposta e renderizada como Markdown):
     * o titulo do bloco usa exatamente dois sustenidos seguidos de espaco ("## "); nunca use outro nivel de titulo, negrito ou texto solto no lugar dele;
     * a linha imediatamente abaixo do titulo traz SOMENTE a referencia da fonte, inteira em negrito, no formato "**Item X – Anexo Y – Documento Z**" (ex.: "**Item 10.2 – Anexo VIII-B – IN 05/2017**"); inclua apenas os niveis que existirem na anotacao de origem do trecho — sem anexo, escreva "**Item X – Documento Z**";
     * cada obrigacao, acao ou verificacao e um item de lista iniciado por hifen e espaco ("- "); NUNCA use "•", "*", "→", numeros ou qualquer outro marcador;
     * UM item por linha — nunca dois itens na mesma linha, nunca uma lista escrita em texto corrido dentro de um paragrafo;
     * subitens (alineas, incisos, desdobramentos de uma acao) entram como lista aninhada, indentada com dois espacos antes do hifen;
     * deixe UMA linha em branco entre: o paragrafo de introducao e o primeiro bloco; o titulo e a linha de referencia; a linha de referencia e o paragrafo introdutorio; o paragrafo introdutorio e a lista; o fim de um bloco e o titulo do bloco seguinte;
     * priorize a legibilidade: a resposta deve parecer um documento tecnico bem diagramado, nunca um bloco unico de texto.
   - O TITULO nomeia a FINALIDADE do proprio dispositivo (ex.: "Verificacao de Dispendios e Emissao de Relatorio", "Documentacao Mensal da Contratada", "Diretrizes da Fiscalizacao Mensal"). O titulo NAO leva a referencia — ela vive exclusivamente na linha em negrito logo abaixo.
   - PROIBIDO transformar dispositivos em fases do processo ou em categorias inventadas por voce. Nunca use como titulo "Antes do pagamento", "Para recebimento provisorio", "Durante a execucao", "Mensalmente", "Obrigacoes fiscais", "Outras verificacoes", "Fiscalizacao administrativa" e afins — sao interpretacoes suas. Tempo e condicao pertencem ao TEXTO do dispositivo (a frase introdutoria), nunca ao titulo. O titulo representa apenas o dispositivo selecionado.
   - UM DISPOSITIVO = UM BLOCO (regra inviolavel). A unidade de organizacao da resposta e o DISPOSITIVO, nunca o tema. Cada dispositivo selecionado gera exatamente um bloco independente, com titulo, linha de referencia em negrito, frase introdutoria curta e lista de acoes (nunca tudo num unico paragrafo). E PROIBIDO: fundir dois dispositivos num mesmo bloco; incorporar um dispositivo como bullet ou complemento de outro; ocultar ou deduplicar um dispositivo porque trata do mesmo assunto; substituir um dispositivo por um resumo de outro. Se 9, 2.1 e 10.2 foram selecionados, existem obrigatoriamente TRES blocos distintos — a afinidade tematica nunca autoriza fusao.
   - Identidade do bloco: todo o conteudo de um bloco vem EXCLUSIVAMENTE do seu proprio dispositivo; nunca misture obrigacoes de dispositivos diferentes. Errado: descrever as certidoes que a contratada apresenta (Item 2.1) dentro do bloco do Item 10.2. Certo: o Item 2.1 tem o seu proprio bloco, titulado "## Documentacao mensal apresentada pela contratada" e referenciado por "**Item 2.1 – Anexo VIII-B – IN 05/2017**".
   - Independencia: quando dois dispositivos tratam do mesmo assunto (ex.: certidoes), eles continuam sendo obrigacoes distintas e mantem blocos separados. So e permitida REFERENCIA CRUZADA, nunca fusao, deduplicacao, condensacao ou absorcao. Ex.: no bloco do Item 10.2 pode-se escrever "a documentacao correspondente e apresentada pela contratada conforme o Item 2.1" — mas o Item 2.1 mantem o seu proprio bloco.
   - Metadados NAO viram um bloco separado: nao escreva linhas rotuladas "Documento:", "Anexo:", "Item:", "Descricao:" nem "Fonte:". A origem aparece somente na linha de referencia em negrito abaixo do titulo, no formato indicado. Prefira texto natural ("A contratada devera entregar os seguintes documentos:") a rotulos secos.
   - Ordene os blocos pela sequencia LOGICA DO PROCESSO (a ordem em que o agente executa as etapas), e NAO pela ordem numerica dos itens nem pela ordem de recuperacao. Deduza a sequencia dos proprios dispositivos (marcos de tempo/condicao); onde a norma nao indicar ordem, nao invente.
   - Sintetize cada acao de forma curta, sem copiar o texto integral da norma e sem omitir requisitos, prazos ou condicoes (ver COBERTURA). Um rotulo em negrito no inicio do bullet e opcional.
   - Quando a resposta usar um unico dispositivo, gere UM unico bloco no mesmo padrao.

6. COBERTURA COMPLETA DOS DISPOSITIVOS SELECIONADOS (SOMENTE no modo procedimental)
   A completude e medida pelo que a PERGUNTA pede — nunca pelo volume do que foi recuperado. Numa resposta pontual (decisao, quantidade ou identidade), ela esta completa quando o que foi perguntado e as suas condicoes de validade foram ditos; enumerar o procedimento inteiro nao a torna mais completa, torna-a menos util. As regras abaixo valem no modo procedimental, em que o que foi pedido E o conjunto.
   Ai sim a completude vale DENTRO de cada dispositivo que voce selecionou — nunca sobre todo o contexto recuperado. Selecionado um dispositivo, apresente-o por inteiro: todos os subitens, alineas, incisos, listas, obrigacoes, condicoes e excecoes que lhe pertencem. Sintetize a redacao de cada item se ajudar, mas nunca trunque, interrompa nem reduza a quantidade de itens de um dispositivo selecionado, nem omita requisitos, prazos ou condicoes; o fim da lista importa tanto quanto o inicio. Nao condense itens distintos em um so nem os substitua por uma descricao generica ("entre outras rotinas", "diversos procedimentos").
   Antes de finalizar, faca quatro conferencias:
   - Precisao: algum dispositivo entrou apenas por tratar do mesmo tema, sem ocupar uma etapa necessaria do processo? Remova-o.
   - Recall: alguma etapa indispensavel do processo aparece no contexto recuperado mas ficou de fora? Inclua-a.
   - Cobertura: cada dispositivo selecionado foi apresentado integralmente, sem subitem pertinente omitido?
   - Contagem: conte APENAS os dispositivos que voce selecionou como centrais — material de apoio, correlatos, outra modalidade, diretrizes gerais e excecoes NAO contam e NAO viram bloco. O numero de blocos deve COINCIDIR com esse total de selecionados. Se um selecionado foi fundido ou absorvido em outro bloco, separe-o num bloco proprio; se um dispositivo NAO selecionado virou bloco, remova-o. Selecionar continua sendo tarefa da regra PENSE EM PROCESSO — estar no contexto nunca obriga a incluir.

7. FIDELIDADE AO TEXTO NORMATIVO
   Use somente o conteudo dos trechos fornecidos; nao use conhecimento externo.
   O processo que voce reconstroi serve para selecionar e ordenar — nao e fonte de fatos. Etapas, sequencia e vinculos entre dispositivos so podem ser afirmados na medida em que os trechos os sustentam; nao invente ligacoes, causas ou passos que a norma nao declara.
   Nao invente dispositivos, numeros ou continuacoes de texto. Se um trecho contiver o marcador [...], ha texto omitido nesse ponto — nunca o complete.
   Se um dispositivo mencionado nos trechos remeter a um subitem, alinea ou inciso cujo texto NAO esta presente, registre a ausencia em uma nota curta entre parenteses (ex: "(a alinea 'b.1' e referida, mas seu texto nao consta dos trechos disponiveis)") — nunca invente o conteudo ausente nem descarte a referencia em silencio.
   Nao faca interpretacao juridica, recomendacao ou opiniao alem do que a norma diz.
   Se os trechos nao contiverem a informacao perguntada, responda EXATAMENTE:
   "As informacoes disponiveis nao sao suficientes."

   CONFERENCIA FINAL (todos os modos) — refaca a resposta se alguma falhar:
   - A PRIMEIRA PALAVRA pertence ao tipo pedido (a decisao, o numero ou o nome)? Se a resposta comeca contextualizando, comecou pelo lugar errado.
   - A pergunta continha MAIS DE UMA interrogacao ou pedido ("posso...? de onde...? o que acontece se...?")? Entao CADA uma delas precisa de resposta explicita e propria — releia a pergunta clausula a clausula e confira uma a uma. Deixar a ultima interrogacao sem resposta, por ja ter respondido as primeiras, e o erro mais comum.
   - A ordem dos assuntos e a ordem da PERGUNTA, ou virou a ordem dos artigos?
   - Sobrou "voce" dirigido ao leitor, ou alguma frase que narra a norma ("o dispositivo estabelece", "nos termos do artigo") em vez de dizer o que se pode ou se deve fazer?
   - Os titulos "## " existentes ganham a leitura, ou transformaram tres frases num relatorio? Na duvida, remova-os.
   - Toda afirmacao — cada numero, prazo, valor e condicao — sai de algum trecho fornecido? Uma redacao mais natural nunca autoriza afirmar o que os trechos nao dizem: em caso de duvida entre soar melhor e ser fiel, escolha SEMPRE ser fiel.

8. CITACAO DA FONTE
   A origem sai da anotacao interna do trecho, sem inventar dados que nao estejam la e incluindo apenas os niveis que existirem. Onde ela aparece depende do modo:
   - resposta pontual (decisao, quantidade, identidade): agrupada ao final, sob "## Fundamentacao" (secao 5A). O corpo da resposta fica limpo — sem citacao inline e sem referencia no meio das frases.
   - modo procedimental: UMA unica vez por bloco, na linha em negrito imediatamente abaixo do titulo do bloco, no formato "**Item X – Anexo Y – Documento Z**" (ex.: "**Item 10.2 – Anexo VIII-B – IN 05/2017**").
   Em ambos os modos: nao repita a referencia no titulo, nao crie bloco de metadados nem "Fonte:" ao final, e nao interrompa o texto com citacoes inline. Nunca use rotulos internos do sistema (nunca escreva "Trecho N", "Fonte N", "PRINCIPAL" ou "COMPLEMENTAR"). Cite apenas dispositivos efetivamente usados e reproduza exatamente a numeracao que aparece nos trechos.

--- TRECHOS DOS DOCUMENTOS (uso interno) ---
${contextBlock}
--- FIM DOS TRECHOS ---

Pergunta: ${userQuery}

Resposta:`;
}

@Injectable()
export class RagService implements OnModuleInit {
  private readonly logger = new Logger(RagService.name);
  private vectorStore!: PGVectorStore;
  private llm!: ChatGoogleGenerativeAI;
  private embeddings!: NativeGeminiEmbeddings;

  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    const apiKey = process.env.GOOGLE_API_KEY;

    if (!apiKey) {
      this.logger.error('Variavel GOOGLE_API_KEY nao encontrada no .env');
      return;
    }

    this.embeddings = new NativeGeminiEmbeddings(apiKey);

    this.llm = new ChatGoogleGenerativeAI({
      apiKey,
      model: 'gemini-3.6-flash',
      // Reproducao literal de texto normativo pede decodificacao conservadora:
      // temperatura alta amplia parafrase e reorganizacao de listas.
      temperature: 0.1,
      // Teto de saida explicito: a transcricao integral de dois ou mais itens
      // longos nao pode ser cortada pelo limite default — corte no meio da
      // lista forca o modelo a "fechar resumindo".
      maxOutputTokens: 8192,
      // gemini-2.5-flash habilita "thinking" dinamico por padrao, e os tokens
      // de raciocinio disputam o mesmo orcamento de maxOutputTokens. Sem limite,
      // uma pergunta enumerativa longa pode gastar o orcamento pensando e a
      // resposta terminar cortada (finishReason=MAX_TOKENS). Um teto modesto de
      // thinking preserva raciocinio suficiente para a checagem de cobertura e
      // garante folga para a resposta final.
      thinkingConfig: { thinkingBudget: 2048 },
      safetySettings: [
        {
          category: HarmCategory.HARM_CATEGORY_HARASSMENT,
          threshold: HarmBlockThreshold.BLOCK_NONE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
          threshold: HarmBlockThreshold.BLOCK_NONE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
          threshold: HarmBlockThreshold.BLOCK_NONE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
          threshold: HarmBlockThreshold.BLOCK_NONE,
        },
      ],
    });

    this.vectorStore = await PGVectorStore.initialize(this.embeddings, {
      postgresConnectionOptions: {
        type: 'postgres',
        connectionString: process.env.DATABASE_URL,
      } as PoolConfig,
      tableName: 'documentos_vetorizados',
      columns: {
        idColumnName: 'id',
        vectorColumnName: 'embedding',
        contentColumnName: 'text',
        metadataColumnName: 'metadata',
      },
    });

    this.logger.log(
      'RAG Service inicializado (Gemini 2.5 + pgvector + PDR persistido)',
    );
  }

  // -------------------------------------------------------------------------
  // Ingestao: limpeza -> chunking -> persiste parents no PG -> indexa children
  //
  // `pages` (opcional) sao as paginas do PDF na ordem de extracao. Elas NAO
  // participam do chunking — o texto dividido continua sendo exatamente o
  // mesmo de antes — e servem so para construir o mapa de paginas que da
  // localizacao as fontes. Sem elas, a indexacao roda igual e os trechos ficam
  // com localizacao por caractere, sem pagina.
  // -------------------------------------------------------------------------
  async indexDocument(
    rawContent: string,
    documentId: string,
    title: string,
    pages?: PageInput[],
  ): Promise<{
    success: boolean;
    documentId: string;
    sections: number;
    childChunks: number;
    pagesMapped: number;
    locatedSections: number;
  }> {
    // O vocabulario de de-hifenizacao vem do documento INTEIRO e e reaproveitado
    // na limpeza de cada pagina: limpar a pagina isolada com outro vocabulario
    // produziria um texto que nao casa com o do documento e o mapa de paginas
    // se perderia.
    const vocabulary = collectAttestedWords(stripInvisibleArtifacts(rawContent));
    const cleanedText = cleanExtractedText(rawContent, vocabulary);
    const chunks = splitLegalDocument(cleanedText);

    // Coordenadas de tudo o que e localizado daqui para baixo: offsets neste
    // texto limpo, guardado em NormativeDocument.indexed_content.
    const docIndex = buildNormalizedIndex(cleanedText);
    const pageMap = pages?.length
      ? buildPageMap(
          docIndex,
          pages.map((page) => ({
            page: page.page,
            text: cleanExtractedText(page.text, vocabulary),
          })),
        )
      : [];

    // Cada chunk emitido pelo splitter e localizado uma unica vez, em ordem —
    // e o cursor monotonico de locateSequentialSegments que faz dispositivos de
    // texto identico (frequentes em normas) caiam cada um no seu lugar.
    const chunkRanges = locateSequentialSegments(
      docIndex,
      chunks.map((chunk) => chunk.content),
    );

    // Persistido ANTES da vetorizacao (lenta e sujeita a rate limit): o
    // visualizador e as coordenadas das fontes nao dependem dos embeddings.
    // updateMany nao falha quando o documento nao existe — indexDocument
    // tambem e chamado em cenarios de teste/reprocessamento avulso.
    await this.prisma.normativeDocument.updateMany({
      where: { id: documentId },
      data: {
        indexed_content: cleanedText,
        page_map: pageMap.length
          ? (pageMap as unknown as Prisma.InputJsonValue)
          : undefined,
        total_pages: pages?.length
          ? Math.max(...pages.map((page) => page.page))
          : undefined,
      },
    });

    let totalChildren = 0;
    let locatedSections = 0;

    type GroupEntry = {
      n1_header: string;
      n2_header: string;
      sectionHeader: string;
      contentParts: string[];
      partRanges: Array<CharRange | null>;
    };

    const groupMap = new Map<string, GroupEntry>();

    chunks.forEach((chunk, i) => {
      const { n1_header, n2_header } = chunk.metadata;
      const key = `${n1_header}|||${n2_header}`;

      if (!groupMap.has(key)) {
        groupMap.set(key, {
          n1_header,
          n2_header,
          sectionHeader: (n2_header || n1_header || SECTION_HEADER_FALLBACK).slice(0, 255),
          contentParts: [],
          partRanges: [],
        });
      }

      const group = groupMap.get(key)!;
      group.contentParts.push(chunk.content);
      group.partRanges.push(chunkRanges[i]);
    });

    // Cabecalho descritivo de cada anexo/secao = o grupo de "preambulo" (sem
    // item, n2 vazio), cujo conteudo costuma trazer o tema da secao. Serve
    // APENAS para contextualizar o embedding dos children (buildChunkEmbedText);
    // nao altera parents, metadados nem filtros. Se um anexo nao tiver preambulo
    // (titulo inline descartado no split), o lookup cai no rotulo n1_header.
    // A chave vazia ('') tambem entra: documentos SEM estrutura de anexo/secao
    // (ex.: termos de contrato) usam o preambulo do proprio documento — o
    // cabecalho de abertura ("TERMO DE CONTRATO DE PRESTACAO DE SERVICOS...")
    // — como contexto de TODOS os seus children.
    const sectionHeadingByN1 = new Map<string, string>();
    for (const entry of groupMap.values()) {
      if (
        entry.n2_header === '' &&
        !sectionHeadingByN1.has(entry.n1_header)
      ) {
        const preamble = entry.contentParts
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 200);
        if (preamble) sectionHeadingByN1.set(entry.n1_header, preamble);
      }
    }

    const allChildDocs: Document[] = [];

    for (const entry of groupMap.values()) {
      // O splitter emite o texto integro de cada grupo estrutural; o parent
      // persiste esse texto sem alteracao. Os children sao derivados DEPOIS,
      // como janelas sobre o conteudo final do parent — assim todo child e
      // substring exata do parent e o parent nunca contem texto duplicado.
      const fullContent = entry.contentParts.join('\n');

      const locatedParts = buildLocatedParts(entry.contentParts, entry.partRanges);
      const parentRange = mergeRanges(entry.partRanges);
      if (parentRange) locatedSections++;

      const savedParent = await this.prisma.parentChunk.create({
        data: {
          document_id: documentId,
          section_header: entry.sectionHeader,
          content: fullContent,
          metadata: {
            documentId,
            title,
            n1_header: entry.n1_header,
            n2_header: entry.n2_header,
            ...locationMetadata(parentRange, resolvePageSpan(pageMap, parentRange)),
          },
        },
      });

      const childChunks: ChildChunk[] =
        fullContent.length > CHILD_CHUNK_SIZE
          ? splitIntoChildChunksWithOffsets(fullContent)
          : [{ content: fullContent, start: 0, end: fullContent.length }];

      for (const child of childChunks) {
        // Localizacao do PROPRIO child: e ele que a busca vetorial recupera, e
        // e a regiao dele que fundamenta a resposta. A janela do child e
        // conhecida por construcao (offsets da janela deslizante), entao a
        // conversao para as coordenadas do documento e deterministica.
        const childRange = locateInDocument(
          docIndex,
          locatedParts,
          child.start,
          child.end,
        );

        allChildDocs.push(
          new Document({
            pageContent: child.content,
            metadata: {
              documentId,
              title,
              parentId: savedParent.id,
              n1_header: entry.n1_header,
              n2_header: entry.n2_header,
              ...locationMetadata(childRange, resolvePageSpan(pageMap, childRange)),
            },
          }),
        );
      }
    }

    const batches = chunkArray(allChildDocs, EMBEDDING_BATCH_SIZE);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      this.logger.log(
        `[RAG] Vetorizando lote ${i + 1}/${batches.length} (${batch.length} chunks)...`,
      );

      let attempt = 0;
      while (attempt < EMBEDDING_MAX_RETRIES) {
        try {
          // Vetoriza o texto COM contexto estrutural; ARMAZENA o texto cru.
          // addVectors desacopla o que e embutido do que e persistido: o
          // pageContent de `batch` (conteudo cru) vai para a coluna de texto,
          // enquanto o vetor vem do texto contextualizado.
          const embedTexts = batch.map((doc) => {
            const md = doc.metadata as Record<string, any>;
            const heading =
              sectionHeadingByN1.get(md.n1_header) ?? md.n1_header;
            return buildChunkEmbedText(doc.pageContent, {
              title: md.title,
              sectionHeading: heading,
              item: md.n2_header,
            });
          });
          const vectors = await this.embeddings.embedDocuments(embedTexts);
          await this.vectorStore.addVectors(vectors, batch);
          totalChildren += batch.length;
          break;
        } catch (err: any) {
          const is429 =
            err?.status === 429 ||
            String(err?.message).includes('429') ||
            String(err?.message).toLowerCase().includes('quota');

          if (is429 && attempt < EMBEDDING_MAX_RETRIES - 1) {
            this.logger.warn(
              `[RAG] Rate limit (429) no lote ${i + 1}. Aguardando ${EMBEDDING_RETRY_DELAY / 1000}s...`,
            );
            await delay(EMBEDDING_RETRY_DELAY);
            attempt++;
          } else {
            throw err;
          }
        }
      }

      if (i < batches.length - 1) await delay(EMBEDDING_BATCH_DELAY);
    }

    this.logger.log(
      `Indexado: "${title}" — ${groupMap.size} parents consolidados, ${totalChildren} child chunks vetorizados, ` +
        `${locatedSections}/${groupMap.size} secoes localizadas, ${pageMap.length} faixa(s) de pagina`,
    );

    return {
      success: true,
      documentId,
      sections: groupMap.size,
      childChunks: totalChildren,
      pagesMapped: pageMap.length,
      locatedSections,
    };
  }

  // -------------------------------------------------------------------------
  // backfillDocumentLocations
  //
  // Recalcula as COORDENADAS de um documento ja indexado, sem tocar nos
  // embeddings, nos ParentChunks ou no retrieval: reconstroi o texto limpo a
  // partir de original_content e localiza cada ParentChunk existente nele.
  //
  // O que isto recupera para documentos antigos: o texto indexado (para o
  // visualizador) e char_start/char_end de cada dispositivo. O que NAO
  // recupera: paginas (a extracao antiga concatenava as paginas e a divisao se
  // perdeu) e a localizacao fina por child chunk (esta vive nos vetores). Para
  // esses dois, so reenviando o documento.
  // -------------------------------------------------------------------------
  async backfillDocumentLocations(documentId: string): Promise<{
    documentId: string;
    parents: number;
    located: number;
  }> {
    const document = await this.prisma.normativeDocument.findUnique({
      where: { id: documentId },
      select: { id: true, original_content: true },
    });
    if (!document) {
      throw new NotFoundException('Documento nao encontrado');
    }

    const cleanedText = cleanExtractedText(document.original_content);
    const docIndex = buildNormalizedIndex(cleanedText);

    // A ordem de criacao dos parents e a ordem em que o splitter os emitiu, que
    // e a ordem do documento — condicao do cursor monotonico da localizacao.
    const parents = await this.prisma.parentChunk.findMany({
      where: { document_id: documentId },
      orderBy: { created_at: 'asc' },
    });

    const ranges = locateSequentialSegments(
      docIndex,
      parents.map((parent) => parent.content),
    );

    let located = 0;
    for (let i = 0; i < parents.length; i++) {
      const range = ranges[i];
      if (!range) continue;
      located++;
      await this.prisma.parentChunk.update({
        where: { id: parents[i].id },
        data: {
          metadata: {
            ...((parents[i].metadata as Prisma.JsonObject) ?? {}),
            ...locationMetadata(range, null),
          },
        },
      });
    }

    await this.prisma.normativeDocument.update({
      where: { id: documentId },
      data: { indexed_content: cleanedText },
    });

    this.logger.log(
      `[RAG] Backfill de localizacao em ${documentId}: ${located}/${parents.length} parents localizados`,
    );

    return { documentId, parents: parents.length, located };
  }

  private async retrieveParentContexts(
    userQuery: string,
    k = RETRIEVAL_FETCH_K,
  ) {
    const queryVec = await this.embeddings.embedQuery(userQuery);

    // [TRACE 1] Query e embedding
    trace('\n[TRACE 1] userQuery:', userQuery);
    trace(
      `[TRACE 1] embedding: dim=${queryVec.length} | primeiros valores=[${queryVec
        .slice(0, 5)
        .map((v) => v.toFixed(6))
        .join(', ')}]`,
    );

    let filter: any = undefined;
    const anexoMatch = userQuery.match(/(?:Anexo)\s+([IVXLCDM]+(?:-[A-Z])?)/i);
    if (anexoMatch) {
      filter = { n1_header: anexoMatch[0].toUpperCase() };
    }

    // [TRACE 2] Filtro final enviado para a busca vetorial
    trace(
      '[TRACE 2] filter enviado para similaritySearchVectorWithScore:',
      JSON.stringify(filter ?? null),
    );

    let childResults = await this.vectorStore.similaritySearchVectorWithScore(
      queryVec,
      k,
      filter,
    );

    // Fallback de recall: o filtro de Anexo usa igualdade exata sobre
    // n1_header — "ANEXO VIII" nao casa com "ANEXO VIII-B". Se a busca
    // filtrada nao retornar nada, refaz sem filtro em vez de terminar em
    // "informacoes insuficientes" por um detalhe de grafia.
    if (filter && childResults.length === 0) {
      trace('[TRACE 2b] Busca filtrada sem resultados — refazendo sem filtro');
      childResults = await this.vectorStore.similaritySearchVectorWithScore(
        queryVec,
        k,
      );
    }

    // [TRACE 3] Child chunks retornados pela busca vetorial
    if (DEBUG_RAG) {
      trace(`\n[TRACE 3] ${childResults.length} child chunk(s) retornados:`);
      childResults.forEach(([child, score], i) => {
        trace(
          `  [${i + 1}] score=${score.toFixed(6)}` +
            ` | n1="${child.metadata.n1_header ?? ''}"` +
            ` | n2="${child.metadata.n2_header ?? ''}"` +
            ` | parentId=${child.metadata.parentId}` +
            ` | preview="${child.pageContent.slice(0, 120).replace(/\n/g, ' ')}"`,
        );
      });
    }

    const parentIds = new Set<string>();
    const orderedParentIds: string[] = [];
    const scoreByParentId = new Map<string, number>();
    for (const [child, score] of childResults) {
      const parentId = child.metadata.parentId as string | undefined;
      if (parentId && !parentIds.has(parentId)) {
        parentIds.add(parentId);
        orderedParentIds.push(parentId);
      }
      // Guarda o MELHOR score (menor distancia) entre os childs do parent.
      // Antes cada child sobrescrevia o anterior e o parent terminava com o
      // score do PIOR child recuperado — invertendo prioridades no boost
      // hierarquico e na heranca de score da expansao de irmaos.
      if (parentId) {
        const prev = scoreByParentId.get(parentId);
        if (prev === undefined || score < prev)
          scoreByParentId.set(parentId, score);
      }
    }

    // [TRACE 4] Ordem de insercao dos parentIds no Set
    if (DEBUG_RAG) {
      trace('\n[TRACE 4] Ordem de insercao dos parentIds no Set:');
      orderedParentIds.forEach((pid, i) => trace(`  ${i + 1} -> ${pid}`));
    }

    const parentRows = await this.prisma.parentChunk.findMany({
      where: { id: { in: orderedParentIds } },
    });

    const parentMap = new Map(parentRows.map((row) => [row.id, row]));
    let orderedParentRows = orderedParentIds
      .map((id) => parentMap.get(id)!)
      .filter((row) => row && row.content.length >= MIN_PARENT_CONTENT_LENGTH);

    const siblingExpansionGroups = new Map<
      string,
      {
        documentId: string;
        n1Header: string;
        parentPrefix: string;
        parentNumbers: number[];
        level: number;
        bestScore: number;
        retrievedIds: Set<string>;
        // Ultimo componente numerico dos itens recuperados do grupo
        // (ex: 10.2. -> 2). Usado para expandir apenas os irmaos mais
        // proximos numericamente dos itens que o retriever de fato encontrou.
        retrievedLastNumbers: number[];
      }
    >();

    for (const row of orderedParentRows) {
      const n2Header = getN2Header(row);
      const prefixInfo = deriveSiblingPrefix(n2Header);
      if (!prefixInfo) continue;

      // deriveSiblingPrefix != null garante parse valido de n2Header
      const parsedN2 = parseItemNumber(n2Header)!;
      const lastNumber = parsedN2.numbers[parsedN2.numbers.length - 1];

      const groupKey = `${row.document_id}|||${getN1Header(row)}|||${prefixInfo.parentPrefix}|||${prefixInfo.level}`;
      const score = scoreByParentId.get(row.id) ?? Infinity;
      const existingGroup = siblingExpansionGroups.get(groupKey);

      if (!existingGroup) {
        siblingExpansionGroups.set(groupKey, {
          documentId: row.document_id,
          n1Header: getN1Header(row),
          parentPrefix: prefixInfo.parentPrefix,
          parentNumbers: prefixInfo.parentNumbers,
          level: prefixInfo.level,
          bestScore: score,
          retrievedIds: new Set([row.id]),
          retrievedLastNumbers: [lastNumber],
        });
      } else {
        existingGroup.retrievedIds.add(row.id);
        existingGroup.bestScore = Math.min(existingGroup.bestScore, score);
        existingGroup.retrievedLastNumbers.push(lastNumber);
      }
    }

    const siblingParents: ParentChunkRow[] = [];
    if (siblingExpansionGroups.size > 0) {
      for (const group of siblingExpansionGroups.values()) {
        const candidates = await this.prisma.parentChunk.findMany({
          where: {
            document_id: group.documentId,
            metadata: { path: ['n1_header'], equals: group.n1Header },
            section_header: { startsWith: group.parentPrefix },
          },
        });

        const validCandidates: Array<{
          row: ParentChunkRow;
          distance: number;
        }> = [];

        for (const candidate of candidates) {
          if (group.retrievedIds.has(candidate.id)) continue;
          if (candidate.content.length < MIN_PARENT_CONTENT_LENGTH) continue;

          const candidateHeader = getN2Header(candidate);
          const parsedCandidate = parseItemNumber(candidateHeader);
          if (!parsedCandidate || parsedCandidate.level !== group.level)
            continue;
          if (
            !group.parentNumbers.every(
              (value, idx) => parsedCandidate.numbers[idx] === value,
            )
          )
            continue;

          const candidateLast =
            parsedCandidate.numbers[parsedCandidate.numbers.length - 1];
          const distance = Math.min(
            ...group.retrievedLastNumbers.map((n) =>
              Math.abs(candidateLast - n),
            ),
          );
          validCandidates.push({ row: candidate, distance });
        }

        // Teto de expansao: apenas os MAX_SIBLINGS_PER_GROUP irmaos mais
        // proximos numericamente dos itens recuperados (10.2 -> 10.1 e 10.3
        // antes de 10.9). Irmaos distantes raramente completam a resposta e
        // consomem o orcamento de contexto de parents relevantes.
        validCandidates.sort((a, b) => a.distance - b.distance);
        for (const { row } of validCandidates.slice(
          0,
          MAX_SIBLINGS_PER_GROUP,
        )) {
          siblingParents.push(row);
          scoreByParentId.set(row.id, group.bestScore);
        }
      }
    }

    // -----------------------------------------------------------------------
    // Expansao DESCENDENTE — filhos diretos de cada item do conjunto candidato
    //
    // A expansao de irmaos acima so alcanca itens do MESMO nivel (10.2 -> 10.1,
    // 10.3) — ela rejeita candidatos de nivel diferente. Mas um item nao-folha
    // como "10.2" costuma conter apenas o caput; os subitens que de fato
    // compoem a resposta ("10.2.1", "10.2.2", ...) vivem em parents-filhos
    // separados, de nivel mais profundo. Sem esta passagem o retriever traz o
    // TITULO do dispositivo mas nao o seu conteudo enumerado, e a resposta sai
    // incompleta mesmo com o contexto "certo" recuperado.
    //
    // A descida vale para HITS e tambem para IRMAOS trazidos pela expansao: um
    // irmao cujo caput termina numa enumeracao ("a Contratante retera:") chega
    // inutil sem os filhos que a completam (12.7 sem 12.7.1/12.7.2). Filhos de
    // hit herdam proveniencia DESCENDANT (centrais); filhos de irmao herdam
    // SIBLING (apoio, como o proprio irmao).
    // -----------------------------------------------------------------------
    const descendantParents: ParentChunkRow[] = [];
    const siblingDescendantParents: ParentChunkRow[] = [];
    const alreadySelectedIds = new Set<string>([
      ...orderedParentRows.map((row) => row.id),
      ...siblingParents.map((row) => row.id),
    ]);

    const expansionSources: Array<{ row: ParentChunkRow; viaSibling: boolean }> = [
      ...orderedParentRows.map((row) => ({ row, viaSibling: false })),
      ...siblingParents.map((row) => ({ row, viaSibling: true })),
    ];

    for (const { row, viaSibling } of expansionSources) {
      const parsedSelf = parseItemNumber(getN2Header(row));
      if (!parsedSelf) continue;

      const childPrefix = `${parsedSelf.numbers.join('.')}.`; // "10.2." -> filhos "10.2.x"
      const childLevel = parsedSelf.level + 1;

      const children = await this.prisma.parentChunk.findMany({
        where: {
          document_id: row.document_id,
          metadata: { path: ['n1_header'], equals: getN1Header(row) },
          section_header: { startsWith: childPrefix },
        },
      });

      const directChildren: ParentChunkRow[] = [];
      for (const child of children) {
        if (alreadySelectedIds.has(child.id)) continue;
        if (child.content.length < MIN_PARENT_CONTENT_LENGTH) continue;

        const parsedChild = parseItemNumber(getN2Header(child));
        // Apenas filhos DIRETOS: um nivel abaixo e com o prefixo numerico do
        // item batendo exatamente (exclui netos e vizinhos como "10.20").
        if (!parsedChild || parsedChild.level !== childLevel) continue;
        if (
          !parsedSelf.numbers.every(
            (value, idx) => parsedChild.numbers[idx] === value,
          )
        )
          continue;

        directChildren.push(child);
      }

      // Herda o score do pai: os filhos completam o MESMO dispositivo e nao
      // devem afundar na priorizacao por nao terem hit vetorial proprio.
      const inheritedScore = scoreByParentId.get(row.id) ?? Infinity;
      for (const child of sortParentsByStructuralOrder(directChildren).slice(
        0,
        MAX_DESCENDANTS_PER_ITEM,
      )) {
        (viaSibling ? siblingDescendantParents : descendantParents).push(child);
        alreadySelectedIds.add(child.id);
        scoreByParentId.set(child.id, inheritedScore);
      }
    }

    if (
      siblingParents.length > 0 ||
      descendantParents.length > 0 ||
      siblingDescendantParents.length > 0
    ) {
      const parentsByGroup = new Map<string, ParentChunkRow[]>();
      const groupOrder: string[] = [];

      const appendParent = (parent: ParentChunkRow) => {
        const key = `${parent.document_id}|||${getN1Header(parent)}`;
        if (!parentsByGroup.has(key)) {
          parentsByGroup.set(key, []);
          groupOrder.push(key);
        }
        const groupRows = parentsByGroup.get(key)!;
        if (!groupRows.some((row) => row.id === parent.id)) {
          groupRows.push(parent);
        }
      };

      orderedParentRows.forEach(appendParent);
      siblingParents.forEach(appendParent);
      descendantParents.forEach(appendParent);
      siblingDescendantParents.forEach(appendParent);

      // Ordenacao estrutural dentro do grupo garante caput antes dos filhos e
      // filhos em ordem (10.2 -> 10.2.1 -> 10.2.2), reconstituindo a leitura
      // continua do dispositivo.
      orderedParentRows = groupOrder.flatMap((key) =>
        sortParentsByStructuralOrder(parentsByGroup.get(key)!),
      );
    }

    // -----------------------------------------------------------------------
    // Coerencia de anexo — remove contaminacao de processo administrativo
    // vizinho (ex.: o Item 4 do ANEXO V-B, rotina do fiscal TECNICO, entrando
    // numa resposta cujo processo dominante e o ANEXO VIII-B, do fiscal
    // ADMINISTRATIVO). O sinal e a contagem de hits do RETRIEVER por escopo
    // (documento + anexo), medida ANTES da expansao — que infla ambos.
    // -----------------------------------------------------------------------
    // A contagem e por CHILD HIT, nao por parent: um dispositivo longo aparece
    // no Top-K com varios childs que colapsam num unico parent, e contar
    // parents faria esse dispositivo — justamente o mais recuperado — valer
    // "1" contra escopos irrelevantes com dois parents curtos.
    const retrievedScopeHits = new Map<string, number>();
    for (const [child] of childResults) {
      const pid = child.metadata.parentId as string | undefined;
      const row = pid ? parentMap.get(pid) : undefined;
      if (!row || row.content.length < MIN_PARENT_CONTENT_LENGTH) continue;
      const scopeKey = `${row.document_id}|||${getN1Header(row)}`;
      retrievedScopeHits.set(
        scopeKey,
        (retrievedScopeHits.get(scopeKey) ?? 0) + 1,
      );
    }
    // Escopo do hit de melhor score — imune a poda (ver pruneForeignAnexoContamination).
    let topScope: string | undefined;
    let topScoreSeen = Infinity;
    for (const id of orderedParentIds) {
      const row = parentMap.get(id);
      if (!row || row.content.length < MIN_PARENT_CONTENT_LENGTH) continue;
      const score = scoreByParentId.get(id) ?? Infinity;
      if (score < topScoreSeen) {
        topScoreSeen = score;
        topScope = `${row.document_id}|||${getN1Header(row)}`;
      }
    }
    const beforePrune = orderedParentRows.length;
    orderedParentRows = pruneForeignAnexoContamination(
      orderedParentRows,
      retrievedScopeHits,
      topScope,
    );
    if (DEBUG_RAG && orderedParentRows.length !== beforePrune) {
      trace(
        `[COERENCIA] Removidos ${beforePrune - orderedParentRows.length} parent(s) de anexo estranho ao processo dominante`,
      );
    }

    // -----------------------------------------------------------------------
    // Selecao por PROVENIENCIA (substitui a marcacao PRINCIPAL/COMPLEMENTAR por
    // score). Cada dispositivo carrega COMO entrou no conjunto candidato:
    //   HIT        = acerto direto da busca vetorial;
    //   DESCENDANT = filho de um hit — completa o mesmo dispositivo -> central;
    //   SIBLING    = irmao trazido pela expansao (vizinho numerico) -> apoio.
    // Politica (rankByProvenance): HIT ou DESCENDANT => PRINCIPAL; so SIBLING =>
    // COMPLEMENTAR. Excecao: um HIT cujo score fica muito atras do HIT mais
    // forte dentro da MESMA familia de irmaos (ex.: duas "modalidades" do
    // mesmo item pai) tambem vira COMPLEMENTAR — o retriever ja sinalizou, pelo
    // score, que ele e um carona por vocabulario compartilhado, nao o
    // dispositivo pedido (ver SIBLING_HIT_DOMINANCE_FRACTION). Nada e removido
    // — apenas a prioridade para a geracao muda, com os centrais a frente.
    // Deterministica, auditavel e geral (usa so a arvore do documento e o
    // score ja calculado, nunca regras por norma).
    // Construida ANTES do flatten: a selecao sob teto usa a mesma proveniencia
    // para dar precedencia a HITs sobre material de expansao.
    // -----------------------------------------------------------------------
    const provenanceById = new Map<string, Set<Provenance>>();
    const addProvenance = (id: string, p: Provenance) => {
      const set = provenanceById.get(id) ?? new Set<Provenance>();
      set.add(p);
      provenanceById.set(id, set);
    };
    for (const id of orderedParentIds) addProvenance(id, 'HIT');
    for (const row of descendantParents) addProvenance(row.id, 'DESCENDANT');
    for (const row of siblingParents) addProvenance(row.id, 'SIBLING');
    // Filhos trazidos para completar um IRMAO herdam o papel do irmao (apoio):
    // completam um dispositivo de apoio, nao um dispositivo central.
    for (const row of siblingDescendantParents) addProvenance(row.id, 'SIBLING');

    // Prioridade de SELECAO no flatten (menor = mais prioritario): acertos
    // diretos primeiro, depois filhos que completam um hit, por fim irmaos.
    const selectionPriority = (row: ParentChunkRow): number => {
      const prov = provenanceById.get(row.id);
      if (!prov || prov.has('HIT')) return 0;
      if (prov.has('DESCENDANT')) return 1;
      return 2;
    };

    const clusters = buildClusters(orderedParentRows, scoreByParentId);
    const boostedClusters = applyHierarchicalBoost(clusters);
    const boostedParents = flattenClusters(boostedClusters, selectionPriority);
    const parentsToUse = boostedParents.length
      ? boostedParents
      : orderedParentRows;

    const ranked = rankByProvenance(parentsToUse, provenanceById, scoreByParentId);
    const orderedForPrompt = ranked.map((r) => r.row);
    const roleById = new Map(ranked.map((r) => [r.row.id, r.role] as const));

    // [PROVENIENCIA] auditoria: origem e classificacao de cada dispositivo
    if (DEBUG_RAG) {
      trace('\n[PROVENIENCIA] classificacao por origem no conjunto candidato:');
      ranked.forEach((r) =>
        trace(
          `  ${r.role.padEnd(11)} | origem=[${r.provenance.join(',') || 'desconhecida'}]` +
          ` | section="${r.row.section_header}" | parentId=${r.row.id}`,
        ),
      );
    }

    // [TRACE 5] Ordem retornada pelo Prisma
    if (DEBUG_RAG) {
      trace('\n[TRACE 5] Ordem retornada pelo Prisma (parentChunk.findMany):');
      parentRows.forEach((row, i) =>
        trace(
          `  [${i + 1}] id=${row.id} | section="${row.section_header}" | chars=${row.content.length}`,
        ),
      );
      const prismaPreservedOrder = orderedParentIds.every(
        (pid, i) => parentRows[i]?.id === pid,
      );
      trace(
        `[TRACE 5] O Prisma preservou a ordem dos parentIds? ${prismaPreservedOrder ? 'SIM' : 'NAO'}`,
      );
      trace('  (esperado):', orderedParentIds.join(' -> '));
      trace('  (recebido):', parentRows.map((r) => r.id).join(' -> '));
    }

    // TODOS os childs recuperados de cada parent — nao apenas o melhor. Quando
    // o retriever encontra varias regioes do MESMO dispositivo (tipico de um
    // artigo longo com muitos incisos e paragrafos), todas elas sao relevantes
    // e a janela precisa cobri-las; ancorar so no primeiro child cortava o
    // resto do artigo (no Art. 75 da Lei 14.133, os §§ 1º a 3º ficavam de fora
    // de uma pergunta que dependia deles).
    const triggeringChildrenByParentId = new Map<string, Document[]>();
    for (const [child] of childResults) {
      const pid = child.metadata.parentId as string | undefined;
      if (!pid) continue;
      const list = triggeringChildrenByParentId.get(pid) ?? [];
      list.push(child);
      triggeringChildrenByParentId.set(pid, list);
    }

    const parents = orderedForPrompt.map((row) => {
      const triggeringChildren = triggeringChildrenByParentId.get(row.id) ?? [];
      let pageContent = row.content;

      // Janela deslizante apenas para parents grandes demais para o prompt.
      // Parents ate SLIDING_WINDOW_MIN_PARENT_LENGTH entram INTEGROS — o
      // parent que disparou o hit e o trecho mais relevante e nao deve ser
      // truncado. Nos grandes, a janela cobre do PRIMEIRO ao ULTIMO trecho
      // recuperado, com anchor progressivo tolerante a whitespace e bordas
      // ajustadas para fronteiras de sentenca.
      if (
        triggeringChildren.length > 0 &&
        row.content.length > SLIDING_WINDOW_MIN_PARENT_LENGTH
      ) {
        let firstAnchor = Infinity;
        let lastAnchorEnd = -Infinity;
        for (const child of triggeringChildren) {
          const idx = findAnchorIndex(row.content, child.pageContent);
          if (idx === -1) continue;
          firstAnchor = Math.min(firstAnchor, idx);
          lastAnchorEnd = Math.max(idx + child.pageContent.length, lastAnchorEnd);
        }
        const startIndex = Number.isFinite(firstAnchor) ? firstAnchor : -1;

        if (startIndex !== -1) {
          let windowStart = Math.max(0, startIndex - SLIDING_WINDOW_BEFORE);
          let windowEnd = Math.min(
            row.content.length,
            lastAnchorEnd + SLIDING_WINDOW_AFTER,
          );
          windowStart = snapWindowStart(row.content, windowStart);
          windowEnd = snapWindowEnd(row.content, windowEnd);
          const slice = row.content.substring(windowStart, windowEnd);
          const prefix = windowStart > 0 ? '[...] ' : '';
          const suffix = windowEnd < row.content.length ? ' [...]' : '';
          pageContent = `${prefix}${slice}${suffix}`;
        }
      }

      // Localizacao no documento, do mais fino para o mais grosso:
      //   - excerpt*: uniao dos child chunks que a busca vetorial recuperou —
      //     a regiao que de fato fundamentou a resposta;
      //   - char*/page*: o dispositivo inteiro (ParentChunk).
      // Ambas vem de metadados gravados na ingestao; nada e recalculado nem
      // estimado aqui. Um dispositivo trazido pela expansao hierarquica nao tem
      // child recuperado e fica so com a localizacao do dispositivo; um
      // documento indexado antes desta funcionalidade nao tem nenhuma das duas.
      const parentRange = readCharRange(row.metadata);
      const parentPages = readPageSpan(row.metadata);
      const excerptRange = mergeRanges(
        triggeringChildren.map((child) => readCharRange(child.metadata)),
      );
      const excerptPages = mergePageSpans(
        triggeringChildren.map((child) => readPageSpan(child.metadata)),
      );

      return new Document({
        pageContent,
        metadata: {
          documentId: row.document_id,
          title: (row.metadata as any)?.title ?? '',
          n1_header: (row.metadata as any)?.n1_header ?? '',
          n2_header: (row.metadata as any)?.n2_header ?? '',
          sectionHeader: row.section_header,
          parentId: row.id,
          role: roleById.get(row.id) ?? 'PRINCIPAL',
          ...(parentRange
            ? { charStart: parentRange.start, charEnd: parentRange.end }
            : {}),
          ...(parentPages
            ? { pageStart: parentPages.page_start, pageEnd: parentPages.page_end }
            : {}),
          ...(excerptRange
            ? {
                excerptCharStart: excerptRange.start,
                excerptCharEnd: excerptRange.end,
              }
            : {}),
          ...(excerptPages
            ? {
                excerptPageStart: excerptPages.page_start,
                excerptPageEnd: excerptPages.page_end,
              }
            : {}),
        },
      });
    });

    // [TRACE 6] Ordem final dos ParentChunks enviados ao LLM
    if (DEBUG_RAG) {
      trace('\n[TRACE 6] Ordem final dos ParentChunks enviados ao LLM:');
      parents.forEach((doc, i) =>
        trace(
          `  [Fonte ${i + 1}${doc.metadata.role ? ` — ${doc.metadata.role}` : ''}] parentId=${doc.metadata.parentId} | section="${doc.metadata.sectionHeader}" | chars=${doc.pageContent.length}`,
        ),
      );
    }

    // Fontes persistidas = documentos cujo conteudo realmente entrou no
    // prompt. Antes vinham dos child hits, incluindo documentos cujos
    // parents foram filtrados ou cortados pelos tetos — citacao sem uso.
    const sourceDocIds = Array.from(
      new Set(
        parents
          .map((doc) => doc.metadata.documentId as string | undefined)
          .filter((id): id is string => Boolean(id)),
      ),
    );

    return { parents, sourceDocIds };
  }

  // Dados dos documentos-fonte necessarios para montar as fontes navegaveis.
  // NUNCA seleciona file_data: e o PDF inteiro, servido apenas pela rota de
  // download sob demanda.
  private async loadSourceDocuments(
    documentIds: string[],
  ): Promise<Map<string, SourceDocumentInfo>> {
    if (documentIds.length === 0) return new Map();
    const rows = await this.prisma.normativeDocument.findMany({
      where: { id: { in: documentIds } },
      select: {
        id: true,
        title: true,
        document_type: true,
        total_pages: true,
        file_name: true,
        file_mime_type: true,
        file_size: true,
      },
    });
    return new Map(rows.map((row) => [row.id, row]));
  }

  async query(
    userQuery: string,
    conversationId: string,
  ): Promise<{
    id: string;
    created_at: Date;
    response: string;
    sources: ResponseSource[];
  }> {
    const { parents, sourceDocIds } =
      await this.retrieveParentContexts(userQuery);

    const prompt = buildRagPrompt(parents, userQuery);

    let aiResponse = '';
    let llmFailed = false;
    let truncated = false;
    try {
      const response = await this.llm.invoke(prompt);

      if (typeof response.content === 'string') {
        aiResponse = response.content;
      } else if (
        Array.isArray(response.content) &&
        response.content.length > 0
      ) {
        const textPart = response.content.find((p: any) => p.type === 'text');
        aiResponse =
          textPart && 'text' in textPart ? (textPart as any).text : '';
      }

      const finishReason = resolveFinishReason(response);
      if (finishReason === 'MAX_TOKENS') {
        // Corte por limite de tokens: a resposta pode ter parado no meio de uma
        // enumeracao. Sinalizamos ao usuario em vez de entregar um texto
        // truncado como se estivesse completo (perda de fidelidade silenciosa).
        truncated = true;
        this.logger.error(
          '[LLM] Resposta truncada por limite de tokens (MAX_TOKENS) — saida possivelmente incompleta.',
        );
      } else if (finishReason && finishReason !== 'STOP') {
        this.logger.warn(`[LLM] finishReason inesperado: ${finishReason}`);
      }
    } catch (err: any) {
      llmFailed = true;
      this.logger.error(
        `[LLM] Falha em llm.invoke — status=${err?.status ?? err?.code ?? 'n/a'} | message=${err?.message ?? String(err)}`,
      );
    }

    // Falha tecnica NAO pode ser confundida com ausencia de informacao nos
    // documentos: a mensagem de recusa e um sinal de conteudo para o usuario,
    // enquanto a falha de LLM e um problema transitorio de infraestrutura.
    if (llmFailed) {
      aiResponse =
        'Nao foi possivel gerar a resposta neste momento devido a uma falha tecnica na comunicacao com o modelo. Tente novamente em alguns instantes.';
    } else if (!aiResponse.trim()) {
      aiResponse =
        'As informacoes disponiveis nos documentos indexados nao sao suficientes para responder a esta pergunta com precisao.';
    } else if (truncated) {
      // Resposta valida porem cortada por limite de tamanho: acrescenta um
      // aviso discreto para nao passar por completa.
      aiResponse +=
        '\n\n(Observacao do sistema: esta resposta pode ter sido interrompida por limite de tamanho e talvez nao cubra todos os itens. Refaca a pergunta de forma mais especifica para obter o restante.)';
    }

    // Fontes navegaveis: um registro por DOCUMENTO (contrato antigo `{ id,
    // title }` preservado) com os TRECHOS que fundamentaram a resposta e, em
    // cada trecho, a sua localizacao — quando os dados a sustentam.
    const sources = buildResponseSources(
      parents.map((doc) => ({
        pageContent: doc.pageContent,
        metadata: doc.metadata as Record<string, unknown>,
      })),
      await this.loadSourceDocuments(sourceDocIds),
    );

    const saved = await this.prisma.interactionHistory.create({
      data: {
        conversation_id: conversationId,
        user_query: userQuery,
        ai_response: aiResponse,
        responseSources: {
          create: sources.map((source) => ({
            normative: { connect: { id: source.id } },
            // A rastreabilidade e persistida junto: reabrir a conversa entrega
            // as mesmas fontes, trechos e localizacoes da resposta original,
            // sem depender de recuperar nada de novo.
            excerpts: {
              create: source.excerpts.map((excerpt, rank) => ({
                parent_chunk_id: excerpt.parent_chunk_id,
                section_header: excerpt.section_header,
                n1_header: excerpt.n1_header,
                n2_header: excerpt.n2_header,
                citation: excerpt.citation,
                excerpt: excerpt.excerpt,
                role: excerpt.role,
                rank,
                page_start: excerpt.location?.page_start ?? null,
                page_end: excerpt.location?.page_end ?? null,
                char_start: excerpt.location?.char_start ?? null,
                char_end: excerpt.location?.char_end ?? null,
                location_precision: excerpt.location?.precision ?? null,
              })),
            },
          })),
        },
      },
    });

    return {
      id: saved.id,
      created_at: saved.created_at,
      response: aiResponse,
      sources,
    };
  }
}
