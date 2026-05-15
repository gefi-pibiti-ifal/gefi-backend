import { PrismaService } from '../prisma/prisma.service';
export declare class DocumentsService {
    private prisma;
    constructor(prisma: PrismaService);
    create(data: any): Promise<{
        id: string;
        created_at: Date;
        updated_at: Date;
        title: string;
        deleted_at: Date | null;
        document_type: string;
        original_content: string;
        admin_id: string;
    }>;
    findAll(page?: number, limit?: number, title?: string): Promise<{
        data: {
            id: string;
            created_at: Date;
            title: string;
            document_type: string;
        }[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    remove(id: string): Promise<{
        id: string;
        created_at: Date;
        updated_at: Date;
        title: string;
        deleted_at: Date | null;
        document_type: string;
        original_content: string;
        admin_id: string;
    }>;
}
