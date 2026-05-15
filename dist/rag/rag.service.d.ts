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
    indexDocument(content: string, documentId: string, title: string): Promise<{
        success: boolean;
        documentId: string;
    }>;
    query(userQuery: string, conversationId: string): Promise<{
        id: string;
        created_at: Date;
        response: string;
        sources: any[];
    }>;
}
