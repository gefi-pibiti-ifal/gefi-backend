import { OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { type CharRange, type PageInput, type PageSpan } from './document-location';
import { type ResponseSource } from './response-sources';
import { Document } from '@langchain/core/documents';
export declare function normalizeForSearch(text: string): string;
export declare function locationMetadata(range: CharRange | null, pages: PageSpan | null): Record<string, number>;
export declare function findAnchorIndex(parentContent: string, childContent: string): number;
export declare function snapWindowStart(content: string, start: number): number;
export declare function snapWindowEnd(content: string, end: number): number;
export declare function stripInvisibleArtifacts(text: string): string;
export declare function collectAttestedWords(text: string): Set<string>;
export declare function dehyphenateAttested(text: string, vocabulary?: Set<string>): string;
export declare function cleanExtractedText(raw: string, vocabulary?: Set<string>): string;
export { SECTION_HEADER_FALLBACK, normalizeDocumentTitle, buildSourceLabel, buildCitation, } from './source-citation';
export declare function buildChunkEmbedText(rawChild: string, ctx: {
    title?: string;
    sectionHeading?: string;
    item?: string;
}): string;
export declare function buildRagPrompt(contexts: Document[], userQuery: string): string;
export declare class RagService implements OnModuleInit {
    private prisma;
    private readonly logger;
    private vectorStore;
    private llm;
    private embeddings;
    constructor(prisma: PrismaService);
    onModuleInit(): Promise<void>;
    indexDocument(rawContent: string, documentId: string, title: string, pages?: PageInput[]): Promise<{
        success: boolean;
        documentId: string;
        sections: number;
        childChunks: number;
        pagesMapped: number;
        locatedSections: number;
    }>;
    backfillDocumentLocations(documentId: string): Promise<{
        documentId: string;
        parents: number;
        located: number;
    }>;
    private retrieveParentContexts;
    private loadSourceDocuments;
    query(userQuery: string, conversationId: string): Promise<{
        id: string;
        created_at: Date;
        response: string;
        sources: ResponseSource[];
    }>;
}
