import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  splitLegalDocument,
  parseItemNumber,
  splitIntoChildChunks,
  CHILD_CHUNK_SIZE,
} from './legal-document-splitter';
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
const PDF_LIGATURES: Array<[RegExp, string]> = [
  [/ﬀ/g, 'ff'],
  [/ﬁ/g, 'fi'],
  [/ﬂ/g, 'fl'],
  [/ﬃ/g, 'ffi'],
  [/ﬄ/g, 'ffl'],
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

// De-hifenizacao ATESTADA pelo proprio documento: une "fiscali-\nzacao" ->
// "fiscalizacao" SOMENTE se a palavra unida ocorre integra em algum outro
// ponto do texto. Sem atestado, o trecho fica exatamente como estava — nada
// e inventado. Compostos legitimos quebrados no proprio hifen ("decreto-\nlei")
// nao sao unidos, pois "decretolei" nao ocorre no documento.
export function dehyphenateAttested(text: string): string {
  const words = new Set<string>();
  for (const token of text.split(/[^\p{L}]+/u)) {
    if (token.length >= 4) words.add(token.toLowerCase());
  }
  return text.replace(
    /(\p{L}{2,})-\n(\p{Ll}{2,})/gu,
    (match, a: string, b: string) =>
      words.has(`${a}${b}`.toLowerCase()) ? `${a}${b}` : match,
  );
}

function cleanExtractedText(raw: string): string {
  const preprocessed = dehyphenateAttested(stripInvisibleArtifacts(raw));
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

// ---------------------------------------------------------------------------
// buildSourceLabel
//
// Monta o cabecalho estrutural de cada fonte no prompt a partir dos metadados
// que ja chegam no Document (title, n1_header, n2_header, sectionHeader).
// Ex: [Fonte 1] Documento: "Edital X" | ANEXO VIII-B | Item 10.2.
//
// "Fonte N" e apenas o identificador posicional do bloco dentro do prompt;
// o modelo e instruido a citar SEMPRE pela referencia estrutural (documento,
// anexo, item), que e estavel e rastreavel fora desta requisicao.
// ---------------------------------------------------------------------------
export function buildSourceLabel(doc: Document, index: number): string {
  const md = doc.metadata as Record<string, unknown>;
  const title =
    typeof md.title === 'string' && md.title
      ? md.title
      : 'Documento sem titulo';
  const n1 = typeof md.n1_header === 'string' ? md.n1_header : '';
  const n2 = typeof md.n2_header === 'string' ? md.n2_header : '';
  const section = typeof md.sectionHeader === 'string' ? md.sectionHeader : '';

  const parts: string[] = [`Documento: "${title}"`];
  if (n1) parts.push(n1);

  // n2 e o item ("10.2.") ou artigo ("Art. 39"); sem n2, usa sectionHeader
  // quando ele nao repete o n1.
  const item = n2 || (section !== n1 ? section : '');
  if (item) parts.push(/^art/i.test(item) ? item : `Item ${item}`);

  // A prioridade definida no retrieval (metadado role PRINCIPAL/COMPLEMENTAR)
  // NAO e renderizada no rotulo: a ordem dos trechos ja carrega o sinal (o
  // primeiro e o mais pertinente) e vocabulario interno do pipeline nao deve
  // induzir a resposta a falar em "fontes principais/complementares".
  return `[Trecho ${index + 1}] ${parts.join(' | ')}`;
}

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

  return `Voce e um assistente especializado em normas e documentos administrativos brasileiros. Quem pergunta e um servidor publico que precisa de uma resposta clara, correta e util para aplicar a norma no dia a dia.

Abaixo estao trechos de documentos normativos, cada um com uma anotacao interna de origem (documento, anexo, item). Os trechos estao ordenados por pertinencia — o primeiro e o mais diretamente relacionado a pergunta — e podem vir separados em dois niveis: DISPOSITIVOS CENTRAIS e MATERIAL DE APOIO (correlato), conforme a ESTRUTURA E FORMATO. Trechos consecutivos de um mesmo documento e anexo costumam ser partes (itens, subitens, alineas ou incisos) de um mesmo dispositivo; nesse caso formam uma sequencia continua, na ordem original da norma, e devem ser lidos em conjunto, pois juntos compoem a resposta completa. As anotacoes, os rotulos [Trecho N] e o mecanismo de selecao de trechos sao detalhes internos do sistema e nao fazem parte da resposta.

COMO RESPONDER:

1. RESPONDA A PERGUNTA, NAO DESCREVA O SISTEMA
   Comece respondendo diretamente o que foi perguntado, em linguagem natural, como um especialista que conhece a norma.
   Nunca abra a resposta comentando os documentos ou trechos ("Foram recuperados...", "Os dispositivos encontrados...", "O contexto contem...").
   Nunca use na resposta termos internos como "Fonte 1", "Trecho 2", "documento principal", "documento complementar", "contexto recuperado".

2. ESCOLHA O MODO PELO TIPO DE PERGUNTA
   a) Pergunta explicativa ("quais sao...", "como funciona...", "o que deve...", "quando..."):
      - responda de forma direta e organizada, sintetizando com fidelidade o que a norma determina;
      - quando a pergunta pedir um conjunto de elementos (rotinas, obrigacoes, requisitos, hipoteses, etapas, prazos ou documentos), primeiro selecione os dispositivos que compoem o processo perguntado (ver "PENSE EM PROCESSO") e entao enumere integralmente os itens de CADA dispositivo selecionado, sem reduzir a quantidade dentro dele — a completude vale dentro do que foi selecionado, nao sobre todo o contexto;
      - use topicos quando facilitarem a leitura;
      - preserve com exatidao numeros, prazos, valores, percentuais e obrigacoes; a numeracao e a origem do dispositivo vao entre parenteses no titulo do topico (ver ESTRUTURA E FORMATO);
      - transcreva literalmente apenas passagens curtas em que a redacao exata importa;
      - nao copie secoes inteiras da norma quando uma sintese fiel responde a pergunta.
   b) Pedido de transcricao ("transcreva...", "copie...", "reproduza...", "mostre na integra...", "texto exato..."):
      - reproduza o texto literalmente, completo e na ordem original;
      - mantenha a numeracao e a estrutura originais (itens, subitens, alineas, incisos);
      - nao resuma, nao reorganize, nao omita e nao acrescente nada.

3. PENSE EM PROCESSO, NAO EM DISPOSITIVOS (selecao — perguntas explicativas)
   A pergunta e sobre uma tarefa administrativa que alguem precisa executar, nao sobre o que existe no documento. Os trechos recuperados sao um universo de CANDIDATOS, reunidos por proximidade de assunto — nao um roteiro a reproduzir. Recuperar um trecho significa apenas que ele esta disponivel; cabe a voce decidir se ele e necessario para responder.
   Aplique este raciocinio quando a pergunta for sobre executar ou compreender uma atividade ou procedimento; perguntas pontuais (um prazo, um valor, uma definicao) respondem direto.
   Antes de escrever, reconstrua mentalmente o processo perguntado: qual atividade o usuario quer executar, em que escopo e cadencia, e quais sao as suas etapas naturais (o que precisa ser providenciado, executado e verificado, e o que antecede a conclusao). Use como etapas APENAS o que os trechos descrevem — nunca invente fases ou passos. O processo e uma LENTE para selecionar e ordenar; nunca uma fonte de fatos.
   Para cada dispositivo recuperado, decida nesta ordem:
   a) Responde diretamente ao que foi perguntado? -> inclua.
   b) Senao: e uma etapa indispensavel para executar exatamente o processo perguntado, ainda que trate de obrigacao de outra parte (contratada, gestor, fiscal tecnico...) ou de um documento/insumo sem o qual a atividade nao ocorre? -> inclua.
   c) Senao — apenas complementa o assunto, detalha outra modalidade da atividade (ex.: por amostragem), trata de outra fase, de excecoes, de diretrizes gerais ou de procedimentos acessorios? -> NAO entra automaticamente. So aparece se a pergunta pedir explicitamente esse aprofundamento, ou se a sua ausencia tornar impossivel compreender ou executar o processo.
   Omita em silencio o que ficar de fora: nao os cite, nao avise que existem, nao justifique exclusoes.

4. ESTRUTURA E FORMATO (perguntas explicativas)
   Depois de selecionar os dispositivos, NAO reorganize o conteudo livremente: a resposta segue obrigatoriamente esta estrutura.
   - So geram bloco os DISPOSITIVOS CENTRAIS que voce selecionar (regra PENSE EM PROCESSO). O que estiver sob "MATERIAL DE APOIO", e o que for correlato, de outra modalidade, diretriz geral ou excecao, NUNCA gera bloco proprio — serve so para referencia cruzada ou quando sua ausencia tornar a resposta impossivel. Estar no contexto nao obriga a virar bloco.
   - Introducao: um unico paragrafo curto resumindo o contexto. Ex: "As rotinas da fiscalizacao mensal previstas no Anexo VIII-B da IN 05/2017 compreendem as seguintes obrigacoes e verificacoes."
   - Depois, um topico para CADA dispositivo selecionado — exatamente um dispositivo por topico, neste formato:
       ## N. <Nome da atividade / finalidade do dispositivo> (Item X)
       <uma frase curta e natural introduzindo o topico; aqui SIM cabem tempo e condicao, ex.: "Ao final de cada periodo mensal, o fiscal administrativo devera:">
       • <acao 1>;
       • <acao 2>;
       • <acao 3>.
   - O TITULO nomeia a FINALIDADE do proprio dispositivo (ex.: "Verificacao de Dispendios e Emissao de Relatorio", "Documentacao Mensal da Contratada", "Diretrizes da Fiscalizacao Mensal"), com a referencia entre parenteses. Inclua ao menos o item; quando a resposta usar mais de um documento ou anexo, inclua-os: "(Item 2.1, Anexo VIII-B, IN 05/2017)".
   - PROIBIDO transformar dispositivos em fases do processo ou em categorias inventadas por voce. Nunca use como titulo "Antes do pagamento", "Para recebimento provisorio", "Durante a execucao", "Mensalmente", "Obrigacoes fiscais", "Outras verificacoes", "Fiscalizacao administrativa" e afins — sao interpretacoes suas. Tempo e condicao pertencem ao TEXTO do dispositivo (a frase introdutoria), nunca ao titulo. O titulo representa apenas o dispositivo selecionado.
   - UM DISPOSITIVO = UM BLOCO (regra inviolavel). A unidade de organizacao da resposta e o DISPOSITIVO, nunca o tema. Cada dispositivo selecionado gera exatamente um bloco independente, com titulo, frase introdutoria curta e lista de acoes (nunca tudo num unico paragrafo). E PROIBIDO: fundir dois dispositivos num mesmo bloco; incorporar um dispositivo como bullet ou complemento de outro; ocultar ou deduplicar um dispositivo porque trata do mesmo assunto; substituir um dispositivo por um resumo de outro. Se 9, 2.1 e 10.2 foram selecionados, existem obrigatoriamente TRES blocos distintos — a afinidade tematica nunca autoriza fusao.
   - Identidade do bloco: todo o conteudo de um bloco vem EXCLUSIVAMENTE do seu proprio dispositivo; nunca misture obrigacoes de dispositivos diferentes. Errado: descrever as certidoes que a contratada apresenta (Item 2.1) dentro do bloco do Item 10.2. Certo: o Item 2.1 tem o seu proprio bloco (## Documentacao mensal apresentada pela contratada (Item 2.1)).
   - Independencia: quando dois dispositivos tratam do mesmo assunto (ex.: certidoes), eles continuam sendo obrigacoes distintas e mantem blocos separados. So e permitida REFERENCIA CRUZADA, nunca fusao, deduplicacao, condensacao ou absorcao. Ex.: no bloco do Item 10.2 pode-se escrever "a documentacao correspondente e apresentada pela contratada conforme o Item 2.1" — mas o Item 2.1 mantem o seu proprio bloco.
   - Metadados NAO viram um bloco separado: nao escreva linhas "Documento:", "Anexo:", "Item:", "Descricao:" nem "Fonte:". A origem aparece somente no titulo, entre parenteses. Prefira texto natural ("A contratada devera entregar os seguintes documentos:") a rotulos secos.
   - Ordene os blocos pela sequencia LOGICA DO PROCESSO (a ordem em que o agente executa as etapas), e NAO pela ordem numerica dos itens nem pela ordem de recuperacao. Deduza a sequencia dos proprios dispositivos (marcos de tempo/condicao); onde a norma nao indicar ordem, nao invente.
   - Sintetize cada acao de forma curta, sem copiar o texto integral da norma e sem omitir requisitos, prazos ou condicoes (ver COBERTURA). Um rotulo em negrito no inicio do bullet e opcional.
   - Quando a resposta usar um unico dispositivo, gere UM unico bloco no mesmo padrao.

5. COBERTURA COMPLETA DOS DISPOSITIVOS SELECIONADOS
   A completude vale DENTRO de cada dispositivo que voce selecionou — nunca sobre todo o contexto recuperado. Selecionado um dispositivo, apresente-o por inteiro: todos os subitens, alineas, incisos, listas, obrigacoes, condicoes e excecoes que lhe pertencem. Sintetize a redacao de cada item se ajudar, mas nunca trunque, interrompa nem reduza a quantidade de itens de um dispositivo selecionado, nem omita requisitos, prazos ou condicoes; o fim da lista importa tanto quanto o inicio. Nao condense itens distintos em um so nem os substitua por uma descricao generica ("entre outras rotinas", "diversos procedimentos").
   Antes de finalizar, faca quatro conferencias:
   - Precisao: algum dispositivo entrou apenas por tratar do mesmo tema, sem ocupar uma etapa necessaria do processo? Remova-o.
   - Recall: alguma etapa indispensavel do processo aparece no contexto recuperado mas ficou de fora? Inclua-a.
   - Cobertura: cada dispositivo selecionado foi apresentado integralmente, sem subitem pertinente omitido?
   - Contagem: conte APENAS os dispositivos que voce selecionou como centrais — material de apoio, correlatos, outra modalidade, diretrizes gerais e excecoes NAO contam e NAO viram bloco. O numero de blocos deve COINCIDIR com esse total de selecionados. Se um selecionado foi fundido ou absorvido em outro bloco, separe-o num bloco proprio; se um dispositivo NAO selecionado virou bloco, remova-o. Selecionar continua sendo tarefa da regra PENSE EM PROCESSO — estar no contexto nunca obriga a incluir.

6. FIDELIDADE AO TEXTO NORMATIVO
   Use somente o conteudo dos trechos fornecidos; nao use conhecimento externo.
   O processo que voce reconstroi serve para selecionar e ordenar — nao e fonte de fatos. Etapas, sequencia e vinculos entre dispositivos so podem ser afirmados na medida em que os trechos os sustentam; nao invente ligacoes, causas ou passos que a norma nao declara.
   Nao invente dispositivos, numeros ou continuacoes de texto. Se um trecho contiver o marcador [...], ha texto omitido nesse ponto — nunca o complete.
   Se um dispositivo mencionado nos trechos remeter a um subitem, alinea ou inciso cujo texto NAO esta presente, registre a ausencia em uma nota curta entre parenteses (ex: "(a alinea 'b.1' e referida, mas seu texto nao consta dos trechos disponiveis)") — nunca invente o conteudo ausente nem descarte a referencia em silencio.
   Nao faca interpretacao juridica, recomendacao ou opiniao alem do que a norma diz.
   Se os trechos nao contiverem a informacao perguntada, responda EXATAMENTE:
   "As informacoes disponiveis nao sao suficientes."

7. CITACAO DA FONTE
   A origem de cada dispositivo aparece entre parenteses no TITULO do seu topico (ex.: "(Item 10.2)" ou "(Item 2.1, Anexo VIII-B, IN 05/2017)"), a partir da anotacao de origem do trecho, sem inventar dados que nao estejam la. Nao crie bloco de metadados nem "Fonte:" ao final, e nao interrompa o texto com citacoes inline. Nunca use rotulos internos do sistema (nunca escreva "Trecho N", "Fonte N", "PRINCIPAL" ou "COMPLEMENTAR"). Cite apenas dispositivos efetivamente usados e reproduza exatamente a numeracao que aparece nos trechos.

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
      model: 'gemini-2.5-flash',
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
  // -------------------------------------------------------------------------
  async indexDocument(
    rawContent: string,
    documentId: string,
    title: string,
  ): Promise<{
    success: boolean;
    documentId: string;
    sections: number;
    childChunks: number;
  }> {
    const cleanedText = cleanExtractedText(rawContent);
    const chunks = splitLegalDocument(cleanedText);

    let totalChildren = 0;

    type GroupEntry = {
      n1_header: string;
      n2_header: string;
      sectionHeader: string;
      contentParts: string[];
    };

    const groupMap = new Map<string, GroupEntry>();

    for (const chunk of chunks) {
      const { n1_header, n2_header } = chunk.metadata;
      const key = `${n1_header}|||${n2_header}`;

      if (!groupMap.has(key)) {
        groupMap.set(key, {
          n1_header,
          n2_header,
          sectionHeader: (n2_header || n1_header || 'Secao').slice(0, 255),
          contentParts: [],
        });
      }

      groupMap.get(key)!.contentParts.push(chunk.content);
    }

    // Cabecalho descritivo de cada anexo/secao = o grupo de "preambulo" (sem
    // item, n2 vazio), cujo conteudo costuma trazer o tema da secao. Serve
    // APENAS para contextualizar o embedding dos children (buildChunkEmbedText);
    // nao altera parents, metadados nem filtros. Se um anexo nao tiver preambulo
    // (titulo inline descartado no split), o lookup cai no rotulo n1_header.
    const sectionHeadingByN1 = new Map<string, string>();
    for (const entry of groupMap.values()) {
      if (
        entry.n2_header === '' &&
        entry.n1_header &&
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
          },
        },
      });

      const childContents =
        fullContent.length > CHILD_CHUNK_SIZE
          ? splitIntoChildChunks(fullContent)
          : [fullContent];

      for (const childContent of childContents) {
        allChildDocs.push(
          new Document({
            pageContent: childContent,
            metadata: {
              documentId,
              title,
              parentId: savedParent.id,
              n1_header: entry.n1_header,
              n2_header: entry.n2_header,
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
      `Indexado: "${title}" — ${groupMap.size} parents consolidados, ${totalChildren} child chunks vetorizados`,
    );

    return {
      success: true,
      documentId,
      sections: groupMap.size,
      childChunks: totalChildren,
    };
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
    // Expansao DESCENDENTE — filhos diretos do item recuperado
    //
    // A expansao de irmaos acima so alcanca itens do MESMO nivel (10.2 -> 10.1,
    // 10.3) — ela rejeita candidatos de nivel diferente. Mas um item nao-folha
    // como "10.2" costuma conter apenas o caput; os subitens que de fato
    // compoem a resposta ("10.2.1", "10.2.2", ...) vivem em parents-filhos
    // separados, de nivel mais profundo. Sem esta passagem o retriever traz o
    // TITULO do dispositivo mas nao o seu conteudo enumerado, e a resposta sai
    // incompleta mesmo com o contexto "certo" recuperado. Aqui buscamos os
    // filhos DIRETOS de cada item efetivamente recuperado.
    // -----------------------------------------------------------------------
    const descendantParents: ParentChunkRow[] = [];
    const alreadySelectedIds = new Set<string>([
      ...orderedParentRows.map((row) => row.id),
      ...siblingParents.map((row) => row.id),
    ]);

    for (const row of orderedParentRows) {
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
        descendantParents.push(child);
        alreadySelectedIds.add(child.id);
        scoreByParentId.set(child.id, inheritedScore);
      }
    }

    if (siblingParents.length > 0 || descendantParents.length > 0) {
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
    const retrievedScopeHits = new Map<string, number>();
    for (const id of orderedParentIds) {
      const row = parentMap.get(id);
      if (!row || row.content.length < MIN_PARENT_CONTENT_LENGTH) continue;
      const scopeKey = `${row.document_id}|||${getN1Header(row)}`;
      retrievedScopeHits.set(
        scopeKey,
        (retrievedScopeHits.get(scopeKey) ?? 0) + 1,
      );
    }
    const beforePrune = orderedParentRows.length;
    orderedParentRows = pruneForeignAnexoContamination(
      orderedParentRows,
      retrievedScopeHits,
    );
    if (DEBUG_RAG && orderedParentRows.length !== beforePrune) {
      trace(
        `[COERENCIA] Removidos ${beforePrune - orderedParentRows.length} parent(s) de anexo estranho ao processo dominante`,
      );
    }

    const clusters = buildClusters(orderedParentRows, scoreByParentId);
    const boostedClusters = applyHierarchicalBoost(clusters);
    const boostedParents = flattenClusters(boostedClusters);
    const parentsToUse = boostedParents.length
      ? boostedParents
      : orderedParentRows;

    // -----------------------------------------------------------------------
    // Selecao por PROVENIENCIA (substitui a marcacao PRINCIPAL/COMPLEMENTAR por
    // score). Cada dispositivo carrega COMO entrou no conjunto candidato:
    //   HIT        = acerto direto da busca vetorial;
    //   DESCENDANT = filho de um hit — completa o mesmo dispositivo -> central;
    //   SIBLING    = irmao trazido pela expansao (vizinho numerico) -> apoio.
    // Politica (rankByProvenance): HIT ou DESCENDANT => PRINCIPAL; so SIBLING =>
    // COMPLEMENTAR. Nada e removido — apenas a prioridade para a geracao muda,
    // com os centrais a frente. Deterministica, auditavel e geral (usa so a
    // arvore do documento e a origem no pipeline, nunca regras por norma).
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

    const ranked = rankByProvenance(parentsToUse, provenanceById);
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

    const triggeringChildByParentId = new Map<string, Document>();
    for (const [child] of childResults) {
      const pid = child.metadata.parentId as string | undefined;
      if (pid && !triggeringChildByParentId.has(pid))
        triggeringChildByParentId.set(pid, child);
    }

    const parents = orderedForPrompt.map((row) => {
      const triggeringChild = triggeringChildByParentId.get(row.id);
      let pageContent = row.content;

      // Janela deslizante apenas para parents grandes demais para o prompt.
      // Parents ate SLIDING_WINDOW_MIN_PARENT_LENGTH entram INTEGROS — o
      // parent que disparou o hit e o trecho mais relevante e nao deve ser
      // truncado. Nos grandes, a janela e centrada no child que casou, com
      // anchor progressivo tolerante a whitespace e bordas ajustadas para
      // fronteiras de sentenca.
      if (
        triggeringChild &&
        row.content.length > SLIDING_WINDOW_MIN_PARENT_LENGTH
      ) {
        const startIndex = findAnchorIndex(
          row.content,
          triggeringChild.pageContent,
        );
        if (startIndex !== -1) {
          let windowStart = Math.max(0, startIndex - SLIDING_WINDOW_BEFORE);
          let windowEnd = Math.min(
            row.content.length,
            startIndex +
              triggeringChild.pageContent.length +
              SLIDING_WINDOW_AFTER,
          );
          windowStart = snapWindowStart(row.content, windowStart);
          windowEnd = snapWindowEnd(row.content, windowEnd);
          const slice = row.content.substring(windowStart, windowEnd);
          const prefix = windowStart > 0 ? '[...] ' : '';
          const suffix = windowEnd < row.content.length ? ' [...]' : '';
          pageContent = `${prefix}${slice}${suffix}`;
        }
      }

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

  async query(
    userQuery: string,
    conversationId: string,
  ): Promise<{
    id: string;
    created_at: Date;
    response: string;
    sources: { id: string; title: string }[];
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

    const sourcesMap = new Map<string, { id: string; title: string }>();
    for (const parent of parents) {
      const id = parent.metadata.documentId as string;
      const title = parent.metadata.title as string;
      if (id && !sourcesMap.has(id)) sourcesMap.set(id, { id, title });
    }
    const sources = Array.from(sourcesMap.values());

    const saved = await this.prisma.interactionHistory.create({
      data: {
        conversation_id: conversationId,
        user_query: userQuery,
        ai_response: aiResponse,
        responseSources: {
          create: sourceDocIds.map((id) => ({
            normative: { connect: { id } },
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
