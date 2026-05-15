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
        title: string;
        created_at: Date;
        updated_at: Date;
        is_pinned: boolean;
        deleted_at: Date | null;
        user_id: string;
    }>;
    getConversations(req: any, page?: string, limit?: string): Promise<{
        data: {
            id: string;
            title: string;
            created_at: Date;
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
    getConversation(id: string): Promise<({
        interactionHistory: {
            id: string;
            created_at: Date;
            conversation_id: string;
            user_query: string;
            ai_response: string;
        }[];
    } & {
        id: string;
        title: string;
        created_at: Date;
        updated_at: Date;
        is_pinned: boolean;
        deleted_at: Date | null;
        user_id: string;
    }) | null>;
    ask(body: {
        conversation_id: string;
        query: string;
    }, req: any): Promise<{
        id: string;
        created_at: Date;
        user_query: string;
        ai_response: string;
        sources: any[];
        conversation_id: string;
    }>;
    getHistory(conversation_id: string, req: any): Promise<({
        responseSources: ({
            normative: {
                title: string;
                document_type: string;
            };
        } & {
            id: string;
            interaction_id: string;
            normative_id: string;
        })[];
    } & {
        id: string;
        created_at: Date;
        conversation_id: string;
        user_query: string;
        ai_response: string;
    })[]>;
    renameConversation(id: string, body: {
        title: string;
    }, req: any): Promise<{
        id: string;
        title: string;
        created_at: Date;
        updated_at: Date;
        is_pinned: boolean;
        deleted_at: Date | null;
        user_id: string;
    }>;
    togglePin(id: string, body: {
        is_pinned: boolean;
    }, req: any): Promise<{
        id: string;
        title: string;
        created_at: Date;
        updated_at: Date;
        is_pinned: boolean;
        deleted_at: Date | null;
        user_id: string;
    }>;
    softDelete(id: string, req: any): Promise<{
        id: string;
        title: string;
        created_at: Date;
        updated_at: Date;
        is_pinned: boolean;
        deleted_at: Date | null;
        user_id: string;
    }>;
}
