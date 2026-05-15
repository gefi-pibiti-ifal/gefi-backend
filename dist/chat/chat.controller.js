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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const jwt_auth_guard_1 = require("../auth/jwt-auth.guard");
const chat_service_1 = require("./chat.service");
const rag_service_1 = require("../rag/rag.service");
let ChatController = class ChatController {
    chatService;
    ragService;
    constructor(chatService, ragService) {
        this.chatService = chatService;
        this.ragService = ragService;
    }
    createConversation(body, req) {
        return this.chatService.createConversation(body.title, req.user.id);
    }
    async getConversations(req, page, limit) {
        const userId = req.user?.id || req.user?.sub;
        const pageNum = page ? parseInt(page, 10) : 1;
        const limitNum = limit ? parseInt(limit, 10) : 20;
        return this.chatService.listConversations(userId, pageNum, limitNum);
    }
    async getConversation(id) {
        return this.chatService.getConversationWithHistory(id);
    }
    async ask(body, req) {
        await this.chatService.validateConversation(body.conversation_id, req.user.id);
        const result = await this.ragService.query(body.query, body.conversation_id);
        return {
            id: result.id,
            created_at: result.created_at,
            user_query: body.query,
            ai_response: result.response,
            sources: result.sources,
            conversation_id: body.conversation_id,
        };
    }
    getHistory(conversation_id, req) {
        return this.chatService.getHistory(conversation_id, req.user.id);
    }
    async renameConversation(id, body, req) {
        await this.chatService.validateConversation(id, req.user.id);
        return this.chatService.renameConversation(id, body.title);
    }
    async togglePin(id, body, req) {
        await this.chatService.validateConversation(id, req.user.id);
        return this.chatService.togglePinConversation(id, body.is_pinned);
    }
    async softDelete(id, req) {
        await this.chatService.validateConversation(id, req.user.id);
        return this.chatService.softDeleteConversation(id);
    }
};
exports.ChatController = ChatController;
__decorate([
    (0, common_1.Post)('conversations'),
    (0, swagger_1.ApiOperation)({ summary: 'Cria uma nova conversa' }),
    (0, swagger_1.ApiBody)({
        schema: {
            type: 'object',
            properties: { title: { type: 'string', example: 'Consulta sobre legislação ambiental' } },
            required: ['title'],
        },
    }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], ChatController.prototype, "createConversation", null);
__decorate([
    (0, common_1.Get)('conversations'),
    (0, swagger_1.ApiOperation)({ summary: 'Lista conversas com paginação' }),
    (0, swagger_1.ApiQuery)({ name: 'page', required: false, type: Number }),
    (0, swagger_1.ApiQuery)({ name: 'limit', required: false, type: Number }),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Query)('page')),
    __param(2, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", Promise)
], ChatController.prototype, "getConversations", null);
__decorate([
    (0, common_1.Get)('conversations/:id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ChatController.prototype, "getConversation", null);
__decorate([
    (0, common_1.Post)('ask'),
    (0, swagger_1.ApiOperation)({ summary: 'Faz uma pergunta ao assistente RAG' }),
    (0, swagger_1.ApiBody)({
        schema: {
            type: 'object',
            properties: {
                conversation_id: { type: 'string', example: 'uuid-da-conversa' },
                query: { type: 'string', example: 'Qual é o conteúdo deste documento?' },
            },
            required: ['conversation_id', 'query'],
        },
    }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], ChatController.prototype, "ask", null);
__decorate([
    (0, common_1.Get)('history/:conversation_id'),
    (0, swagger_1.ApiOperation)({ summary: 'Recupera o histórico de uma conversa' }),
    __param(0, (0, common_1.Param)('conversation_id')),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ChatController.prototype, "getHistory", null);
__decorate([
    (0, common_1.Patch)('conversations/:id/rename'),
    (0, swagger_1.ApiOperation)({ summary: 'Renomeia uma conversa' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], ChatController.prototype, "renameConversation", null);
__decorate([
    (0, common_1.Patch)('conversations/:id/pin'),
    (0, swagger_1.ApiOperation)({ summary: 'Fixa ou desfixa uma conversa' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], ChatController.prototype, "togglePin", null);
__decorate([
    (0, common_1.Delete)('conversations/:id'),
    (0, swagger_1.ApiOperation)({ summary: 'Deleta logicamente uma conversa (soft delete)' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], ChatController.prototype, "softDelete", null);
exports.ChatController = ChatController = __decorate([
    (0, swagger_1.ApiTags)('Chat RAG'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Controller)('chat'),
    __metadata("design:paramtypes", [chat_service_1.ChatService,
        rag_service_1.RagService])
], ChatController);
//# sourceMappingURL=chat.controller.js.map