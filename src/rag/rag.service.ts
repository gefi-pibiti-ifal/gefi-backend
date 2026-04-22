import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RagService implements OnModuleInit {
  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    // nada para inicializar no modo mock
    console.log('RagService em modo SIMULAÇÃO (sem IA)');
  }

  /**
   * 🚀 Simulação de indexação de documento
   * Mantém o fluxo da API funcionando sem embeddings
   */
  async indexDocument(content: string, documentId: string, title: string) {
    console.log('[MOCK] Indexando documento:', {
      documentId,
      title,
      contentLength: content?.length,
    });

    // Simula delay de processamento
    await new Promise((res) => setTimeout(res, 200));

    return {
      success: true,
      message: 'Documento indexado em modo simulação',
      documentId,
    };
  }

  /**
   * 🧠 QUERY SIMULADA (SEM IA)
   * Apenas testa fluxo de conversa + persistência no banco
   */
  async query(userQuery: string, conversationId: string) {
    // resposta simulada
    const simulatedAnswer = this.simulateAnswer(userQuery);

    // salva interação no banco (TESTE REAL DO FLUXO)
    const interaction = await this.prisma.interactionHistory.create({
      data: {
        conversation_id: conversationId,
        user_query: userQuery,
        ai_response: simulatedAnswer,
      },
    });

    // salva fonte fake (para testar relacionamento)
    await this.prisma.responseSource.create({
      data: {
        interaction_id: interaction.id,
        normative_id: '00000000-0000-0000-0000-000000000000',
      },
    }).catch(() => {
      // evita crash caso FK não aceite
    });

    return simulatedAnswer;
  }

  /**
   * 🧪 Resposta fake para testes
   */
  private simulateAnswer(query: string): string {
    const responses = [
      `🔎 [SIMULAÇÃO] Recebi sua pergunta: "${query}"`,
      `📌 [MOCK RAG] Processamento concluído para: "${query}"`,
      `🧠 [TESTE] Sistema funcionando. Query registrada: "${query}"`,
      `✅ Resposta simulada gerada com sucesso para: "${query}"`,
    ];

    return responses[Math.floor(Math.random() * responses.length)];
  }
}