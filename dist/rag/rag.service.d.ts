import { OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
export declare class RagService implements OnModuleInit {
    private prisma;
    constructor(prisma: PrismaService);
    onModuleInit(): Promise<void>;
    indexDocument(content: string, documentId: string, title: string): Promise<{
        success: boolean;
        message: string;
        documentId: string;
    }>;
    query(userQuery: string, conversationId: string): Promise<string>;
    private simulateAnswer;
}
