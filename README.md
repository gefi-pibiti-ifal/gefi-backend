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

```bash
cp .env.example .env    # preencha POSTGRES_PASSWORD, JWT_SECRET e as chaves de IA
docker compose up --build
curl http://localhost:3000/api
```

Sobe dois containers: `gefi-postgres` (pgvector) e `gefi-api`. As migrations são
aplicadas pelo entrypoint antes da API subir.

#### Deploy no servidor

O serviço `api-deploy` (profile `deploy`) publica na porta **2999**, deixando a
3000 livre para uso local no mesmo host:

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
| `POST /api/documents/:id/access-token` | Token curto (10 min) para abrir o arquivo em `<iframe>`/`<embed>`/pdf.js |
| `POST /api/documents/:id/locations/backfill` | Admin: recalcula coordenadas de documento já indexado (não refaz embeddings) |

### Abrindo o documento no frontend

`view_url` e `download_url` exigem `Authorization: Bearer` — e `<iframe src>`, `<embed>`, `<object>` e o pdf.js **não enviam cabeçalhos**. Por isso o visualizador ficava em branco. Duas formas de resolver:

```js
// 1. Token na URL (funciona direto em iframe/embed/nova aba)
const { view_url, download_url } = await api.post(`/documents/${id}/access-token`);
iframe.src = `${API_BASE}${view_url}#page=${excerpt.location.page_start}`;

// 2. Blob (quando a página já busca com o token de sessão)
const res  = await fetch(`${API_BASE}${source.view_url}`, { headers: { Authorization: `Bearer ${jwt}` } });
const name = res.headers.get('Content-Disposition');  // legível: exposto via CORS
iframe.src = URL.createObjectURL(await res.blob());
```

O token de acesso vale 10 minutos, serve **só para leitura** e **só para aquele documento** — não autentica sessão nem autoriza exclusão.

Documentos enviados **antes** desta funcionalidade não têm arquivo original (`file.available: false`) nem páginas. O backfill recupera os offsets de caractere; páginas e localização por trecho exigem reenviar o PDF.

## Personalidade das respostas

O GeFi responde em dois registros. A personalidade muda **como** a resposta é escrita — nunca **o que** ela diz: estrutura, seleção de dispositivos, cobertura, fidelidade e citação da fonte são idênticas nas duas (há teste travando essa invariante).

| id | tom |
| --- | --- |
| `INSTITUCIONAL` (padrão) | Impessoal, como um órgão respondendo a uma consulta interna. Não se dirige ao leitor. |
| `CORDIAL` | Formal no conteúdo, próximo no tom. Pode usar "você" com moderação e explicar o porquê — **só quando os trechos o sustentam**. |

Em ambas continuam proibidos: opinião, recomendação fora da norma, saudação, emoji e qualquer afirmação que os trechos não sustentem.

**Abertura interativa.** A resposta começa por uma *linha de entrada* — uma frase que situa quem perguntou antes de receber a regra — e só então dá a resposta (que aparece no máximo na segunda frase). A linha só sobrevive se passar em três testes: contém um fato concreto dos trechos, faz falta quando apagada, e não serviria para qualquer pergunta do mesmo assunto. O erro que ela mais atrai é a *frase de tema* ("o cabimento depende do enquadramento do objeto"), nomeada no prompt como o que **não** fazer.

- INSTITUCIONAL: sóbria e factual — *"O teto muda conforme o objeto: obra e engenharia têm um valor, compras e serviços têm outro."*
- CORDIAL: fala com o leitor — *"Depende do que você vai contratar: obra e engenharia têm um teto, compra e serviço comum têm outro."*

**Perguntas de procedimento** (as mais comuns do fiscal) seguem o modo 5B, com um bloco por dispositivo. Para a resposta ser um roteiro de trabalho e não o índice da norma: a abertura diz em quantos momentos a rotina se divide; o título do bloco pode nomear **o momento** (*"Ao fechar o mês"*) quando o próprio dispositivo declara esse momento; e a frase de cada bloco é uma **tradução** do que a pessoa faz ali, não um recorte da norma. As garantias de cobertura seguem intactas — um dispositivo por bloco, nada fundido, nada omitido.

Sem eval automatizado, mudanças de prompt só se julgam lendo a saída. Para comparar a mesma pergunta nas duas personalidades contra o modelo real:

```bash
PORT=3999 node dist/main.js &
node scripts/comparar-personas.js "sua pergunta aqui"
```

**Escolha em três níveis**, do mais específico para o mais geral:

1. `persona` no corpo de `POST /api/chat/ask` — vale só para aquela resposta;
2. `Conversation.persona` — fixa o tom de uma consulta inteira;
3. `User.response_persona` — a preferência do usuário;
4. padrão do sistema (`INSTITUCIONAL`).

Um valor desconhecido (cliente desatualizado) cai no padrão em vez de falhar; na **escrita** da preferência, porém, é recusado com 400 — gravar outra coisa em silêncio seria mentir para o usuário.

| Rota | Descrição |
| --- | --- |
| `GET /api/chat/personas` | Catálogo do seletor: `id`, `label`, `description`, `sample`, `is_default` |
| `GET /api/users/me` | Perfil + `response_persona` + `available_personas` |
| `PATCH /api/users/me/preferences` | `{ "response_persona": "CORDIAL" }` |
| `POST /api/chat/conversations` | aceita `persona` opcional |
| `PATCH /api/chat/conversations/:id/persona` | `{ "persona": "CORDIAL" }` — `null` volta à preferência do usuário |

`POST /api/chat/ask` devolve `persona` com a personalidade que **de fato** gerou a resposta, e cada interação do histórico guarda a sua — trocar de preferência não reescreve o passado.

## Documentação

Acesse a documentação interativa em:
[http://localhost:3000/api-docs](http://localhost:3000/api-docs)
