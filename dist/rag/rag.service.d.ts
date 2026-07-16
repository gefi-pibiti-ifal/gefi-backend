import { OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
export declare class RagService implements OnModuleInit {
    private prisma;
    private readonly logger;
    private vectorStore;
    private llm;
    private embeddings;
    constructor(prisma: PrismaService);
    onModuleInit(): Promise<void>;
    indexDocument(rawContent: string, documentId: string, title: string): Promise<{
        success: boolean;
        documentId: string;
        sections: number;
        childChunks: number;
    }>;
    private retrieveParentContexts;
    private buildPrompt;
    query(userQuery: string, conversationId: string): Promise<{
        id: string;
        created_at: Date;
        response: string;
        sources: {
            id: string;
            title: string;
        }[];
    }>;
}
