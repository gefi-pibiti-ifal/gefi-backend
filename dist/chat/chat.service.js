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
exports.ChatService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma/prisma.service");
const response_sources_1 = require("../rag/response-sources");
const HISTORY_NORMATIVE_SELECT = {
    id: true,
    title: true,
    document_type: true,
    total_pages: true,
    file_name: true,
    file_mime_type: true,
    file_size: true,
};
let ChatService = class ChatService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async createConversation(title, user_id) {
        return this.prisma.conversation.create({
            data: { title, user_id },
        });
    }
    async validateConversation(id, user_id) {
        const conversation = await this.prisma.conversation.findUnique({
            where: { id },
        });
        if (!conversation)
            throw new common_1.NotFoundException('Conversa não encontrada');
        if (conversation.user_id !== user_id)
            throw new common_1.ForbiddenException('Sem permissão');
        return conversation;
    }
    async listConversations(userId, page = 1, limit = 20) {
        const whereClause = {
            ...(userId ? { user_id: userId } : {}),
            deleted_at: null,
        };
        const skip = (page - 1) * limit;
        const [data, total] = await Promise.all([
            this.prisma.conversation.findMany({
                where: whereClause,
                orderBy: [
                    { is_pinned: 'desc' },
                    { created_at: 'desc' }
                ],
                skip,
                take: limit,
                select: {
                    id: true,
                    title: true,
                    created_at: true,
                    is_pinned: true,
                },
            }),
            this.prisma.conversation.count({ where: whereClause })
        ]);
        const totalPages = Math.ceil(total / limit);
        const hasNextPage = page < totalPages;
        return {
            data,
            meta: {
                page,
                limit,
                total,
                totalPages,
                hasNextPage
            }
        };
    }
    async getConversationWithHistory(id) {
        const conversation = await this.prisma.conversation.findUnique({
            where: { id },
            include: {
                interactionHistory: {
                    orderBy: { created_at: 'asc' },
                    include: {
                        responseSources: {
                            include: {
                                normative: { select: HISTORY_NORMATIVE_SELECT },
                                excerpts: { orderBy: { rank: 'asc' } },
                            },
                        },
                    },
                },
            },
        });
        if (!conversation)
            return conversation;
        return {
            ...conversation,
            interactionHistory: conversation.interactionHistory.map((interaction) => ({
                ...interaction,
                sources: (0, response_sources_1.buildHistorySources)(interaction.responseSources),
            })),
        };
    }
    async getHistory(conversation_id, user_id) {
        await this.validateConversation(conversation_id, user_id);
        const interactions = await this.prisma.interactionHistory.findMany({
            where: { conversation_id },
            orderBy: { created_at: 'asc' },
            include: {
                responseSources: {
                    include: {
                        normative: { select: HISTORY_NORMATIVE_SELECT },
                        excerpts: { orderBy: { rank: 'asc' } },
                    },
                },
            },
        });
        return interactions.map((interaction) => ({
            ...interaction,
            sources: (0, response_sources_1.buildHistorySources)(interaction.responseSources),
        }));
    }
    async renameConversation(id, title) {
        return this.prisma.conversation.update({
            where: { id },
            data: { title },
        });
    }
    async togglePinConversation(id, is_pinned) {
        return this.prisma.conversation.update({
            where: { id },
            data: { is_pinned },
        });
    }
    async softDeleteConversation(id) {
        return this.prisma.conversation.update({
            where: { id },
            data: { deleted_at: new Date() },
        });
    }
};
exports.ChatService = ChatService;
exports.ChatService = ChatService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], ChatService);
//# sourceMappingURL=chat.service.js.map