import { PrismaService } from '../prisma/prisma.service';
export declare class ChatService {
    private prisma;
    constructor(prisma: PrismaService);
    createConversation(title: string, user_id: string): Promise<{
        id: string;
        title: string;
        created_at: Date;
        updated_at: Date;
        user_id: string;
    }>;
    validateConversation(id: string, user_id: string): Promise<{
        id: string;
        title: string;
        created_at: Date;
        updated_at: Date;
        user_id: string;
    }>;
    listConversations(userId?: string): Promise<{
        id: string;
        title: string;
        created_at: Date;
    }[]>;
    getConversationWithHistory(id: string): Promise<({
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
}
