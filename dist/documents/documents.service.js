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
exports.DocumentsService = void 0;
exports.buildContentDisposition = buildContentDisposition;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma/prisma.service");
const document_location_1 = require("../rag/document-location");
const response_sources_1 = require("../rag/response-sources");
const DOCUMENT_SUMMARY_SELECT = {
    id: true,
    deleted_at: true,
    title: true,
    document_type: true,
    created_at: true,
    updated_at: true,
    file_name: true,
    file_mime_type: true,
    file_size: true,
    total_pages: true,
};
function buildContentDisposition(type, fileName) {
    const sanitized = fileName.replace(/[\r\n"\\]/g, '').trim() || 'documento.pdf';
    const ascii = sanitized.replace(/[^\x20-\x7E]/g, '_');
    return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(sanitized)}`;
}
let DocumentsService = class DocumentsService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async create(data) {
        return this.prisma.normativeDocument.create({
            data,
            select: { ...DOCUMENT_SUMMARY_SELECT, original_content: true, admin_id: true },
        });
    }
    async findAll(page = 1, limit = 10, title) {
        const skip = (page - 1) * limit;
        const where = {
            deleted_at: null,
            ...(title ? { title: { contains: title, mode: 'insensitive' } } : {}),
        };
        const [data, total] = await Promise.all([
            this.prisma.normativeDocument.findMany({
                where,
                select: {
                    id: true,
                    title: true,
                    document_type: true,
                    created_at: true,
                    file_name: true,
                    file_size: true,
                    total_pages: true,
                },
                orderBy: { created_at: 'desc' },
                skip,
                take: limit,
            }),
            this.prisma.normativeDocument.count({ where }),
        ]);
        return {
            data,
            meta: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            },
        };
    }
    async findOne(id) {
        const document = await this.prisma.normativeDocument.findFirst({
            where: { id, deleted_at: null },
            select: DOCUMENT_SUMMARY_SELECT,
        });
        if (!document)
            throw new common_1.NotFoundException('Documento nao encontrado');
        return {
            ...document,
            file: {
                available: Boolean(document.file_name),
                name: document.file_name,
                mime_type: document.file_mime_type,
                size: document.file_size,
            },
            ...(0, response_sources_1.buildDocumentLinks)(document.id, Boolean(document.file_name)),
        };
    }
    async getFile(id) {
        const document = await this.prisma.normativeDocument.findFirst({
            where: { id, deleted_at: null },
            select: {
                id: true,
                title: true,
                file_name: true,
                file_mime_type: true,
                file_size: true,
                file_data: true,
            },
        });
        if (!document)
            throw new common_1.NotFoundException('Documento nao encontrado');
        if (!document.file_data) {
            throw new common_1.NotFoundException('Este documento foi indexado antes da preservacao do arquivo original. ' +
                'O texto continua disponivel em /api/documents/' +
                id +
                '/content; para habilitar o download, reenvie o PDF.');
        }
        return {
            data: Buffer.from(document.file_data),
            fileName: document.file_name ?? `${document.title}.pdf`,
            mimeType: document.file_mime_type ?? 'application/pdf',
        };
    }
    async getContent(id) {
        const document = await this.prisma.normativeDocument.findFirst({
            where: { id, deleted_at: null },
            select: {
                id: true,
                title: true,
                document_type: true,
                indexed_content: true,
                original_content: true,
                page_map: true,
                total_pages: true,
                file_name: true,
            },
        });
        if (!document)
            throw new common_1.NotFoundException('Documento nao encontrado');
        const aligned = Boolean(document.indexed_content);
        return {
            id: document.id,
            title: document.title,
            document_type: document.document_type,
            content: document.indexed_content ?? document.original_content,
            aligned_with_offsets: aligned,
            total_pages: document.total_pages,
            page_map: (0, document_location_1.readPageMap)(document.page_map),
            ...(0, response_sources_1.buildDocumentLinks)(document.id, Boolean(document.file_name)),
        };
    }
    async remove(id) {
        const document = await this.prisma.normativeDocument.findFirst({
            where: { id, deleted_at: null },
        });
        if (!document) {
            throw new common_1.NotFoundException('Documento não encontrado ou já removido');
        }
        await this.prisma.$executeRaw `
      DELETE FROM documentos_vetorizados
      WHERE metadata->>'documentId' = ${id}
    `;
        await this.prisma.responseSource.deleteMany({
            where: { normative_id: id },
        });
        return this.prisma.normativeDocument.delete({
            where: { id },
            select: DOCUMENT_SUMMARY_SELECT,
        });
    }
};
exports.DocumentsService = DocumentsService;
exports.DocumentsService = DocumentsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], DocumentsService);
//# sourceMappingURL=documents.service.js.map