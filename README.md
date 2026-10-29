# GeFi Docs API - NestJS RAG System

Este projeto é uma API REST robusta construída com **NestJS** para gestão de documentos normativos e um assistente de chat baseado em IA utilizando a técnica RAG (Retrieval-Augmented Generation).

## Arquitetura NestJS

O projeto segue a arquitetura modular do NestJS:
- **AuthModule**: Login com Google (verificação do ID token), sessão em cookie e RBAC.
- **UsersModule**: Pré-cadastro de acessos, conclusão de perfil e administração.
- **DocumentsModule**: Processamento de documentos normativos e upload.
- **ChatModule**: Orquestração das conversas e histórico.
- **RagModule**: Inteligência artificial e busca semântica com LangChain.
- **PrismaModule**: Camada de persistência global.

## Tecnologias

- **NestJS** (v11+)
- **Prisma ORM**
- **PostgreSQL**
- **LangChain & OpenAI**
- **Passport JWT** + **google-auth-library**
- **Swagger (OpenAPI)**
- **Docker**
- **pnpm** (gerenciador de pacotes)

## Como Rodar

### Com Docker (Recomendado)

```bash
cp .env.example .env    # veja abaixo as variáveis obrigatórias
docker compose up --build
curl http://localhost:3200/api
```

Sobe dois containers: `gefi-postgres` (pgvector) e `gefi-api`. As migrations são
aplicadas pelo entrypoint antes da API subir.

### Variáveis obrigatórias

A aplicação **não sobe** sem `JWT_SECRET` (mínimo 32 caracteres) e
`GOOGLE_CLIENT_ID` — a validação em `src/config/env.validation.ts` derruba o boot
com mensagem explícita. É deliberado: antes havia um segredo padrão no código, e
um deploy que esquecesse a variável assinava tokens com um valor publicado no
repositório.

```bash
openssl rand -hex 64   # gera o JWT_SECRET
```

Além delas, preencha `POSTGRES_PASSWORD`, as chaves de IA e:

| Variável | Para quê |
|---|---|
| `GOOGLE_ALLOWED_HD` | Domínio do Workspace exigido no login (`ifal.edu.br`). Vazio = só a allowlist vale. |
| `BOOTSTRAP_ADMIN_EMAILS` | Administradores semeados no boot. **Sem ela, um banco novo fica inacessível.** |
| `COOKIE_SECURE` | `false` apenas em `http://localhost`; `true` em qualquer ambiente publicado. |
| `CORS_ORIGIN` | Vazio quando o frontend usa o proxy same-origin (caso normal). |

## Autenticação

Não há login por senha. O fluxo é:

1. O navegador obtém um **ID token** do Google e o envia para `POST /api/auth/google`
2. O backend verifica assinatura, emissor, expiração e `aud` contra as chaves
   públicas do Google, exige `email_verified` e confere a claim `hd`
3. Procura o e-mail na tabela `users`. **Sem linha pré-cadastrada: 403.** O Google
   prova *quem* a pessoa é; quem decide *se* ela entra é o pré-cadastro
4. Assina o JWT do GeFi e o devolve em `Set-Cookie: gefi_session; HttpOnly; SameSite=Lax`

O `JwtStrategy` relê o usuário no banco a cada requisição, então revogação e
mudança de cargo valem na hora, sem esperar a expiração do token.

### Cargos

`@Roles(UserType.ADMINISTRADOR)` + `RolesGuard` (em `src/auth/`) restringem rotas.
Use sempre depois do `JwtAuthGuard`, que é quem preenche `request.user`:

```ts
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserType.ADMINISTRADOR)
```

### Primeiro acesso ao sistema

```bash
# .env
BOOTSTRAP_ADMIN_EMAILS=seu.nome@ifal.edu.br
```

No boot, esses e-mails são criados (ou promovidos) como `ADMINISTRADOR`
pré-cadastrados. A partir daí o cadastro dos demais é feito pela interface, em
`/dashboard/users`. A variável também é a forma de recuperar o acesso caso a
última conta de administrador seja perdida.

#### Deploy no servidor

O serviço `api-deploy` (profile `deploy`) publica na porta **2999**, deixando a
3200 livre para uso local no mesmo host:

```bash
docker compose --profile deploy up -d --build api-deploy
docker compose --profile deploy logs -f api-deploy
docker compose --profile deploy down
```

> Nomear `api-deploy` é obrigatório. Um `up` sem nome de serviço sobe também o
> `api` (que não tem profile) em silêncio, deixando dois containers no host.

**Coloque um reverse proxy com TLS na frente** (nginx/Caddy/Traefik). A aplicação
fala HTTP puro e não deve receber tráfego da internet diretamente. Com o proxy no
mesmo host, feche a porta para fora com `API_BIND=127.0.0.1` no `.env`.

#### Postura de segurança do container

| Medida | Onde | Por quê |
| --- | --- | --- |
| Build multi-stage, imagem final sem toolchain nem devDependencies | `Dockerfile` | `python3`/`make`/`g++`, eslint, jest e o CLI do Nest não chegam ao servidor |
| Roda como o usuário `node` (uid 1000), sem posse dos arquivos | `Dockerfile` | Sem root; a aplicação não consegue sobrescrever o próprio código |
| `read_only: true` + `tmpfs /tmp` | `docker-compose.yml` | Filesystem imutável; a aplicação só grava em memória |
| `cap_drop: ALL` | `docker-compose.yml` | A API escuta na 3000 e não precisa de nenhuma capability |
| `no-new-privileges:true` | `docker-compose.yml` | Bloqueia escalada por binário setuid |
| `pids_limit` + limites de log | `docker-compose.yml` | Contém fork bomb e disco cheio por log |
| Postgres só em `127.0.0.1` | `docker-compose.yml` | O banco nunca é alcançável de fora do host |
| Segredos por `env_file`, nunca no `COPY` | `.dockerignore` | O `.env` não entra na imagem nem no registry |
| Healthcheck pelo próprio `node` | `docker-compose.yml` | Sem `curl`/`wget` na imagem final |

Se `docker compose up` falhar aplicando migrations por causa do filesystem
somente-leitura, use `RUN_MIGRATIONS=false` e aplique-as em um passo próprio:

```bash
docker compose run --rm --no-deps -e RUN_MIGRATIONS=false api ./node_modules/.bin/prisma migrate deploy
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
[http://localhost:3200/api-docs](http://localhost:3200/api-docs)

## Licença

Este projeto é licenciado sob a **GNU General Public License v3.0 ou posterior** (GPL-3.0-or-later). Veja o arquivo [LICENSE](LICENSE) para o texto completo.
