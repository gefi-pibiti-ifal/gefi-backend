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
- **pnpm** (gerenciador de pacotes)

## Como Rodar

### Com Docker (Recomendado)

1. Configure seu `.env` com a `OPENAI_API_KEY`.
2. Execute:
   ```bash
   docker-compose up -d --build
   ```

### Localmente

> O projeto usa **pnpm** (versão fixada em `packageManager`). Habilite com `corepack enable`
> — não use `npm install`, isso recria o `package-lock.json` (que é ignorado pelo git).

1. Instale as dependências: `pnpm install`
2. Configure o banco no `.env`.
3. Gere o Prisma: `pnpm exec prisma generate`
4. Rode as migrations: `pnpm exec prisma migrate dev`
5. Inicie: `pnpm start:dev`

### Segurança das dependências

- `pnpm audit` deve reportar **0 vulnerabilidades**.
- Correções de dependências transitivas ficam em `overrides`, no `pnpm-workspace.yaml`,
  com o motivo de cada uma comentado.
- Scripts de instalação (`postinstall`) são bloqueados por padrão; a lista do que pode
  rodar está em `allowBuilds`, no mesmo arquivo. Ao adicionar um pacote que precise
  compilar algo, use `pnpm approve-builds`.

## Fontes navegáveis (RAG)

Toda resposta do RAG devolve `sources`: uma entrada por **documento** citado, com os **trechos** que fundamentaram a resposta e, quando os dados permitem, a **localização** de cada trecho dentro do documento.

```jsonc
{
  "id": "uuid-do-documento",          // identificação inequívoca da fonte
  "title": "IN 05/2017",
  "document_type": "INSTRUCAO_NORMATIVA",
  "total_pages": 42,
  "file": { "available": true, "name": "in-05-2017.pdf", "mime_type": "application/pdf", "size": 918273 },
  "view_url": "/api/documents/{id}/file",              // null quando não há arquivo original
  "download_url": "/api/documents/{id}/file?download=1",
  "content_url": "/api/documents/{id}/content",        // sempre disponível
  "excerpts": [
    {
      "parent_chunk_id": "uuid-do-parent-chunk",
      "citation": "Item 10.2 – ANEXO VIII-B – IN 05/2017",
      "section_header": "10.2.", "n1_header": "ANEXO VIII-B", "n2_header": "10.2.",
      "role": "PRINCIPAL",                              // ou COMPLEMENTAR
      "excerpt": "texto exato enviado ao modelo",
      "location": {                                     // null quando não determinável
        "page_start": 12, "page_end": 12,
        "char_start": 48210, "char_end": 48930,         // offsets em content_url
        "precision": "TRECHO"                           // TRECHO | DISPOSITIVO
      }
    }
  ]
}
```

- `location: null` é um resultado legítimo: a fonte continua abrindo o documento. Nenhuma página ou posição é estimada.
- `precision`: `TRECHO` = intervalo dos chunks que a busca vetorial recuperou; `DISPOSITIVO` = o item/artigo inteiro.
- `char_start`/`char_end` são offsets no texto de `content_url` (`aligned_with_offsets: true`), não no PDF. Para destacar dentro do PDF, use `page_start` e busque o texto de `excerpt`.
- O mesmo contrato volta em `GET /api/chat/history/:conversation_id` (campo `sources`), reconstruído do que foi persistido — sem refazer a recuperação.

### Rotas de documento

| Rota | Descrição |
| --- | --- |
| `GET /api/documents/:id` | Metadados da fonte + links |
| `GET /api/documents/:id/file` | Arquivo original (inline); `?download=1` força download |
| `GET /api/documents/:id/content` | Texto indexado + `page_map` (coordenadas das fontes) |
| `POST /api/documents/:id/locations/backfill` | Admin: recalcula coordenadas de documento já indexado (não refaz embeddings) |

Documentos enviados **antes** desta funcionalidade não têm arquivo original (`file.available: false`) nem páginas. O backfill recupera os offsets de caractere; páginas e localização por trecho exigem reenviar o PDF.

## Documentação

Acesse a documentação interativa em:
[http://localhost:3000/api-docs](http://localhost:3000/api-docs)
