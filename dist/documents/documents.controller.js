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
exports.DocumentsController = void 0;
const common_1 = require("@nestjs/common");
const platform_express_1 = require("@nestjs/platform-express");
const swagger_1 = require("@nestjs/swagger");
const jwt_auth_guard_1 = require("../auth/jwt-auth.guard");
const documents_service_1 = require("./documents.service");
const rag_service_1 = require("../rag/rag.service");
const pdf_1 = require("@langchain/community/document_loaders/fs/pdf");
let DocumentsController = class DocumentsController {
    documentsService;
    ragService;
    constructor(documentsService, ragService) {
        this.documentsService = documentsService;
        this.ragService = ragService;
    }
    async upload(file, body, req) {
        if (req.user.user_type !== 'ADMINISTRADOR') {
            throw new common_1.ForbiddenException('Apenas administradores podem enviar documentos');
        }
        if (!file?.buffer) {
            throw new common_1.BadRequestException('Nenhum ficheiro recebido ou ficheiro vazio.');
        }
        let content;
        try {
            const blob = new Blob([new Uint8Array(file.buffer)], { type: 'application/pdf' });
            const loader = new pdf_1.PDFLoader(blob, { splitPages: false });
            const docs = await loader.load();
            content = docs.map((doc) => doc.pageContent).join('\n').trim();
            if (!content) {
                throw new common_1.BadRequestException('Não foi possível extrair texto. O PDF pode ser baseado em imagens (digitalizado).');
            }
        }
        catch (err) {
            if (err instanceof common_1.BadRequestException)
                throw err;
            const message = err instanceof Error ? err.message : String(err);
            throw new common_1.BadRequestException(`Falha na extração pelo LangChain: ${message}`);
        }
        const document = await this.documentsService.create({
            title: body.title,
            document_type: body.document_type,
            original_content: content,
            admin_id: req.user.id,
        });
        this.ragService
            .indexDocument(content, document.id, document.title)
            .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[RAG] Falha ao indexar o documento ${document.id}: ${msg}`);
        });
        return document;
    }
    async findAll(page, limit, title) {
        const pageNum = page ? parseInt(page, 10) : 1;
        const limitNum = limit ? parseInt(limit, 10) : 5;
        return this.documentsService.findAll(pageNum, limitNum, title);
    }
    async remove(id, req) {
        if (req.user.user_type !== 'ADMINISTRADOR') {
            throw new common_1.ForbiddenException('Apenas administradores podem deletar documentos');
        }
        return this.documentsService.remove(id);
    }
};
exports.DocumentsController = DocumentsController;
__decorate([
    (0, common_1.Post)('upload'),
    (0, swagger_1.ApiOperation)({ summary: 'Upload de documento normativo' }),
    (0, swagger_1.ApiConsumes)('multipart/form-data'),
    (0, swagger_1.ApiBody)({
        schema: {
            type: 'object',
            properties: {
                title: { type: 'string' },
                document_type: { type: 'string' },
                file: { type: 'string', format: 'binary' },
            },
            required: ['title', 'document_type', 'file'],
        },
    }),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('file', {
        limits: { fileSize: 20 * 1024 * 1024 },
        fileFilter: (_, file, cb) => {
            file.mimetype === 'application/pdf'
                ? cb(null, true)
                : cb(new common_1.BadRequestException('Apenas ficheiros PDF são permitidos'), false);
        },
    })),
    __param(0, (0, common_1.UploadedFile)()),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", Promise)
], DocumentsController.prototype, "upload", null);
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'Lista documentos com paginação e busca' }),
    (0, swagger_1.ApiQuery)({ name: 'page', required: false, type: Number }),
    (0, swagger_1.ApiQuery)({ name: 'limit', required: false, type: Number }),
    (0, swagger_1.ApiQuery)({ name: 'title', required: false, type: String }),
    __param(0, (0, common_1.Query)('page')),
    __param(1, (0, common_1.Query)('limit')),
    __param(2, (0, common_1.Query)('title')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", Promise)
], DocumentsController.prototype, "findAll", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], DocumentsController.prototype, "remove", null);
exports.DocumentsController = DocumentsController = __decorate([
    (0, swagger_1.ApiTags)('Documentos'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Controller)('documents'),
    __metadata("design:paramtypes", [documents_service_1.DocumentsService,
        rag_service_1.RagService])
], DocumentsController);
//# sourceMappingURL=documents.controller.js.map