import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { splitLegalDocument, parseItemNumber } from './legal-document-splitter';
import {
  buildClusters,
  applyHierarchicalBoost,
  flattenClusters,
  getN1Header,
  getN2Header,
  sortParentsByStructuralOrder,
  deriveSiblingPrefix,
  type ParentChunkRow,
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
const EMBEDDING_BATCH_SIZE  = 15;
const EMBEDDING_BATCH_DELAY = 10_000; // ms entre lotes
const EMBEDDING_RETRY_DELAY = 65_000; // ms após rate-limit 429
const EMBEDDING_MAX_RETRIES = 5;

// Filtro de qualidade dos ParentChunks
const MIN_PARENT_CONTENT_LENGTH = 80;

// Janela deslizante
const SLIDING_WINDOW_BEFORE        = 400;
const SLIDING_WINDOW_AFTER         = 800;
// Tamanhos do anchor tentados em ordem decrescente (fallback progressivo)
const SLIDING_WINDOW_ANCHOR_SIZES  = [50, 40, 30, 20] as const;

// ---------------------------------------------------------------------------
// Helpers de throttling
// ---------------------------------------------------------------------------
const delay = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

function chunkArray<T>(arr: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < arr.length; i += size) batches.push(arr.slice(i, i + size));
  return batches;
}

// ---------------------------------------------------------------------------
// Embeddings via Gemini nativo (com throttling sequencial)
// ---------------------------------------------------------------------------
class NativeGeminiEmbeddings extends Embeddings {
  private model: ReturnType<InstanceType<typeof GoogleGenerativeAI>['getGenerativeModel']>;

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
    /^ANEXO\s+[A-Z0-9]/i.test(line)          ||
    /^CAP[ÍI]TULO\s+[IVXLCDM]/i.test(line)   ||
    /^Se[çc][ãa]o\s+[IVXLCDM]/i.test(line)   ||
    /^Subse[çc][ãa]o\s+[IVXLCDM]/i.test(line) ||
    /^T[ÍI]TULO\s+[IVXLCDM]/i.test(line)     ||
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
  return RE_PDF_NOISE_ALLCAPS.some(re => re.test(line.trim()));
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
// Limpeza pre-chunking
// ---------------------------------------------------------------------------
function cleanExtractedText(raw: string): string {
  return raw
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
    response?.finishReason                          ??
    response?.response_metadata?.finishReason       ??
    response?.response_metadata?.finish_reason      ??
    response?.generationInfo?.finishReason          ??
    response?.generationInfo?.finish_reason         ??
    'unknown'
  );
}

