import { DocumentsService } from './documents.service';
import { RagService } from '../rag/rag.service';
export declare class DocumentsController {
    private documentsService;
    private ragService;
    constructor(documentsService: DocumentsService, ragService: RagService);
    upload(file: Express.Multer.File, body: {
        title: string;
        document_type: string;
    }, req: any): Promise<{
        title: string;
        id: string;
        created_at: Date;
        document_type: string;
        original_content: string;
        admin_id: string;
        updated_at: Date;
        deleted_at: Date | null;
    }>;
    findAll(page?: string, limit?: string, title?: string): Promise<{
        data: {
            title: string;
            id: string;
            created_at: Date;
            document_type: string;
        }[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    remove(id: string, req: any): Promise<{
        title: string;
        id: string;
        created_at: Date;
        document_type: string;
        original_content: string;
        admin_id: string;
        updated_at: Date;
        deleted_at: Date | null;
    }>;
}
