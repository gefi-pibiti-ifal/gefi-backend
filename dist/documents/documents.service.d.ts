import { PrismaService } from '../prisma/prisma.service';
export declare class DocumentsService {
    private prisma;
    constructor(prisma: PrismaService);
    create(data: any): Promise<{
        id: string;
        created_at: Date;
        updated_at: Date;
        title: string;
        document_type: string;
        original_content: string;
        deleted_at: Date | null;
        admin_id: string;
    }>;
    findAll(): Promise<{
        id: string;
        created_at: Date;
        title: string;
        document_type: string;
    }[]>;
}
