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
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma/prisma.service");
let DocumentsService = class DocumentsService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async create(data) {
        return this.prisma.normativeDocument.create({
            data,
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
    async remove(id) {
        const document = await this.prisma.normativeDocument.findFirst({
            where: {
                id,
                deleted_at: null
            },
        });
        if (!document) {
            throw new common_1.NotFoundException('Documento não encontrado ou já removido');
        }
        return this.prisma.normativeDocument.update({
            where: { id },
            data: {
                deleted_at: new Date(),
            },
        });
    }
};
exports.DocumentsService = DocumentsService;
exports.DocumentsService = DocumentsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], DocumentsService);
//# sourceMappingURL=documents.service.js.map