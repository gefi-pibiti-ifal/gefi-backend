"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RagService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma/prisma.service");
let RagService = class RagService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async onModuleInit() {
        console.log('RagService em modo SIMULAÇÃO (sem IA)');
    }
    async indexDocument(content, documentId, title) {
        console.log('[MOCK] Indexando documento:', {
            documentId,
            title,
            contentLength: content?.length,
        });
        await new Promise((res) => setTimeout(res, 200));
        return {
            success: true,
            message: 'Documento indexado em modo simulação',
            documentId,
        };
    }
    async query(userQuery, conversationId) {
        const simulatedAnswer = this.simulateAnswer(userQuery);
        const interaction = await this.prisma.interactionHistory.create({
            data: {
                conversation_id: conversationId,
                user_query: userQuery,
                ai_response: simulatedAnswer,
            },
        });
        await this.prisma.responseSource.create({
            data: {
                interaction_id: interaction.id,
                normative_id: '00000000-0000-0000-0000-000000000000',
            },
        }).catch(() => {
        });
        return simulatedAnswer;
    }
    simulateAnswer(query) {
        const responses = [
            `🔎 [SIMULAÇÃO] Recebi sua pergunta: "${query}"`,
            `📌 [MOCK RAG] Processamento concluído para: "${query}"`,
            `🧠 [TESTE] Sistema funcionando. Query registrada: "${query}"`,
            `✅ Resposta simulada gerada com sucesso para: "${query}"`,
        ];
        return responses[Math.floor(Math.random() * responses.length)];
    }
};
exports.RagService = RagService;
exports.RagService = RagService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], RagService);
//# sourceMappingURL=rag.service.js.map