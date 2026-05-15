import { PrismaService } from '../prisma/prisma.service';
export declare class ChatService {
    private prisma;
    constructor(prisma: PrismaService);
    createConversation(title: string, user_id: string): Promise<{
        id: string;
        created_at: Date;
        updated_at: Date;
        title: string;
        is_pinned: boolean;
        deleted_at: Date | null;
        user_id: string;
    }>;
    validateConversation(id: string, user_id: string): Promise<{
        id: string;
        created_at: Date;
        updated_at: Date;
        title: string;
        is_pinned: boolean;
        deleted_at: Date | null;
        user_id: string;
    }>;
    listConversations(userId?: string, page?: number, limit?: number): Promise<{
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
    getConversationWithHistory(id: string): Promise<({
        interactionHistory: {
            id: string;
            created_at: Date;
            user_query: string;
            ai_response: string;
            conversation_id: string;
        }[];
    } & {
        id: string;
        created_at: Date;
        updated_at: Date;
        title: string;
        is_pinned: boolean;
        deleted_at: Date | null;
        user_id: string;
    }) | null>;
    getHistory(conversation_id: string, user_id: string): Promise<({
        responseSources: ({
            normative: {
                title: string;
                document_type: string;
            };
        } & {
            id: string;
            normative_id: string;
            interaction_id: string;
        })[];
    } & {
        id: string;
        created_at: Date;
        user_query: string;
        ai_response: string;
        conversation_id: string;
    })[]>;
    renameConversation(id: string, title: string): Promise<{
        id: string;
        created_at: Date;
        updated_at: Date;
        title: string;
        is_pinned: boolean;
        deleted_at: Date | null;
        user_id: string;
    }>;
    togglePinConversation(id: string, is_pinned: boolean): Promise<{
        id: string;
        created_at: Date;
        updated_at: Date;
        title: string;
        is_pinned: boolean;
        deleted_at: Date | null;
        user_id: string;
    }>;
    softDeleteConversation(id: string): Promise<{
        id: string;
        created_at: Date;
        updated_at: Date;
        title: string;
        is_pinned: boolean;
        deleted_at: Date | null;
        user_id: string;
    }>;
}
