import { VectorStore } from '@langchain/core/vectorstores';
import { Embeddings } from '@langchain/core/embeddings';
import { Document } from '@langchain/core/documents';

export class SimpleMemoryVectorStore extends VectorStore {
  private memoryVectors: { document: Document; embedding: number[] }[] = [];

  constructor(embeddings: Embeddings) {
    super(embeddings, {});
  }

  _vectorstoreType(): string {
    return 'simple_memory';
  }

  async addVectors(vectors: number[][], documents: Document[]): Promise<void> {
    for (let i = 0; i < vectors.length; i++) {
      this.memoryVectors.push({
        document: documents[i],
        embedding: vectors[i],
      });
    }
  }

  async addDocuments(documents: Document[]): Promise<void> {
    const texts = documents.map((doc) => doc.pageContent);
    const embeddings = await this.embeddings.embedDocuments(texts);
    await this.addVectors(embeddings, documents);
  }

  async similaritySearchVectorWithScore(
    query: number[],
    k: number,
  ): Promise<[Document, number][]> {
    const results = this.memoryVectors.map((vector) => {
      const score = this.cosineSimilarity(query, vector.embedding);
      return [vector.document, score] as [Document, number];
    });

    results.sort((a, b) => b[1] - a[1]);
    return results.slice(0, k);
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}