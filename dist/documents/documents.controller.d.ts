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
        title: string;
        created_at: Date;
        document_type: string;
        original_content: string;
        admin_id: string;
        updated_at: Date;
        deleted_at: Date | null;
    }>;
    findAll(): Promise<{
        id: string;
        title: string;
        created_at: Date;
        document_type: string;
    }[]>;
}
