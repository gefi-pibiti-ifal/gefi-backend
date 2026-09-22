-- Personalidade das respostas do RAG.
--
-- Todas as colunas sao NULLABLE e o valor nulo significa "usa o nivel de cima"
-- (conversa -> usuario -> padrao do sistema). Nenhum backfill e necessario:
-- usuarios, conversas e interacoes existentes continuam validos e passam a
-- responder com a personalidade padrao (INSTITUCIONAL), que e exatamente o
-- comportamento que ja tinham.
--
-- Guardadas como TEXT, nao como enum: acrescentar uma personalidade e uma
-- mudanca de codigo (rag/response-persona.ts), e um valor desconhecido vindo
-- de um cliente desatualizado degrada para o padrao em vez de quebrar.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "response_persona" TEXT;

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN "persona" TEXT;

-- AlterTable
ALTER TABLE "interaction_history" ADD COLUMN "persona" TEXT;
