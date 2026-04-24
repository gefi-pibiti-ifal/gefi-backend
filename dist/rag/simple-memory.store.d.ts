import { VectorStore } from '@langchain/core/vectorstores';
import { Embeddings } from '@langchain/core/embeddings';
import { Document } from '@langchain/core/documents';
export declare class SimpleMemoryVectorStore extends VectorStore {
    private memoryVectors;
    constructor(embeddings: Embeddings);
    _vectorstoreType(): string;
    addVectors(vectors: number[][], documents: Document[]): Promise<void>;
    addDocuments(documents: Document[]): Promise<void>;
    similaritySearchVectorWithScore(query: number[], k: number): Promise<[Document, number][]>;
    private cosineSimilarity;
}
