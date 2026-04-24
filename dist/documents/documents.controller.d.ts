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
