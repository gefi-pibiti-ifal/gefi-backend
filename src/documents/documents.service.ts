import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DocumentsService {
  constructor(private prisma: PrismaService) {}

  async create(data: any) {
    return this.prisma.normativeDocument.create({
      data,
    });
  }

  async findAll(page: number = 1, limit: number = 10, title?: string) {
    const skip = (page - 1) * limit;
    
    const where = {
      deleted_at: null,
      ...(title ? { title: { contains: title, mode: 'insensitive' as const } } : {}),
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

  async remove(id: string) {    
    const document = await this.prisma.normativeDocument.findFirst({
      where: { 
        id,
        deleted_at: null 
      },
    });

    if (!document) {
      throw new NotFoundException('Documento não encontrado ou já removido');
    }
    
    return this.prisma.normativeDocument.update({
      where: { id },
      data: {
        deleted_at: new Date(),
      },
    });
  }
}