export function buildRagPrompt(contexts: Document[], userQuery: string): string {
  const contextBlock = contexts
    .map((doc, i) => {
      const section = doc.metadata.sectionHeader as string;
      const n2      = doc.metadata.n2_header     as string;
      const label   = n2 && n2 !== section ? `${section} — ${n2}` : section;
      return `[Documento Ref ${i + 1}] (${label})\n${doc.pageContent}`;
    })
    .join('\n\n---\n\n');

  return `Voce e um assistente especializado em documentos normativos e administrativos.

Os documentos de referencia abaixo estao ordenados por relevancia. O Documento Ref 1 e sempre o mais relevante para a pergunta.

REGRAS OBRIGATORIAS:

1. FONTE PRINCIPAL
   Use o Documento Ref 1 como fonte primaria.
   Somente consulte os demais documentos se o Ref 1 nao responder completamente a pergunta.
   Se o Ref 1 responder integralmente, ignore os demais documentos por completo.

2. FIDELIDADE AO TEXTO
   Preserve a redacao original do documento.
   Nao parafraseie, nao reinterprete e nao reescreva procedimentos administrativos ou juridicos.
   A fidelidade ao texto tem prioridade sobre reformulacoes stilisticas.

3. PRESERVACAO DE LISTAS
   Quando o documento apresentar listas numeradas, alineas ou itens (a, b, c... / I, II, III...):
   - reproduza todos os itens sem excecao;
   - mantenha exatamente a ordem original;
   - nao reorganize, nao agrupe e nao omita nenhum item;
   - nao crie novos itens.
   Se o documento tiver quatro alineas, a resposta deve conter exatamente quatro alineas.

4. NAO TRUNCAR CONTEUDO
   Nunca interrompa frases, dispositivos legais ou referencias normativas.
   Sempre conclua a frase utilizando todo o conteudo disponivel no contexto.
   Se o trecho estiver incompleto por limitacao do contexto, nao invente a continuacao.

5. FORMATO DA RESPOSTA
   Utilize preferencialmente:
   - Uma frase de introducao curta.
   - Lista com marcadores (•) reproduzindo os itens do documento na ordem original.
   Evite blocos longos de texto corrido.

6. CITACAO OBRIGATORIA
   Ao final da resposta, informe a referencia de forma especifica:

   Fonte:
   - Documento Ref X — Item X.X (titulo do item, se houver)

   Se mais de um documento foi utilizado:
   Fonte:
   - Documento Ref 1 — Item X.X (titulo)
   - Documento Ref 3 — Item Y.Y (titulo)

   Somente cite documentos cujas informacoes foram efetivamente utilizadas na resposta.

7. PROIBICOES
   Nao inclua:
   - interpretacoes juridicas;
   - comentarios ou observacoes extras;
   - exemplos nao presentes no documento;
   - recomendacoes;
   - contexto historico;
   - explicacoes adicionais nao solicitadas.
   Responda apenas ao que foi perguntado.

8. AUSENCIA DE INFORMACAO
   Se a informacao nao constar em nenhum documento, responda EXATAMENTE:
   "As informacoes disponiveis nao sao suficientes."

9. SINTESE DE CONTEXTO RELACIONADO
   Se os documentos recuperados pertencerem ao mesmo contexto estrutural ou n1_header,
   sintetize as informacoes complementares.
   preserve a origem de cada informacao indicando o item correspondente.
   Nao repita conteudos identicos.
   Nao ignore documentos relacionados recuperados.

--- INICIO DOS DOCUMENTOS DE REFERENCIA ---
${contextBlock}
--- FIM DOS DOCUMENTOS DE REFERENCIA ---

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
      temperature: 0.4,
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      ],
    });

    this.vectorStore = await PGVectorStore.initialize(this.embeddings, {
      postgresConnectionOptions: {
        type: 'postgres',
        connectionString: process.env.DATABASE_URL,
      } as PoolConfig,
      tableName: 'documentos_vetorizados',
      columns: {
        idColumnName:       'id',
        vectorColumnName:   'embedding',
        contentColumnName:  'text',
        metadataColumnName: 'metadata',
      },
    });

    this.logger.log('RAG Service inicializado (Gemini 2.5 + pgvector + PDR persistido)');
  }

  // -------------------------------------------------------------------------
  // Ingestao: limpeza -> chunking -> persiste parents no PG -> indexa children
  // -------------------------------------------------------------------------
  async indexDocument(
    rawContent: string,
    documentId: string,
    title: string,
  ): Promise<{ success: boolean; documentId: string; sections: number; childChunks: number }> {
    const cleanedText = cleanExtractedText(rawContent);
    const chunks = splitLegalDocument(cleanedText);

    const BATCH_SIZE  = 15;
    const BATCH_DELAY = 10000;
    const RETRY_DELAY = 65000;

    let totalChildren = 0;

    type GroupEntry = {
      n1_header: string;
      n2_header: string;
      sectionHeader: string;
      contentParts: string[];
      childContents: string[];
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
          childContents: [],
        });
      }

      const entry = groupMap.get(key)!;
      entry.contentParts.push(chunk.content);
      entry.childContents.push(chunk.content);
    }

    const allChildDocs: Document[] = [];

    for (const entry of groupMap.values()) {
      const fullContent = entry.contentParts.join('\n');

      const savedParent = await this.prisma.parentChunk.create({
        data: {
          document_id:    documentId,
          section_header: entry.sectionHeader,
          content:        fullContent,
          metadata: {
            documentId,
            title,
            n1_header: entry.n1_header,
            n2_header: entry.n2_header,
          },
        },
      });

      for (const childContent of entry.childContents) {
        allChildDocs.push(
          new Document({
            pageContent: childContent,
            metadata: {
              documentId,
              title,
              parentId:  savedParent.id,
              n1_header: entry.n1_header,
              n2_header: entry.n2_header,
            },
          }),
        );
      }
    }

    const batches = chunkArray(allChildDocs, BATCH_SIZE);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      this.logger.log(`[RAG] Vetorizando lote ${i + 1}/${batches.length} (${batch.length} chunks)...`);

      let attempt = 0;
      while (attempt < 5) {
        try {
          await this.vectorStore.addDocuments(batch);
          totalChildren += batch.length;
          break;
        } catch (err: any) {
          const is429 =
            err?.status === 429 ||
            String(err?.message).includes('429') ||
            String(err?.message).toLowerCase().includes('quota');

          if (is429 && attempt < 4) {
            this.logger.warn(`[RAG] Rate limit (429) no lote ${i + 1}. Aguardando ${RETRY_DELAY / 1000}s...`);
            await delay(RETRY_DELAY);
            attempt++;
          } else {
            throw err;
          }
        }
      }

      if (i < batches.length - 1) await delay(BATCH_DELAY);
    }

    this.logger.log(
      `Indexado: "${title}" — ${groupMap.size} parents consolidados, ${totalChildren} child chunks vetorizados`,
    );

    return { success: true, documentId, sections: groupMap.size, childChunks: totalChildren };
  }

  private async retrieveParentContexts(userQuery: string, k = 5) {
    const queryVec = await this.embeddings.embedQuery(userQuery);

    // [TRACE 1] Query e embedding
    console.log('\n[TRACE 1] userQuery:', userQuery);
    console.log(`[TRACE 1] embedding: dim=${queryVec.length} | primeiros valores=[${queryVec.slice(0, 5).map(v => v.toFixed(6)).join(', ')}]`);

    let filter: any = undefined;
    const anexoMatch = userQuery.match(/(?:Anexo)\s+([IVXLCDM]+(?:-[A-Z])?)/i);
    if (anexoMatch) {
      filter = { n1_header: anexoMatch[0].toUpperCase() };
    }

    // [TRACE 2] Filtro final enviado para a busca vetorial
    console.log('[TRACE 2] filter enviado para similaritySearchVectorWithScore:', JSON.stringify(filter ?? null));

    const childResults = await this.vectorStore.similaritySearchVectorWithScore(queryVec, k, filter);

    // [TRACE 3] Child chunks retornados pela busca vetorial
    console.log(`\n[TRACE 3] ${childResults.length} child chunk(s) retornados:`);
    childResults.forEach(([child, score], i) => {
      console.log(
        `  [${i + 1}] score=${score.toFixed(6)}` +
        ` | n1="${child.metadata.n1_header ?? ''}"` +
        ` | n2="${child.metadata.n2_header ?? ''}"` +
        ` | parentId=${child.metadata.parentId}` +
        ` | preview="${child.pageContent.slice(0, 120).replace(/\n/g, ' ')}"`
      );
    });

    const parentIds       = new Set<string>();
    const orderedParentIds: string[] = [];
    const sourceDocIds    = new Set<string>();
    const scoreByParentId = new Map<string, number>();
    for (const [child, score] of childResults) {
      const parentId = child.metadata.parentId as string | undefined;
      const docId    = child.metadata.documentId as string | undefined;
      if (parentId && !parentIds.has(parentId)) {
        parentIds.add(parentId);
        orderedParentIds.push(parentId);
      }
      if (docId) sourceDocIds.add(docId);
      if (parentId) scoreByParentId.set(parentId, score);
    }

    // [TRACE 4] Ordem de insercao dos parentIds no Set
    console.log('\n[TRACE 4] Ordem de insercao dos parentIds no Set:');
    orderedParentIds.forEach((pid, i) => console.log(`  ${i + 1} -> ${pid}`));

    const parentRows = await this.prisma.parentChunk.findMany({
      where: { id: { in: orderedParentIds } },
    });

    const parentMap = new Map(parentRows.map(row => [row.id, row]));
    let orderedParentRows = orderedParentIds
      .map(id => parentMap.get(id)!)
      .filter(row => row && row.content.length >= MIN_PARENT_CONTENT_LENGTH);

    const siblingExpansionGroups = new Map<string, {
      documentId: string;
      n1Header: string;
      parentPrefix: string;
      parentNumbers: number[];
      level: number;
      bestScore: number;
      retrievedIds: Set<string>;
    }>();

    for (const row of orderedParentRows) {
      const n2Header = getN2Header(row);
      const prefixInfo = deriveSiblingPrefix(n2Header);
      if (!prefixInfo) continue;

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
        });
      } else {
        existingGroup.retrievedIds.add(row.id);
        existingGroup.bestScore = Math.min(existingGroup.bestScore, score);
      }
    }

    if (siblingExpansionGroups.size > 0) {
      const siblingParents: ParentChunkRow[] = [];

      for (const group of siblingExpansionGroups.values()) {
        const candidates = await this.prisma.parentChunk.findMany({
          where: {
            document_id: group.documentId,
            metadata: { path: ['n1_header'], equals: group.n1Header },
            section_header: { startsWith: group.parentPrefix },
          },
        });

        for (const candidate of candidates) {
          if (group.retrievedIds.has(candidate.id)) continue;
          if (candidate.content.length < MIN_PARENT_CONTENT_LENGTH) continue;

          const candidateHeader = getN2Header(candidate);
          const parsedCandidate = parseItemNumber(candidateHeader);
          if (!parsedCandidate || parsedCandidate.level !== group.level) continue;
          if (!group.parentNumbers.every((value, idx) => parsedCandidate.numbers[idx] === value)) continue;

          siblingParents.push(candidate);
          scoreByParentId.set(candidate.id, group.bestScore);
        }
      }

      if (siblingParents.length > 0) {
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

        orderedParentRows = groupOrder.flatMap((key) =>
          sortParentsByStructuralOrder(parentsByGroup.get(key)!),
        );
      }
    }

    const clusters = buildClusters(orderedParentRows, scoreByParentId);
    const boostedClusters = applyHierarchicalBoost(clusters);
    const boostedParents = flattenClusters(boostedClusters);
    const parentsToUse = boostedParents.length ? boostedParents : orderedParentRows;

    // [TRACE 5] Ordem retornada pelo Prisma
    console.log('\n[TRACE 5] Ordem retornada pelo Prisma (parentChunk.findMany):');
    parentRows.forEach((row, i) =>
      console.log(`  [${i + 1}] id=${row.id} | section="${row.section_header}" | chars=${row.content.length}`)
    );
    const prismaPreservedOrder = orderedParentIds.every((pid, i) => parentRows[i]?.id === pid);
    console.log(`[TRACE 5] O Prisma preservou a ordem dos parentIds? ${prismaPreservedOrder ? 'SIM' : 'NAO'}`);
    console.log('  (esperado):', orderedParentIds.join(' -> '));
    console.log('  (recebido):', parentRows.map(r => r.id).join(' -> '));

    const MARGEM_ANTES  = 400;
    const MARGEM_DEPOIS = 800;

    const triggeringChildByParentId = new Map<string, Document>();
    for (const [child] of childResults) {
      const pid = child.metadata.parentId as string | undefined;
      if (pid && !triggeringChildByParentId.has(pid)) triggeringChildByParentId.set(pid, child);
    }

    const parents = parentsToUse.map((row) => {
      const triggeringChild = triggeringChildByParentId.get(row.id);
      let pageContent = row.content;

      if (triggeringChild) {
        const anchor     = triggeringChild.pageContent.slice(0, 50).trim();
        const startIndex = row.content.indexOf(anchor);
        if (startIndex !== -1) {
          const windowStart = Math.max(0, startIndex - MARGEM_ANTES);
          const windowEnd   = Math.min(row.content.length, startIndex + triggeringChild.pageContent.length + MARGEM_DEPOIS);
          const slice  = row.content.substring(windowStart, windowEnd);
          const prefix = windowStart > 0                  ? '[...] ' : '';
          const suffix = windowEnd   < row.content.length ? ' [...]' : '';
          pageContent  = `${prefix}${slice}${suffix}`;
        }
      }

      return new Document({
        pageContent,
        metadata: {
          documentId:    row.document_id,
          title:         (row.metadata as any)?.title     ?? '',
          n1_header:     (row.metadata as any)?.n1_header ?? '',
          n2_header:     (row.metadata as any)?.n2_header ?? '',
          sectionHeader: row.section_header,
          parentId:      row.id,
        },
      });
    });

    // [TRACE 6] Ordem final dos ParentChunks enviados ao LLM
    console.log('\n[TRACE 6] Ordem final dos ParentChunks enviados ao LLM:');
    parents.forEach((doc, i) =>
      console.log(`  [Documento Ref ${i + 1}] parentId=${doc.metadata.parentId} | section="${doc.metadata.sectionHeader}" | chars=${doc.pageContent.length}`)
    );

    return { parents, sourceDocIds: Array.from(sourceDocIds) };
  }

  async query(
    userQuery: string,
    conversationId: string,
  ): Promise<{ id: string; created_at: Date; response: string; sources: { id: string; title: string }[] }> {
    const { parents, sourceDocIds } = await this.retrieveParentContexts(userQuery, 5);

    const prompt = buildRagPrompt(parents, userQuery);

    let aiResponse = '';
    try {
      const response = await this.llm.invoke(prompt);

      if (typeof response.content === 'string') {
        aiResponse = response.content;
      } else if (Array.isArray(response.content) && response.content.length > 0) {
        const textPart = response.content.find((p: any) => p.type === 'text');
        aiResponse = textPart && 'text' in textPart ? (textPart as any).text : '';
      }

      const finishReason =
        (response as any).response_metadata?.finish_reason ??
        (response as any).generationInfo?.finish_reason ??
        'unknown';
      if (finishReason && finishReason !== 'STOP') {
        this.logger.warn(`[LLM] finishReason inesperado: ${finishReason}`);
      }
    } catch (err: any) {
      this.logger.error(
        `[LLM] Falha em llm.invoke — status=${err?.status ?? err?.code ?? 'n/a'} | message=${err?.message ?? String(err)}`,
      );
    }

    if (!aiResponse.trim()) {
      aiResponse =
        'As informacoes disponiveis nos documentos indexados nao sao suficientes para responder a esta pergunta com precisao.';
    }

    const sourcesMap = new Map<string, { id: string; title: string }>();
    for (const parent of parents) {
      const id    = parent.metadata.documentId as string;
      const title = parent.metadata.title as string;
      if (id && !sourcesMap.has(id)) sourcesMap.set(id, { id, title });
    }
    const sources = Array.from(sourcesMap.values());

    const saved = await this.prisma.interactionHistory.create({
      data: {
        conversation_id: conversationId,
        user_query:      userQuery,
        ai_response:     aiResponse,
        responseSources: {
          create: sourceDocIds.map((id) => ({
            normative: { connect: { id } },
          })),
        },
      },
    });

    return { id: saved.id, created_at: saved.created_at, response: aiResponse, sources };
  }
}
