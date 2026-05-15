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
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma/prisma.service");
const google_genai_1 = require("@langchain/google-genai");
const textsplitters_1 = require("@langchain/textsplitters");
const documents_1 = require("@langchain/core/documents");
const embeddings_1 = require("@langchain/core/embeddings");
const pgvector_1 = require("@langchain/pgvector");
const generative_ai_1 = require("@google/generative-ai");
const dotenv = __importStar(require("dotenv"));
dotenv.config();
class NativeGeminiEmbeddings extends embeddings_1.Embeddings {
    model;
    constructor(apiKey) {
        super({});
        const genAI = new generative_ai_1.GoogleGenerativeAI(apiKey);
        this.model = genAI.getGenerativeModel({ model: 'gemini-embedding-2' });
    }
    async embedDocuments(texts) {
        return Promise.all(texts.map((t) => this.embedSingle(t)));
    }
    async embedQuery(text) {
        return this.embedSingle(text);
    }
    async embedSingle(text) {
        const result = await this.model.embedContent(text);
        return result.embedding.values;
    }
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
            this.logger.error('Variavel GOOGLE_API_KEY nao encontrada no arquivo .env');
            return;
        }
        this.embeddings = new NativeGeminiEmbeddings(apiKey);
        this.llm = new google_genai_1.ChatGoogleGenerativeAI({
            apiKey,
            model: 'gemini-2.5-flash',
            temperature: 0.3,
        });
        const config = {
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
        };
        this.vectorStore = await pgvector_1.PGVectorStore.initialize(this.embeddings, config);
        this.logger.log('RAG Service inicializado com sucesso (Gemma 4 + pgvector)');
    }
    async indexDocument(content, documentId, title) {
        const splitter = new textsplitters_1.RecursiveCharacterTextSplitter({
            chunkSize: 1000,
            chunkOverlap: 200,
        });
        const chunks = await splitter.splitText(content);
        const documents = chunks.map((chunk) => new documents_1.Document({ pageContent: chunk, metadata: { documentId, title } }));
        await this.vectorStore.addDocuments(documents);
        this.logger.log(`Indexado: "${title}" (${documents.length} chunks)`);
        return { success: true, documentId };
    }
    async query(userQuery, conversationId) {
        const queryVec = await this.embeddings.embedQuery(userQuery);
        const contextDocs = await this.vectorStore.similaritySearchVectorWithScore(queryVec, 5);
        const contextText = contextDocs.map(([doc]) => doc.pageContent).join('\n\n');
        const prompt = `Você é um assistente do GeFi. Responda baseando-se APENAS no contexto abaixo.
Se não souber, diga que não encontrou nos documentos.

Contexto:
${contextText}

Pergunta: ${userQuery}`;
        const response = await this.llm.invoke(prompt);
        let aiResponse = '';
        if (typeof response.content === 'string') {
            aiResponse = response.content;
        }
        else if (Array.isArray(response.content)) {
            const textPart = response.content.find((part) => part.type === 'text');
            aiResponse = textPart && 'text' in textPart
                ? textPart.text
                : JSON.stringify(response.content);
        }
        if (!aiResponse || aiResponse.trim() === '') {
            aiResponse = 'Não encontrei informações nos documentos normativos para responder a esta pergunta.';
        }
        const sourcesMap = new Map();
        contextDocs.forEach(([doc]) => {
            const id = doc.metadata.documentId;
            if (id && !sourcesMap.has(id)) {
                sourcesMap.set(id, { id, title: doc.metadata.title });
            }
        });
        const sources = Array.from(sourcesMap.values());
        const uniqueDocIds = Array.from(sourcesMap.keys());
        const savedInteraction = await this.prisma.interactionHistory.create({
            data: {
                conversation_id: conversationId,
                user_query: userQuery,
                ai_response: aiResponse,
                responseSources: {
                    create: uniqueDocIds.map((id) => ({
                        normative: { connect: { id } },
                    })),
                },
            },
        });
        return { id: savedInteraction.id, created_at: savedInteraction.created_at, response: aiResponse, sources };
    }
};
exports.RagService = RagService;
exports.RagService = RagService = RagService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], RagService);
//# sourceMappingURL=rag.service.js.map