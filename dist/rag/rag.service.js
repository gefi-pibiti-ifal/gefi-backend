"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var RagService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.RagService = void 0;
exports.normalizeForSearch = normalizeForSearch;
exports.buildRagPrompt = buildRagPrompt;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma/prisma.service");
const legal_document_splitter_1 = require("./legal-document-splitter");
const hierarchical_context_1 = require("./hierarchical-context");
const google_genai_1 = require("@langchain/google-genai");
const documents_1 = require("@langchain/core/documents");
const embeddings_1 = require("@langchain/core/embeddings");
const pgvector_1 = require("@langchain/pgvector");
const generative_ai_1 = require("@google/generative-ai");
const dotenv = __importStar(require("dotenv"));
const generative_ai_2 = require("@google/generative-ai");
dotenv.config();
const DEBUG_RAG = process.env.DEBUG_RAG === 'true';
const EMBEDDING_BATCH_SIZE = 15;
const EMBEDDING_BATCH_DELAY = 10_000;
const EMBEDDING_RETRY_DELAY = 65_000;
const EMBEDDING_MAX_RETRIES = 5;
const MIN_PARENT_CONTENT_LENGTH = 80;
const SLIDING_WINDOW_BEFORE = 400;
const SLIDING_WINDOW_AFTER = 800;
const SLIDING_WINDOW_ANCHOR_SIZES = [50, 40, 30, 20];
const delay = (ms) => new Promise((res) => setTimeout(res, ms));
function chunkArray(arr, size) {
    const batches = [];
    for (let i = 0; i < arr.length; i += size)
        batches.push(arr.slice(i, i + size));
    return batches;
}
class NativeGeminiEmbeddings extends embeddings_1.Embeddings {
    model;
    constructor(apiKey) {
        super({});
        const genAI = new generative_ai_1.GoogleGenerativeAI(apiKey);
        this.model = genAI.getGenerativeModel({ model: 'gemini-embedding-2' });
    }
    async embedDocuments(texts) {
        const requests = texts.map((text) => ({
            content: { role: 'user', parts: [{ text }] },
        }));
        const response = await this.model.batchEmbedContents({ requests });
        return response.embeddings.map((e) => e.values);
    }
    async embedQuery(text) {
        const result = await this.model.embedContent(text);
        return result.embedding.values;
    }
}
function isStructuralHeading(line) {
    return (/^ANEXO\s+[A-Z0-9]/i.test(line) ||
        /^CAP[ÍI]TULO\s+[IVXLCDM]/i.test(line) ||
        /^Se[çc][ãa]o\s+[IVXLCDM]/i.test(line) ||
        /^Subse[çc][ãa]o\s+[IVXLCDM]/i.test(line) ||
        /^T[ÍI]TULO\s+[IVXLCDM]/i.test(line) ||
        /^LIVRO\s+[IVXLCDM]/i.test(line));
}
const RE_PDF_NOISE_ALLCAPS = [
    /^(MINISTÉRIO|SECRETARIA|DIRETORIA|DEPARTAMENTO|COORDENAÇÃO|SUBSECRETARIA|SUPERINTENDÊNCIA|GERENCIA|ASSESSORIA)\b/i,
    /^[A-Z]{2,5}$/,
    /^(I{1,3}|IV|VI{0,3}|IX|X{1,3}|XI{1,3}|XIV|XV)$/,
];
function isPdfNoiseAllCaps(line) {
    return RE_PDF_NOISE_ALLCAPS.some(re => re.test(line.trim()));
}
function normalizeForSearch(text) {
    return text.replace(/\s+/g, ' ').trim();
}
function cleanExtractedText(raw) {
    return raw
        .replace(/^\s*[-–]?\s*\d+\s*[-–]?\s*$/gm, '')
        .replace(/^\s*[Pp]ágina\s+\d+\s+de\s+\d+\s*$/gm, '')
        .replace(/^[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÇ\s\/\-\.]{5,80}$/gm, (match) => {
        const trimmed = match.trim();
        if (isStructuralHeading(trimmed))
            return match;
        if (/[a-záéíóúâêîôûãõç]/.test(match))
            return match;
        if (isPdfNoiseAllCaps(trimmed))
            return '';
        return match;
    })
        .replace(/[_\-\.]{4,}/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/^[ \t]+|[ \t]+$/gm, '')
        .trim();
}
function resolveFinishReason(response) {
    return (response?.finishReason ??
        response?.response_metadata?.finishReason ??
        response?.response_metadata?.finish_reason ??
        response?.generationInfo?.finishReason ??
        response?.generationInfo?.finish_reason ??
        'unknown');
}
function buildRagPrompt(contexts, userQuery) {
    const contextBlock = contexts
        .map((doc, i) => {
        const section = doc.metadata.sectionHeader;
        const n2 = doc.metadata.n2_header;
        const label = n2 && n2 !== section ? `${section} — ${n2}` : section;
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
let RagService = RagService_1 = class RagService {
    prisma;
    logger = new common_1.Logger(RagService_1.name);
    vectorStore;
    llm;
    embeddings;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async onModuleInit() {
        const apiKey = process.env.GOOGLE_API_KEY;
        if (!apiKey) {
            this.logger.error('Variavel GOOGLE_API_KEY nao encontrada no .env');
            return;
        }
        this.embeddings = new NativeGeminiEmbeddings(apiKey);
        this.llm = new google_genai_1.ChatGoogleGenerativeAI({
            apiKey,
            model: 'gemini-2.5-flash',
            temperature: 0.4,
            safetySettings: [
                { category: generative_ai_2.HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: generative_ai_2.HarmBlockThreshold.BLOCK_NONE },
                { category: generative_ai_2.HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: generative_ai_2.HarmBlockThreshold.BLOCK_NONE },
                { category: generative_ai_2.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: generative_ai_2.HarmBlockThreshold.BLOCK_NONE },
                { category: generative_ai_2.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: generative_ai_2.HarmBlockThreshold.BLOCK_NONE },
            ],
        });
        this.vectorStore = await pgvector_1.PGVectorStore.initialize(this.embeddings, {
            postgresConnectionOptions: {
                type: 'postgres',
                connectionString: process.env.DATABASE_URL,
            },
            tableName: 'documentos_vetorizados',
            columns: {
                idColumnName: 'id',
                vectorColumnName: 'embedding',
                contentColumnName: 'text',
                metadataColumnName: 'metadata',
            },
        });
        this.logger.log('RAG Service inicializado (Gemini 2.5 + pgvector + PDR persistido)');
    }
    async indexDocument(rawContent, documentId, title) {
        const cleanedText = cleanExtractedText(rawContent);
        const chunks = (0, legal_document_splitter_1.splitLegalDocument)(cleanedText);
        const BATCH_SIZE = 15;
        const BATCH_DELAY = 10000;
        const RETRY_DELAY = 65000;
        let totalChildren = 0;
        const groupMap = new Map();
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
            const entry = groupMap.get(key);
            entry.contentParts.push(chunk.content);
            entry.childContents.push(chunk.content);
        }
        const allChildDocs = [];
        for (const entry of groupMap.values()) {
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
            for (const childContent of entry.childContents) {
                allChildDocs.push(new documents_1.Document({
                    pageContent: childContent,
                    metadata: {
                        documentId,
                        title,
                        parentId: savedParent.id,
                        n1_header: entry.n1_header,
                        n2_header: entry.n2_header,
                    },
                }));
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
                }
                catch (err) {
                    const is429 = err?.status === 429 ||
                        String(err?.message).includes('429') ||
                        String(err?.message).toLowerCase().includes('quota');
                    if (is429 && attempt < 4) {
                        this.logger.warn(`[RAG] Rate limit (429) no lote ${i + 1}. Aguardando ${RETRY_DELAY / 1000}s...`);
                        await delay(RETRY_DELAY);
                        attempt++;
                    }
                    else {
                        throw err;
                    }
                }
            }
            if (i < batches.length - 1)
                await delay(BATCH_DELAY);
        }
        this.logger.log(`Indexado: "${title}" — ${groupMap.size} parents consolidados, ${totalChildren} child chunks vetorizados`);
        return { success: true, documentId, sections: groupMap.size, childChunks: totalChildren };
    }
    async retrieveParentContexts(userQuery, k = 5) {
        const queryVec = await this.embeddings.embedQuery(userQuery);
        console.log('\n[TRACE 1] userQuery:', userQuery);
        console.log(`[TRACE 1] embedding: dim=${queryVec.length} | primeiros valores=[${queryVec.slice(0, 5).map(v => v.toFixed(6)).join(', ')}]`);
        let filter = undefined;
        const anexoMatch = userQuery.match(/(?:Anexo)\s+([IVXLCDM]+(?:-[A-Z])?)/i);
        if (anexoMatch) {
            filter = { n1_header: anexoMatch[0].toUpperCase() };
        }
        console.log('[TRACE 2] filter enviado para similaritySearchVectorWithScore:', JSON.stringify(filter ?? null));
        const childResults = await this.vectorStore.similaritySearchVectorWithScore(queryVec, k, filter);
        console.log(`\n[TRACE 3] ${childResults.length} child chunk(s) retornados:`);
        childResults.forEach(([child, score], i) => {
            console.log(`  [${i + 1}] score=${score.toFixed(6)}` +
                ` | n1="${child.metadata.n1_header ?? ''}"` +
                ` | n2="${child.metadata.n2_header ?? ''}"` +
                ` | parentId=${child.metadata.parentId}` +
                ` | preview="${child.pageContent.slice(0, 120).replace(/\n/g, ' ')}"`);
        });
        const parentIds = new Set();
        const orderedParentIds = [];
        const sourceDocIds = new Set();
        const scoreByParentId = new Map();
        for (const [child, score] of childResults) {
            const parentId = child.metadata.parentId;
            const docId = child.metadata.documentId;
            if (parentId && !parentIds.has(parentId)) {
                parentIds.add(parentId);
                orderedParentIds.push(parentId);
            }
            if (docId)
                sourceDocIds.add(docId);
            if (parentId)
                scoreByParentId.set(parentId, score);
        }
        console.log('\n[TRACE 4] Ordem de insercao dos parentIds no Set:');
        orderedParentIds.forEach((pid, i) => console.log(`  ${i + 1} -> ${pid}`));
        const parentRows = await this.prisma.parentChunk.findMany({
            where: { id: { in: orderedParentIds } },
        });
        const parentMap = new Map(parentRows.map(row => [row.id, row]));
        let orderedParentRows = orderedParentIds
            .map(id => parentMap.get(id))
            .filter(row => row && row.content.length >= MIN_PARENT_CONTENT_LENGTH);
        const siblingExpansionGroups = new Map();
        for (const row of orderedParentRows) {
            const n2Header = (0, hierarchical_context_1.getN2Header)(row);
            const prefixInfo = (0, hierarchical_context_1.deriveSiblingPrefix)(n2Header);
            if (!prefixInfo)
                continue;
            const groupKey = `${row.document_id}|||${(0, hierarchical_context_1.getN1Header)(row)}|||${prefixInfo.parentPrefix}|||${prefixInfo.level}`;
            const score = scoreByParentId.get(row.id) ?? Infinity;
            const existingGroup = siblingExpansionGroups.get(groupKey);
            if (!existingGroup) {
                siblingExpansionGroups.set(groupKey, {
                    documentId: row.document_id,
                    n1Header: (0, hierarchical_context_1.getN1Header)(row),
                    parentPrefix: prefixInfo.parentPrefix,
                    parentNumbers: prefixInfo.parentNumbers,
                    level: prefixInfo.level,
                    bestScore: score,
                    retrievedIds: new Set([row.id]),
                });
            }
            else {
                existingGroup.retrievedIds.add(row.id);
                existingGroup.bestScore = Math.min(existingGroup.bestScore, score);
            }
        }
        if (siblingExpansionGroups.size > 0) {
            const siblingParents = [];
            for (const group of siblingExpansionGroups.values()) {
                const candidates = await this.prisma.parentChunk.findMany({
                    where: {
                        document_id: group.documentId,
                        metadata: { path: ['n1_header'], equals: group.n1Header },
                        section_header: { startsWith: group.parentPrefix },
                    },
                });
                for (const candidate of candidates) {
                    if (group.retrievedIds.has(candidate.id))
                        continue;
                    if (candidate.content.length < MIN_PARENT_CONTENT_LENGTH)
                        continue;
                    const candidateHeader = (0, hierarchical_context_1.getN2Header)(candidate);
                    const parsedCandidate = (0, legal_document_splitter_1.parseItemNumber)(candidateHeader);
                    if (!parsedCandidate || parsedCandidate.level !== group.level)
                        continue;
                    if (!group.parentNumbers.every((value, idx) => parsedCandidate.numbers[idx] === value))
                        continue;
                    siblingParents.push(candidate);
                    scoreByParentId.set(candidate.id, group.bestScore);
                }
            }
            if (siblingParents.length > 0) {
                const parentsByGroup = new Map();
                const groupOrder = [];
                const appendParent = (parent) => {
                    const key = `${parent.document_id}|||${(0, hierarchical_context_1.getN1Header)(parent)}`;
                    if (!parentsByGroup.has(key)) {
                        parentsByGroup.set(key, []);
                        groupOrder.push(key);
                    }
                    const groupRows = parentsByGroup.get(key);
                    if (!groupRows.some((row) => row.id === parent.id)) {
                        groupRows.push(parent);
                    }
                };
                orderedParentRows.forEach(appendParent);
                siblingParents.forEach(appendParent);
                orderedParentRows = groupOrder.flatMap((key) => (0, hierarchical_context_1.sortParentsByStructuralOrder)(parentsByGroup.get(key)));
            }
        }
        const clusters = (0, hierarchical_context_1.buildClusters)(orderedParentRows, scoreByParentId);
        const boostedClusters = (0, hierarchical_context_1.applyHierarchicalBoost)(clusters);
        const boostedParents = (0, hierarchical_context_1.flattenClusters)(boostedClusters);
        const parentsToUse = boostedParents.length ? boostedParents : orderedParentRows;
        console.log('\n[TRACE 5] Ordem retornada pelo Prisma (parentChunk.findMany):');
        parentRows.forEach((row, i) => console.log(`  [${i + 1}] id=${row.id} | section="${row.section_header}" | chars=${row.content.length}`));
        const prismaPreservedOrder = orderedParentIds.every((pid, i) => parentRows[i]?.id === pid);
        console.log(`[TRACE 5] O Prisma preservou a ordem dos parentIds? ${prismaPreservedOrder ? 'SIM' : 'NAO'}`);
        console.log('  (esperado):', orderedParentIds.join(' -> '));
        console.log('  (recebido):', parentRows.map(r => r.id).join(' -> '));
        const MARGEM_ANTES = 400;
        const MARGEM_DEPOIS = 800;
        const triggeringChildByParentId = new Map();
        for (const [child] of childResults) {
            const pid = child.metadata.parentId;
            if (pid && !triggeringChildByParentId.has(pid))
                triggeringChildByParentId.set(pid, child);
        }
        const parents = parentsToUse.map((row) => {
            const triggeringChild = triggeringChildByParentId.get(row.id);
            let pageContent = row.content;
            if (triggeringChild) {
                const anchor = triggeringChild.pageContent.slice(0, 50).trim();
                const startIndex = row.content.indexOf(anchor);
                if (startIndex !== -1) {
                    const windowStart = Math.max(0, startIndex - MARGEM_ANTES);
                    const windowEnd = Math.min(row.content.length, startIndex + triggeringChild.pageContent.length + MARGEM_DEPOIS);
                    const slice = row.content.substring(windowStart, windowEnd);
                    const prefix = windowStart > 0 ? '[...] ' : '';
                    const suffix = windowEnd < row.content.length ? ' [...]' : '';
                    pageContent = `${prefix}${slice}${suffix}`;
                }
            }
            return new documents_1.Document({
                pageContent,
                metadata: {
                    documentId: row.document_id,
                    title: row.metadata?.title ?? '',
                    n1_header: row.metadata?.n1_header ?? '',
                    n2_header: row.metadata?.n2_header ?? '',
                    sectionHeader: row.section_header,
                    parentId: row.id,
                },
            });
        });
        console.log('\n[TRACE 6] Ordem final dos ParentChunks enviados ao LLM:');
        parents.forEach((doc, i) => console.log(`  [Documento Ref ${i + 1}] parentId=${doc.metadata.parentId} | section="${doc.metadata.sectionHeader}" | chars=${doc.pageContent.length}`));
        return { parents, sourceDocIds: Array.from(sourceDocIds) };
    }
    async query(userQuery, conversationId) {
        const { parents, sourceDocIds } = await this.retrieveParentContexts(userQuery, 5);
        const prompt = buildRagPrompt(parents, userQuery);
        let aiResponse = '';
        try {
            const response = await this.llm.invoke(prompt);
            if (typeof response.content === 'string') {
                aiResponse = response.content;
            }
            else if (Array.isArray(response.content) && response.content.length > 0) {
                const textPart = response.content.find((p) => p.type === 'text');
                aiResponse = textPart && 'text' in textPart ? textPart.text : '';
            }
            const finishReason = response.response_metadata?.finish_reason ??
                response.generationInfo?.finish_reason ??
                'unknown';
            if (finishReason && finishReason !== 'STOP') {
                this.logger.warn(`[LLM] finishReason inesperado: ${finishReason}`);
            }
        }
        catch (err) {
            this.logger.error(`[LLM] Falha em llm.invoke — status=${err?.status ?? err?.code ?? 'n/a'} | message=${err?.message ?? String(err)}`);
        }
        if (!aiResponse.trim()) {
            aiResponse =
                'As informacoes disponiveis nos documentos indexados nao sao suficientes para responder a esta pergunta com precisao.';
        }
        const sourcesMap = new Map();
        for (const parent of parents) {
            const id = parent.metadata.documentId;
            const title = parent.metadata.title;
            if (id && !sourcesMap.has(id))
                sourcesMap.set(id, { id, title });
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
        return { id: saved.id, created_at: saved.created_at, response: aiResponse, sources };
    }
};
exports.RagService = RagService;
exports.RagService = RagService = RagService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], RagService);
//# sourceMappingURL=rag.service.js.map