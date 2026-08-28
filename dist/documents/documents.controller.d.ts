import { StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
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
        deleted_at: Date | null;
        document_type: string;
        original_content: string;
        file_name: string | null;
        file_mime_type: string | null;
        file_size: number | null;
        total_pages: number | null;
        admin_id: string;
    }>;
    findAll(page?: string, limit?: string, title?: string): Promise<{
        data: {
            id: string;
            created_at: Date;
            title: string;
            document_type: string;
            file_name: string | null;
            file_size: number | null;
            total_pages: number | null;
        }[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    findOne(id: string): Promise<{
        view_url: string | null;
        download_url: string | null;
        content_url: string;
        file: {
            available: boolean;
            name: string | null;
            mime_type: string | null;
            size: number | null;
        };
        id: string;
        created_at: Date;
        updated_at: Date;
        title: string;
        deleted_at: Date | null;
        document_type: string;
        file_name: string | null;
        file_mime_type: string | null;
        file_size: number | null;
        total_pages: number | null;
    }>;
    getFile(id: string, res: Response, download?: string): Promise<StreamableFile>;
    getContent(id: string): Promise<{
        view_url: string | null;
        download_url: string | null;
        content_url: string;
        id: string;
        title: string;
        document_type: string;
        content: string;
        aligned_with_offsets: boolean;
        total_pages: number | null;
        page_map: import("../rag/document-location").PageMapEntry[];
    }>;
    backfillLocations(id: string, req: any): Promise<{
        documentId: string;
        parents: number;
        located: number;
    }>;
    remove(id: string, req: any): Promise<{
        id: string;
        created_at: Date;
        updated_at: Date;
        title: string;
        deleted_at: Date | null;
        document_type: string;
        file_name: string | null;
        file_mime_type: string | null;
        file_size: number | null;
        total_pages: number | null;
    }>;
}
