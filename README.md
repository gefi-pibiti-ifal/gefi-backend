# GeFi Docs API - NestJS RAG System

Este projeto é uma API REST robusta construída com **NestJS** para gestão de documentos normativos e um assistente de chat baseado em IA utilizando a técnica RAG (Retrieval-Augmented Generation).

## Arquitetura NestJS

O projeto segue a arquitetura modular do NestJS:
- **AuthModule**: Gestão de autenticação JWT e estratégias de segurança.
- **UsersModule**: Gestão de usuários e integração com o banco.
- **DocumentsModule**: Processamento de documentos normativos e upload.
- **ChatModule**: Orquestração das conversas e histórico.
- **RagModule**: Inteligência artificial e busca semântica com LangChain.
- **PrismaModule**: Camada de persistência global.

## Tecnologias

- **NestJS** (v11+)
- **Prisma ORM**
- **PostgreSQL**
- **LangChain & OpenAI**
- **Passport JWT**
- **Swagger (OpenAPI)**
- **Docker**

## Como Rodar

### Com Docker (Recomendado)

1. Configure seu `.env` com a `OPENAI_API_KEY`.
2. Execute:
   ```bash
   docker-compose up -d --build
   ```

### Localmente

1. Instale as dependências: `npm install`
2. Configure o banco no `.env`.
3. Gere o Prisma: `npx prisma generate`
4. Rode as migrations: `npx prisma migrate dev`
5. Inicie: `npm run start:dev`

## Documentação

Acesse a documentação interativa em:
[http://localhost:3000/api-docs](http://localhost:3000/api-docs)
