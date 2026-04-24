import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { Document } from '@langchain/core/documents';
import { Embeddings } from '@langchain/core/embeddings';
import { PGVectorStore } from '@langchain/pgvector'; 
import { PoolConfig } from 'pg';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';

dotenv.config();

class NativeGeminiEmbeddings extends Embeddings {
  private model: ReturnType<InstanceType<typeof GoogleGenerativeAI>['getGenerativeModel']>;

  constructor(apiKey: string) {
    super({});
    const genAI = new GoogleGenerativeAI(apiKey);

    this.model = genAI.getGenerativeModel({ model: 'gemini-embedding-2' });
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embedSingle(t)));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embedSingle(text);
  }

  private async embedSingle(text: string): Promise<number[]> {
    const result = await this.model.embedContent(text);
    return result.embedding.values;
  }
}

@Injectable()
export class RagService implements OnModuleInit {
  private readonly logger = new Logger(RagService.name);
  private vectorStore!: PGVectorStore; 
  private llm!: ChatGoogleGenerativeAI;
  private embeddings!: NativeGeminiEmbeddings;

  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    const apiKey = process.env.GOOGLE_API_KEY;

    if (!apiKey) {
      this.logger.error('Variavel GOOGLE_API_KEY nao encontrada no arquivo .env');
      return;
    }

    this.embeddings = new NativeGeminiEmbeddings(apiKey);

    this.llm = new ChatGoogleGenerativeAI({
      apiKey,
      model: 'gemini-2.5-flash',
      temperature: 0.3,
    });

    const config = {
      postgresConnectionOptions: {
        type: 'postgres',
        connectionString: process.env.DATABASE_URL, 
      } as PoolConfig,
      tableName: 'documentos_vetorizados',
      columns: {
        idColumnName: 'id',
        vectorColumnName: 'embedding',
        contentColumnName: 'text',
        metadataColumnName: 'metadata',
      },
    };


    this.vectorStore = await PGVectorStore.initialize(this.embeddings, config);
    
    this.logger.log('RAG Service inicializado com sucesso (PostgreSQL + pgvector)');
  }

  async indexDocument(content: string, documentId: string, title: string) {
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });
    
    const chunks = await splitter.splitText(content);
    
    const documents = chunks.map(
      (chunk) => new Document({ pageContent: chunk, metadata: { documentId, title } }),
    );
    
    await this.vectorStore.addDocuments(documents);
    this.logger.log(`Indexado: "${title}" (${documents.length} chunks)`);
    
    return { success: true, documentId };
  }

  async query(userQuery: string, conversationId: string): Promise<string> {
    const queryVec = await this.embeddings.embedQuery(userQuery);
    const contextDocs = await this.vectorStore.similaritySearchVectorWithScore(queryVec, 5);
    const contextText = contextDocs.map(([doc]) => doc.pageContent).join('\n\n');

    const prompt = `Você é um assistente do GeFi. Responda baseando-se APENAS no contexto abaixo.
Se não souber, diga que não encontrou nos documentos.

Contexto:
${contextText}

Pergunta: ${userQuery}`;

    const response = await this.llm.invoke(prompt);
    const aiResponse = response.content as string;

    const uniqueDocIds: string[] = Array.from(
      new Set(
        contextDocs
          .map(([doc]) => doc.metadata.documentId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    );

    await this.prisma.interactionHistory.create({
      data: {
        conversation_id: conversationId,
        user_query: userQuery,
        ai_response: aiResponse,
        responseSources: {
          create: uniqueDocIds.map((id) => ({
            normative: { connect: { id } },
          })),
        },
      },
    });

    return aiResponse;
  }
}