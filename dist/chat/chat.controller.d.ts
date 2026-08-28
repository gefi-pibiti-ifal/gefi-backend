import { ChatService } from './chat.service';
import { RagService } from '../rag/rag.service';
export declare class ChatController {
    private chatService;
    private ragService;
    constructor(chatService: ChatService, ragService: RagService);
    createConversation(body: {
        title: string;
    }, req: any): Promise<{
        id: string;
        created_at: Date;
        updated_at: Date;
        title: string;
        is_pinned: boolean;
        deleted_at: Date | null;
        user_id: string;
    }>;
    getConversations(req: any, page?: string, limit?: string): Promise<{
        data: {
            id: string;
            created_at: Date;
            title: string;
            is_pinned: boolean;
        }[];
        meta: {
            page: number;
            limit: number;
            total: number;
            totalPages: number;
            hasNextPage: boolean;
        };
    }>;
    getConversation(id: string): Promise<{
        interactionHistory: {
            sources: import("../rag/response-sources").ResponseSource[];
            responseSources: ({
                excerpts: {
                    id: string;
                    created_at: Date;
                    page_start: number | null;
                    page_end: number | null;
                    char_start: number | null;
                    char_end: number | null;
                    n1_header: string | null;
                    n2_header: string | null;
                    role: string | null;
                    section_header: string | null;
                    citation: string | null;
                    excerpt: string;
                    rank: number;
                    location_precision: string | null;
                    parent_chunk_id: string | null;
                    response_source_id: string;
                }[];
                normative: {
                    id: string;
                    title: string;
                    document_type: string;
                    file_name: string | null;
                    file_mime_type: string | null;
                    file_size: number | null;
                    total_pages: number | null;
                };
            } & {
                id: string;
                normative_id: string;
                interaction_id: string;
            })[];
            id: string;
            created_at: Date;
            user_query: string;
            ai_response: string;
            conversation_id: string;
        }[];
        id: string;
        created_at: Date;
        updated_at: Date;
        title: string;
        is_pinned: boolean;
        deleted_at: Date | null;
        user_id: string;
    } | null>;
    ask(body: {
        conversation_id: string;
        query: string;
    }, req: any): Promise<{
        id: string;
        created_at: Date;
        user_query: string;
        ai_response: string;
        sources: import("../rag/response-sources").ResponseSource[];
        conversation_id: string;
    }>;
    getHistory(conversation_id: string, req: any): Promise<{
        sources: import("../rag/response-sources").ResponseSource[];
        responseSources: ({
            excerpts: {
                id: string;
                created_at: Date;
                page_start: number | null;
                page_end: number | null;
                char_start: number | null;
                char_end: number | null;
                n1_header: string | null;
                n2_header: string | null;
                role: string | null;
                section_header: string | null;
                citation: string | null;
                excerpt: string;
                rank: number;
                location_precision: string | null;
                parent_chunk_id: string | null;
                response_source_id: string;
            }[];
            normative: {
                id: string;
                title: string;
                document_type: string;
                file_name: string | null;
                file_mime_type: string | null;
                file_size: number | null;
                total_pages: number | null;
            };
        } & {
            id: string;
            normative_id: string;
            interaction_id: string;
        })[];
        id: string;
        created_at: Date;
        user_query: string;
        ai_response: string;
        conversation_id: string;
    }[]>;
    renameConversation(id: string, body: {
        title: string;
    }, req: any): Promise<{
        id: string;
        created_at: Date;
        updated_at: Date;
        title: string;
        is_pinned: boolean;
        deleted_at: Date | null;
        user_id: string;
    }>;
    togglePin(id: string, body: {
        is_pinned: boolean;
    }, req: any): Promise<{
        id: string;
        created_at: Date;
        updated_at: Date;
        title: string;
        is_pinned: boolean;
        deleted_at: Date | null;
        user_id: string;
    }>;
    softDelete(id: string, req: any): Promise<{
        id: string;
        created_at: Date;
        updated_at: Date;
        title: string;
        is_pinned: boolean;
        deleted_at: Date | null;
        user_id: string;
    }>;
}
