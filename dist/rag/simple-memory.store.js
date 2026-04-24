"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SimpleMemoryVectorStore = void 0;
const vectorstores_1 = require("@langchain/core/vectorstores");
class SimpleMemoryVectorStore extends vectorstores_1.VectorStore {
    memoryVectors = [];
    constructor(embeddings) {
        super(embeddings, {});
    }
    _vectorstoreType() {
        return 'simple_memory';
    }
    async addVectors(vectors, documents) {
        for (let i = 0; i < vectors.length; i++) {
            this.memoryVectors.push({
                document: documents[i],
                embedding: vectors[i],
            });
        }
    }
    async addDocuments(documents) {
        const texts = documents.map((doc) => doc.pageContent);
        const embeddings = await this.embeddings.embedDocuments(texts);
        await this.addVectors(embeddings, documents);
    }
    async similaritySearchVectorWithScore(query, k) {
        const results = this.memoryVectors.map((vector) => {
            const score = this.cosineSimilarity(query, vector.embedding);
            return [vector.document, score];
        });
        results.sort((a, b) => b[1] - a[1]);
        return results.slice(0, k);
    }
    cosineSimilarity(vecA, vecB) {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0)
            return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
}
exports.SimpleMemoryVectorStore = SimpleMemoryVectorStore;
//# sourceMappingURL=simple-memory.store.js.map