import { OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Document } from '@langchain/core/documents';
export declare function normalizeForSearch(text: string): string;
export declare function buildRagPrompt(contexts: Document[], userQuery: string): string;
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
