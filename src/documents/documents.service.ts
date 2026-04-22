import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DocumentsService {
  constructor(private prisma: PrismaService) {}

  async create(data: any) {
    return this.prisma.normativeDocument.create({
      data,
    });
  }

  async findAll() {
    return this.prisma.normativeDocument.findMany({
      select: {
        id: true,
        title: true,
        document_type: true,
        created_at: true,
      },
      where: {
        deleted_at: null,
      },
    });
  }
}
