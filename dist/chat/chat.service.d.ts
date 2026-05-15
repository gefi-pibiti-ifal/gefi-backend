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
}
