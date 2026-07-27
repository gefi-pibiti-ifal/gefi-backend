"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var RagService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.RagService = void 0;
exports.normalizeForSearch = normalizeForSearch;
exports.findAnchorIndex = findAnchorIndex;
exports.snapWindowStart = snapWindowStart;
exports.snapWindowEnd = snapWindowEnd;
exports.stripInvisibleArtifacts = stripInvisibleArtifacts;
exports.dehyphenateAttested = dehyphenateAttested;
exports.buildSourceLabel = buildSourceLabel;
exports.buildChunkEmbedText = buildChunkEmbedText;
exports.buildRagPrompt = buildRagPrompt;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma/prisma.service");
const legal_document_splitter_1 = require("./legal-document-splitter");
const hierarchical_context_1 = require("./hierarchical-context");
const google_genai_1 = require("@langchain/google-genai");
const documents_1 = require("@langchain/core/documents");
const embeddings_1 = require("@langchain/core/embeddings");
const pgvector_1 = require("@langchain/pgvector");
const generative_ai_1 = require("@google/generative-ai");
const dotenv = __importStar(require("dotenv"));
const generative_ai_2 = require("@google/generative-ai");
dotenv.config();
const DEBUG_RAG = process.env.DEBUG_RAG === 'true';
const EMBEDDING_BATCH_SIZE = 15;
const EMBEDDING_BATCH_DELAY = 10_000;
const EMBEDDING_RETRY_DELAY = 65_000;
const EMBEDDING_MAX_RETRIES = 5;
const RETRIEVAL_FETCH_K = 12;
const MAX_SIBLINGS_PER_GROUP = 3;
const MAX_DESCENDANTS_PER_ITEM = 12;
const MIN_PARENT_CONTENT_LENGTH = 80;
const SLIDING_WINDOW_MIN_PARENT_LENGTH = 3500;
const SLIDING_WINDOW_BEFORE = 1200;
const SLIDING_WINDOW_AFTER = 2400;
const SLIDING_WINDOW_ANCHOR_SIZES = [50, 40, 30, 20];
const SENTENCE_SNAP_RANGE = 300;
const delay = (ms) => new Promise((res) => setTimeout(res, ms));
function chunkArray(arr, size) {
    const batches = [];
    for (let i = 0; i < arr.length; i += size)
        batches.push(arr.slice(i, i + size));
    return batches;
}
class NativeGeminiEmbeddings extends embeddings_1.Embeddings {
    model;
    constructor(apiKey) {
        super({});
        const genAI = new generative_ai_1.GoogleGenerativeAI(apiKey);
        this.model = genAI.getGenerativeModel({ model: 'gemini-embedding-2' });
    }
    async embedDocuments(texts) {
        const requests = texts.map((text) => ({
            content: { role: 'user', parts: [{ text }] },
        }));
        const response = await this.model.batchEmbedContents({ requests });
        return response.embeddings.map((e) => e.values);
    }
    async embedQuery(text) {
        const result = await this.model.embedContent(text);
        return result.embedding.values;
    }
}
function isStructuralHeading(line) {
    return (/^ANEXO\s+[A-Z0-9]/i.test(line) ||
        /^CAP[ÍI]TULO\s+[IVXLCDM]/i.test(line) ||
        /^Se[çc][ãa]o\s+[IVXLCDM]/i.test(line) ||
        /^Subse[çc][ãa]o\s+[IVXLCDM]/i.test(line) ||
        /^T[ÍI]TULO\s+[IVXLCDM]/i.test(line) ||
        /^LIVRO\s+[IVXLCDM]/i.test(line));
}
const RE_PDF_NOISE_ALLCAPS = [
    /^(MINISTÉRIO|SECRETARIA|DIRETORIA|DEPARTAMENTO|COORDENAÇÃO|SUBSECRETARIA|SUPERINTENDÊNCIA|GERENCIA|ASSESSORIA)\b/i,
    /^[A-Z]{2,5}$/,
    /^(I{1,3}|IV|VI{0,3}|IX|X{1,3}|XI{1,3}|XIV|XV)$/,
];
function isPdfNoiseAllCaps(line) {
    return RE_PDF_NOISE_ALLCAPS.some((re) => re.test(line.trim()));
}
function normalizeForSearch(text) {
    return text.replace(/\s+/g, ' ').trim();
}
function trace(...args) {
    if (DEBUG_RAG)
        console.log(...args);
}
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function findAnchorIndex(parentContent, childContent) {
    for (const size of SLIDING_WINDOW_ANCHOR_SIZES) {
        const anchor = childContent.slice(0, size).trim();
        if (anchor.length < 10)
            continue;
        const pattern = new RegExp(escapeRegExp(anchor).replace(/\s+/g, '\\s+'));
        const match = pattern.exec(parentContent);
        if (match)
            return match.index;
    }
    return -1;
}
function snapWindowStart(content, start) {
    if (start <= 0)
        return start;
    const from = Math.max(0, start - SENTENCE_SNAP_RANGE);
    const region = content.slice(from, start);
    const breakAt = Math.max(region.lastIndexOf('\n'), region.lastIndexOf('. '));
    if (breakAt === -1)
        return start;
    const isSentence = region.slice(breakAt, breakAt + 2) === '. ';
    return from + breakAt + (isSentence ? 2 : 1);
}
function snapWindowEnd(content, end) {
    if (end >= content.length)
        return end;
    const region = content.slice(end, Math.min(content.length, end + SENTENCE_SNAP_RANGE));
    const nl = region.indexOf('\n');
    const dot = region.indexOf('. ');
    const stops = [];
    if (nl !== -1)
        stops.push(nl);
    if (dot !== -1)
        stops.push(dot + 1);
    if (stops.length === 0)
        return end;
    return end + Math.min(...stops);
}
const PDF_LIGATURES = [
    [/ﬀ/g, 'ff'],
    [/ﬁ/g, 'fi'],
    [/ﬂ/g, 'fl'],
    [/ﬃ/g, 'ffi'],
    [/ﬄ/g, 'ffl'],
];
function stripInvisibleArtifacts(text) {
    let out = text
        .replace(/[\u00AD\u200B\u200C\u200D\uFEFF]/g, '')
        .replace(/\u00A0/g, ' ');
    for (const [re, expanded] of PDF_LIGATURES)
        out = out.replace(re, expanded);
    return out;
}
function dehyphenateAttested(text) {
    const words = new Set();
    for (const token of text.split(/[^\p{L}]+/u)) {
        if (token.length >= 4)
            words.add(token.toLowerCase());
    }
    return text.replace(/(\p{L}{2,})-\n(\p{Ll}{2,})/gu, (match, a, b) => words.has(`${a}${b}`.toLowerCase()) ? `${a}${b}` : match);
}
function cleanExtractedText(raw) {
    const preprocessed = dehyphenateAttested(stripInvisibleArtifacts(raw));
    return preprocessed
        .replace(/^\s*[-–]?\s*\d+\s*[-–]?\s*$/gm, '')
        .replace(/^\s*[Pp]ágina\s+\d+\s+de\s+\d+\s*$/gm, '')
        .replace(/^[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÇ\s\/\-\.]{5,80}$/gm, (match) => {
        const trimmed = match.trim();
        if (isStructuralHeading(trimmed))
            return match;
        if (/[a-záéíóúâêîôûãõç]/.test(match))
            return match;
        if (isPdfNoiseAllCaps(trimmed))
            return '';
        return match;
    })
        .replace(/[_\-\.]{4,}/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/^[ \t]+|[ \t]+$/gm, '')
        .trim();
}
function resolveFinishReason(response) {
    return (response?.finishReason ??
        response?.response_metadata?.finishReason ??
        response?.response_metadata?.finish_reason ??
        response?.generationInfo?.finishReason ??
        response?.generationInfo?.finish_reason ??
        'unknown');
}
function buildSourceLabel(doc, index) {
    const md = doc.metadata;
    const title = typeof md.title === 'string' && md.title
        ? md.title
        : 'Documento sem titulo';
    const n1 = typeof md.n1_header === 'string' ? md.n1_header : '';
    const n2 = typeof md.n2_header === 'string' ? md.n2_header : '';
    const section = typeof md.sectionHeader === 'string' ? md.sectionHeader : '';
    const parts = [`Documento: "${title}"`];
    if (n1)
        parts.push(n1);
    const item = n2 || (section !== n1 ? section : '');
    if (item)
        parts.push(/^art/i.test(item) ? item : `Item ${item}`);
    return `[Trecho ${index + 1}] ${parts.join(' | ')}`;
}
function buildChunkEmbedText(rawChild, ctx) {
    const parts = [];
    if (ctx.title?.trim())
        parts.push(ctx.title.trim());
    if (ctx.sectionHeading?.trim())
        parts.push(ctx.sectionHeading.trim());
    if (ctx.item?.trim())
        parts.push(`Item ${ctx.item.trim()}`);
    const header = parts.join(' — ');
    return header ? `${header}\n\n${rawChild}` : rawChild;
}
function buildRagPrompt(contexts, userQuery) {
    const isApoio = (doc) => doc.metadata.role === 'COMPLEMENTAR';
    const central = contexts.filter((d) => !isApoio(d));
    const apoio = contexts.filter(isApoio);
    let idx = 0;
    const render = (doc) => `${buildSourceLabel(doc, idx++)}\n${doc.pageContent}`;
    const centralBlock = central.map(render).join('\n\n---\n\n');
    const apoioBlock = apoio.map(render).join('\n\n---\n\n');
    const contextBlock = apoio.length
        ? `${centralBlock}\n\n=== MATERIAL DE APOIO (dispositivos correlatos trazidos pela expansao; NAO gere bloco proprio para estes — use so para referencia cruzada ou se indispensaveis) ===\n\n${apoioBlock}`
        : centralBlock;
    return `Voce e um assistente especializado em normas e documentos administrativos brasileiros. Quem pergunta e um servidor publico que precisa de uma resposta clara, correta e util para aplicar a norma no dia a dia.

Abaixo estao trechos de documentos normativos, cada um com uma anotacao interna de origem (documento, anexo, item). Os trechos estao ordenados por pertinencia — o primeiro e o mais diretamente relacionado a pergunta — e podem vir separados em dois niveis: DISPOSITIVOS CENTRAIS e MATERIAL DE APOIO (correlato), conforme a ESTRUTURA E FORMATO. Trechos consecutivos de um mesmo documento e anexo costumam ser partes (itens, subitens, alineas ou incisos) de um mesmo dispositivo; nesse caso formam uma sequencia continua, na ordem original da norma, e devem ser lidos em conjunto, pois juntos compoem a resposta completa. As anotacoes, os rotulos [Trecho N] e o mecanismo de selecao de trechos sao detalhes internos do sistema e nao fazem parte da resposta.

COMO RESPONDER:

1. RESPONDA A PERGUNTA, NAO DESCREVA O SISTEMA
   Comece respondendo diretamente o que foi perguntado, em linguagem natural, como um especialista que conhece a norma.
   Nunca abra a resposta comentando os documentos ou trechos ("Foram recuperados...", "Os dispositivos encontrados...", "O contexto contem...").
   Nunca use na resposta termos internos como "Fonte 1", "Trecho 2", "documento principal", "documento complementar", "contexto recuperado".

2. ESCOLHA O MODO PELO TIPO DE PERGUNTA
   a) Pergunta explicativa ("quais sao...", "como funciona...", "o que deve...", "quando..."):
      - responda de forma direta e organizada, sintetizando com fidelidade o que a norma determina;
      - quando a pergunta pedir um conjunto de elementos (rotinas, obrigacoes, requisitos, hipoteses, etapas, prazos ou documentos), primeiro selecione os dispositivos que compoem o processo perguntado (ver "PENSE EM PROCESSO") e entao enumere integralmente os itens de CADA dispositivo selecionado, sem reduzir a quantidade dentro dele — a completude vale dentro do que foi selecionado, nao sobre todo o contexto;
      - use topicos quando facilitarem a leitura;
      - preserve com exatidao numeros, prazos, valores, percentuais e obrigacoes; a numeracao e a origem do dispositivo vao entre parenteses no titulo do topico (ver ESTRUTURA E FORMATO);
      - transcreva literalmente apenas passagens curtas em que a redacao exata importa;
      - nao copie secoes inteiras da norma quando uma sintese fiel responde a pergunta.
   b) Pedido de transcricao ("transcreva...", "copie...", "reproduza...", "mostre na integra...", "texto exato..."):
      - reproduza o texto literalmente, completo e na ordem original;
      - mantenha a numeracao e a estrutura originais (itens, subitens, alineas, incisos);
      - nao resuma, nao reorganize, nao omita e nao acrescente nada.

3. PENSE EM PROCESSO, NAO EM DISPOSITIVOS (selecao — perguntas explicativas)
   A pergunta e sobre uma tarefa administrativa que alguem precisa executar, nao sobre o que existe no documento. Os trechos recuperados sao um universo de CANDIDATOS, reunidos por proximidade de assunto — nao um roteiro a reproduzir. Recuperar um trecho significa apenas que ele esta disponivel; cabe a voce decidir se ele e necessario para responder.
   Aplique este raciocinio quando a pergunta for sobre executar ou compreender uma atividade ou procedimento; perguntas pontuais (um prazo, um valor, uma definicao) respondem direto.
   Antes de escrever, reconstrua mentalmente o processo perguntado: qual atividade o usuario quer executar, em que escopo e cadencia, e quais sao as suas etapas naturais (o que precisa ser providenciado, executado e verificado, e o que antecede a conclusao). Use como etapas APENAS o que os trechos descrevem — nunca invente fases ou passos. O processo e uma LENTE para selecionar e ordenar; nunca uma fonte de fatos.
   Para cada dispositivo recuperado, decida nesta ordem:
   a) Responde diretamente ao que foi perguntado? -> inclua.
   b) Senao: e uma etapa indispensavel para executar exatamente o processo perguntado, ainda que trate de obrigacao de outra parte (contratada, gestor, fiscal tecnico...) ou de um documento/insumo sem o qual a atividade nao ocorre? -> inclua.
   c) Senao — apenas complementa o assunto, detalha outra modalidade da atividade (ex.: por amostragem), trata de outra fase, de excecoes, de diretrizes gerais ou de procedimentos acessorios? -> NAO entra automaticamente. So aparece se a pergunta pedir explicitamente esse aprofundamento, ou se a sua ausencia tornar impossivel compreender ou executar o processo.
   Omita em silencio o que ficar de fora: nao os cite, nao avise que existem, nao justifique exclusoes.

4. ESTRUTURA E FORMATO (perguntas explicativas)
   Depois de selecionar os dispositivos, NAO reorganize o conteudo livremente: a resposta segue obrigatoriamente esta estrutura.
   - So geram bloco os DISPOSITIVOS CENTRAIS que voce selecionar (regra PENSE EM PROCESSO). O que estiver sob "MATERIAL DE APOIO", e o que for correlato, de outra modalidade, diretriz geral ou excecao, NUNCA gera bloco proprio — serve so para referencia cruzada ou quando sua ausencia tornar a resposta impossivel. Estar no contexto nao obriga a virar bloco.
   - Introducao: um unico paragrafo curto resumindo o contexto. Ex: "As rotinas da fiscalizacao mensal previstas no Anexo VIII-B da IN 05/2017 compreendem as seguintes obrigacoes e verificacoes."
   - Depois, um topico para CADA dispositivo selecionado — exatamente um dispositivo por topico, neste formato:
       ## N. <Nome da atividade / finalidade do dispositivo> (Item X)
       <uma frase curta e natural introduzindo o topico; aqui SIM cabem tempo e condicao, ex.: "Ao final de cada periodo mensal, o fiscal administrativo devera:">
       • <acao 1>;
       • <acao 2>;
       • <acao 3>.
   - O TITULO nomeia a FINALIDADE do proprio dispositivo (ex.: "Verificacao de Dispendios e Emissao de Relatorio", "Documentacao Mensal da Contratada", "Diretrizes da Fiscalizacao Mensal"), com a referencia entre parenteses. Inclua ao menos o item; quando a resposta usar mais de um documento ou anexo, inclua-os: "(Item 2.1, Anexo VIII-B, IN 05/2017)".
   - PROIBIDO transformar dispositivos em fases do processo ou em categorias inventadas por voce. Nunca use como titulo "Antes do pagamento", "Para recebimento provisorio", "Durante a execucao", "Mensalmente", "Obrigacoes fiscais", "Outras verificacoes", "Fiscalizacao administrativa" e afins — sao interpretacoes suas. Tempo e condicao pertencem ao TEXTO do dispositivo (a frase introdutoria), nunca ao titulo. O titulo representa apenas o dispositivo selecionado.
   - UM DISPOSITIVO = UM BLOCO (regra inviolavel). A unidade de organizacao da resposta e o DISPOSITIVO, nunca o tema. Cada dispositivo selecionado gera exatamente um bloco independente, com titulo, frase introdutoria curta e lista de acoes (nunca tudo num unico paragrafo). E PROIBIDO: fundir dois dispositivos num mesmo bloco; incorporar um dispositivo como bullet ou complemento de outro; ocultar ou deduplicar um dispositivo porque trata do mesmo assunto; substituir um dispositivo por um resumo de outro. Se 9, 2.1 e 10.2 foram selecionados, existem obrigatoriamente TRES blocos distintos — a afinidade tematica nunca autoriza fusao.
   - Identidade do bloco: todo o conteudo de um bloco vem EXCLUSIVAMENTE do seu proprio dispositivo; nunca misture obrigacoes de dispositivos diferentes. Errado: descrever as certidoes que a contratada apresenta (Item 2.1) dentro do bloco do Item 10.2. Certo: o Item 2.1 tem o seu proprio bloco (## Documentacao mensal apresentada pela contratada (Item 2.1)).
   - Independencia: quando dois dispositivos tratam do mesmo assunto (ex.: certidoes), eles continuam sendo obrigacoes distintas e mantem blocos separados. So e permitida REFERENCIA CRUZADA, nunca fusao, deduplicacao, condensacao ou absorcao. Ex.: no bloco do Item 10.2 pode-se escrever "a documentacao correspondente e apresentada pela contratada conforme o Item 2.1" — mas o Item 2.1 mantem o seu proprio bloco.
   - Metadados NAO viram um bloco separado: nao escreva linhas "Documento:", "Anexo:", "Item:", "Descricao:" nem "Fonte:". A origem aparece somente no titulo, entre parenteses. Prefira texto natural ("A contratada devera entregar os seguintes documentos:") a rotulos secos.
   - Ordene os blocos pela sequencia LOGICA DO PROCESSO (a ordem em que o agente executa as etapas), e NAO pela ordem numerica dos itens nem pela ordem de recuperacao. Deduza a sequencia dos proprios dispositivos (marcos de tempo/condicao); onde a norma nao indicar ordem, nao invente.
   - Sintetize cada acao de forma curta, sem copiar o texto integral da norma e sem omitir requisitos, prazos ou condicoes (ver COBERTURA). Um rotulo em negrito no inicio do bullet e opcional.
   - Quando a resposta usar um unico dispositivo, gere UM unico bloco no mesmo padrao.

5. COBERTURA COMPLETA DOS DISPOSITIVOS SELECIONADOS
   A completude vale DENTRO de cada dispositivo que voce selecionou — nunca sobre todo o contexto recuperado. Selecionado um dispositivo, apresente-o por inteiro: todos os subitens, alineas, incisos, listas, obrigacoes, condicoes e excecoes que lhe pertencem. Sintetize a redacao de cada item se ajudar, mas nunca trunque, interrompa nem reduza a quantidade de itens de um dispositivo selecionado, nem omita requisitos, prazos ou condicoes; o fim da lista importa tanto quanto o inicio. Nao condense itens distintos em um so nem os substitua por uma descricao generica ("entre outras rotinas", "diversos procedimentos").
   Antes de finalizar, faca quatro conferencias:
   - Precisao: algum dispositivo entrou apenas por tratar do mesmo tema, sem ocupar uma etapa necessaria do processo? Remova-o.
   - Recall: alguma etapa indispensavel do processo aparece no contexto recuperado mas ficou de fora? Inclua-a.
   - Cobertura: cada dispositivo selecionado foi apresentado integralmente, sem subitem pertinente omitido?
   - Contagem: conte APENAS os dispositivos que voce selecionou como centrais — material de apoio, correlatos, outra modalidade, diretrizes gerais e excecoes NAO contam e NAO viram bloco. O numero de blocos deve COINCIDIR com esse total de selecionados. Se um selecionado foi fundido ou absorvido em outro bloco, separe-o num bloco proprio; se um dispositivo NAO selecionado virou bloco, remova-o. Selecionar continua sendo tarefa da regra PENSE EM PROCESSO — estar no contexto nunca obriga a incluir.

6. FIDELIDADE AO TEXTO NORMATIVO
   Use somente o conteudo dos trechos fornecidos; nao use conhecimento externo.
   O processo que voce reconstroi serve para selecionar e ordenar — nao e fonte de fatos. Etapas, sequencia e vinculos entre dispositivos so podem ser afirmados na medida em que os trechos os sustentam; nao invente ligacoes, causas ou passos que a norma nao declara.
   Nao invente dispositivos, numeros ou continuacoes de texto. Se um trecho contiver o marcador [...], ha texto omitido nesse ponto — nunca o complete.
   Se um dispositivo mencionado nos trechos remeter a um subitem, alinea ou inciso cujo texto NAO esta presente, registre a ausencia em uma nota curta entre parenteses (ex: "(a alinea 'b.1' e referida, mas seu texto nao consta dos trechos disponiveis)") — nunca invente o conteudo ausente nem descarte a referencia em silencio.
   Nao faca interpretacao juridica, recomendacao ou opiniao alem do que a norma diz.
   Se os trechos nao contiverem a informacao perguntada, responda EXATAMENTE:
   "As informacoes disponiveis nao sao suficientes."

7. CITACAO DA FONTE
   A origem de cada dispositivo aparece entre parenteses no TITULO do seu topico (ex.: "(Item 10.2)" ou "(Item 2.1, Anexo VIII-B, IN 05/2017)"), a partir da anotacao de origem do trecho, sem inventar dados que nao estejam la. Nao crie bloco de metadados nem "Fonte:" ao final, e nao interrompa o texto com citacoes inline. Nunca use rotulos internos do sistema (nunca escreva "Trecho N", "Fonte N", "PRINCIPAL" ou "COMPLEMENTAR"). Cite apenas dispositivos efetivamente usados e reproduza exatamente a numeracao que aparece nos trechos.

--- TRECHOS DOS DOCUMENTOS (uso interno) ---
${contextBlock}
--- FIM DOS TRECHOS ---

Pergunta: ${userQuery}

Resposta:`;
}
let RagService = RagService_1 = class RagService {
    prisma;
    logger = new common_1.Logger(RagService_1.name);
    vectorStore;
    llm;
    embeddings;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async onModuleInit() {
        const apiKey = process.env.GOOGLE_API_KEY;
        if (!apiKey) {
            this.logger.error('Variavel GOOGLE_API_KEY nao encontrada no .env');
            return;
        }
        this.embeddings = new NativeGeminiEmbeddings(apiKey);
        this.llm = new google_genai_1.ChatGoogleGenerativeAI({
            apiKey,
            model: 'gemini-2.5-flash',
            temperature: 0.1,
            maxOutputTokens: 8192,
            thinkingConfig: { thinkingBudget: 2048 },
            safetySettings: [
                {
                    category: generative_ai_2.HarmCategory.HARM_CATEGORY_HARASSMENT,
                    threshold: generative_ai_2.HarmBlockThreshold.BLOCK_NONE,
                },
                {
                    category: generative_ai_2.HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                    threshold: generative_ai_2.HarmBlockThreshold.BLOCK_NONE,
                },
                {
                    category: generative_ai_2.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                    threshold: generative_ai_2.HarmBlockThreshold.BLOCK_NONE,
                },
                {
                    category: generative_ai_2.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                    threshold: generative_ai_2.HarmBlockThreshold.BLOCK_NONE,
                },
            ],
        });
        this.vectorStore = await pgvector_1.PGVectorStore.initialize(this.embeddings, {
            postgresConnectionOptions: {
                type: 'postgres',
                connectionString: process.env.DATABASE_URL,
            },
            tableName: 'documentos_vetorizados',
            columns: {
                idColumnName: 'id',
                vectorColumnName: 'embedding',
                contentColumnName: 'text',
                metadataColumnName: 'metadata',
            },
        });
        this.logger.log('RAG Service inicializado (Gemini 2.5 + pgvector + PDR persistido)');
    }
    async indexDocument(rawContent, documentId, title) {
        const cleanedText = cleanExtractedText(rawContent);
        const chunks = (0, legal_document_splitter_1.splitLegalDocument)(cleanedText);
        let totalChildren = 0;
        const groupMap = new Map();
        for (const chunk of chunks) {
            const { n1_header, n2_header } = chunk.metadata;
            const key = `${n1_header}|||${n2_header}`;
            if (!groupMap.has(key)) {
                groupMap.set(key, {
                    n1_header,
                    n2_header,
                    sectionHeader: (n2_header || n1_header || 'Secao').slice(0, 255),
                    contentParts: [],
                });
            }
            groupMap.get(key).contentParts.push(chunk.content);
        }
        const sectionHeadingByN1 = new Map();
        for (const entry of groupMap.values()) {
            if (entry.n2_header === '' &&
                entry.n1_header &&
                !sectionHeadingByN1.has(entry.n1_header)) {
                const preamble = entry.contentParts
                    .join(' ')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 200);
                if (preamble)
                    sectionHeadingByN1.set(entry.n1_header, preamble);
            }
        }
        const allChildDocs = [];
        for (const entry of groupMap.values()) {
            const fullContent = entry.contentParts.join('\n');
            const savedParent = await this.prisma.parentChunk.create({
                data: {
                    document_id: documentId,
                    section_header: entry.sectionHeader,
                    content: fullContent,
                    metadata: {
                        documentId,
                        title,
                        n1_header: entry.n1_header,
                        n2_header: entry.n2_header,
                    },
                },
            });
            const childContents = fullContent.length > legal_document_splitter_1.CHILD_CHUNK_SIZE
                ? (0, legal_document_splitter_1.splitIntoChildChunks)(fullContent)
                : [fullContent];
            for (const childContent of childContents) {
                allChildDocs.push(new documents_1.Document({
                    pageContent: childContent,
                    metadata: {
                        documentId,
                        title,
                        parentId: savedParent.id,
                        n1_header: entry.n1_header,
                        n2_header: entry.n2_header,
                    },
                }));
            }
        }
        const batches = chunkArray(allChildDocs, EMBEDDING_BATCH_SIZE);
        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            this.logger.log(`[RAG] Vetorizando lote ${i + 1}/${batches.length} (${batch.length} chunks)...`);
            let attempt = 0;
            while (attempt < EMBEDDING_MAX_RETRIES) {
                try {
                    const embedTexts = batch.map((doc) => {
                        const md = doc.metadata;
                        const heading = sectionHeadingByN1.get(md.n1_header) ?? md.n1_header;
                        return buildChunkEmbedText(doc.pageContent, {
                            title: md.title,
                            sectionHeading: heading,
                            item: md.n2_header,
                        });
                    });
                    const vectors = await this.embeddings.embedDocuments(embedTexts);
                    await this.vectorStore.addVectors(vectors, batch);
                    totalChildren += batch.length;
                    break;
                }
                catch (err) {
                    const is429 = err?.status === 429 ||
                        String(err?.message).includes('429') ||
                        String(err?.message).toLowerCase().includes('quota');
                    if (is429 && attempt < EMBEDDING_MAX_RETRIES - 1) {
                        this.logger.warn(`[RAG] Rate limit (429) no lote ${i + 1}. Aguardando ${EMBEDDING_RETRY_DELAY / 1000}s...`);
                        await delay(EMBEDDING_RETRY_DELAY);
                        attempt++;
                    }
                    else {
                        throw err;
                    }
                }
            }
            if (i < batches.length - 1)
                await delay(EMBEDDING_BATCH_DELAY);
        }
        this.logger.log(`Indexado: "${title}" — ${groupMap.size} parents consolidados, ${totalChildren} child chunks vetorizados`);
        return {
            success: true,
            documentId,
            sections: groupMap.size,
            childChunks: totalChildren,
        };
    }
    async retrieveParentContexts(userQuery, k = RETRIEVAL_FETCH_K) {
        const queryVec = await this.embeddings.embedQuery(userQuery);
        trace('\n[TRACE 1] userQuery:', userQuery);
        trace(`[TRACE 1] embedding: dim=${queryVec.length} | primeiros valores=[${queryVec
            .slice(0, 5)
            .map((v) => v.toFixed(6))
            .join(', ')}]`);
        let filter = undefined;
        const anexoMatch = userQuery.match(/(?:Anexo)\s+([IVXLCDM]+(?:-[A-Z])?)/i);
        if (anexoMatch) {
            filter = { n1_header: anexoMatch[0].toUpperCase() };
        }
        trace('[TRACE 2] filter enviado para similaritySearchVectorWithScore:', JSON.stringify(filter ?? null));
        let childResults = await this.vectorStore.similaritySearchVectorWithScore(queryVec, k, filter);
        if (filter && childResults.length === 0) {
            trace('[TRACE 2b] Busca filtrada sem resultados — refazendo sem filtro');
            childResults = await this.vectorStore.similaritySearchVectorWithScore(queryVec, k);
        }
        if (DEBUG_RAG) {
            trace(`\n[TRACE 3] ${childResults.length} child chunk(s) retornados:`);
            childResults.forEach(([child, score], i) => {
                trace(`  [${i + 1}] score=${score.toFixed(6)}` +
                    ` | n1="${child.metadata.n1_header ?? ''}"` +
                    ` | n2="${child.metadata.n2_header ?? ''}"` +
                    ` | parentId=${child.metadata.parentId}` +
                    ` | preview="${child.pageContent.slice(0, 120).replace(/\n/g, ' ')}"`);
            });
        }
        const parentIds = new Set();
        const orderedParentIds = [];
        const scoreByParentId = new Map();
        for (const [child, score] of childResults) {
            const parentId = child.metadata.parentId;
            if (parentId && !parentIds.has(parentId)) {
                parentIds.add(parentId);
                orderedParentIds.push(parentId);
            }
            if (parentId) {
                const prev = scoreByParentId.get(parentId);
                if (prev === undefined || score < prev)
                    scoreByParentId.set(parentId, score);
            }
        }
        if (DEBUG_RAG) {
            trace('\n[TRACE 4] Ordem de insercao dos parentIds no Set:');
            orderedParentIds.forEach((pid, i) => trace(`  ${i + 1} -> ${pid}`));
        }
        const parentRows = await this.prisma.parentChunk.findMany({
            where: { id: { in: orderedParentIds } },
        });
        const parentMap = new Map(parentRows.map((row) => [row.id, row]));
        let orderedParentRows = orderedParentIds
            .map((id) => parentMap.get(id))
            .filter((row) => row && row.content.length >= MIN_PARENT_CONTENT_LENGTH);
        const siblingExpansionGroups = new Map();
        for (const row of orderedParentRows) {
            const n2Header = (0, hierarchical_context_1.getN2Header)(row);
            const prefixInfo = (0, hierarchical_context_1.deriveSiblingPrefix)(n2Header);
            if (!prefixInfo)
                continue;
            const parsedN2 = (0, legal_document_splitter_1.parseItemNumber)(n2Header);
            const lastNumber = parsedN2.numbers[parsedN2.numbers.length - 1];
            const groupKey = `${row.document_id}|||${(0, hierarchical_context_1.getN1Header)(row)}|||${prefixInfo.parentPrefix}|||${prefixInfo.level}`;
            const score = scoreByParentId.get(row.id) ?? Infinity;
            const existingGroup = siblingExpansionGroups.get(groupKey);
            if (!existingGroup) {
                siblingExpansionGroups.set(groupKey, {
                    documentId: row.document_id,
                    n1Header: (0, hierarchical_context_1.getN1Header)(row),
                    parentPrefix: prefixInfo.parentPrefix,
                    parentNumbers: prefixInfo.parentNumbers,
                    level: prefixInfo.level,
                    bestScore: score,
                    retrievedIds: new Set([row.id]),
                    retrievedLastNumbers: [lastNumber],
                });
            }
            else {
                existingGroup.retrievedIds.add(row.id);
                existingGroup.bestScore = Math.min(existingGroup.bestScore, score);
                existingGroup.retrievedLastNumbers.push(lastNumber);
            }
        }
        const siblingParents = [];
        if (siblingExpansionGroups.size > 0) {
            for (const group of siblingExpansionGroups.values()) {
                const candidates = await this.prisma.parentChunk.findMany({
                    where: {
                        document_id: group.documentId,
                        metadata: { path: ['n1_header'], equals: group.n1Header },
                        section_header: { startsWith: group.parentPrefix },
                    },
                });
                const validCandidates = [];
                for (const candidate of candidates) {
                    if (group.retrievedIds.has(candidate.id))
                        continue;
                    if (candidate.content.length < MIN_PARENT_CONTENT_LENGTH)
                        continue;
                    const candidateHeader = (0, hierarchical_context_1.getN2Header)(candidate);
                    const parsedCandidate = (0, legal_document_splitter_1.parseItemNumber)(candidateHeader);
                    if (!parsedCandidate || parsedCandidate.level !== group.level)
                        continue;
                    if (!group.parentNumbers.every((value, idx) => parsedCandidate.numbers[idx] === value))
                        continue;
                    const candidateLast = parsedCandidate.numbers[parsedCandidate.numbers.length - 1];
                    const distance = Math.min(...group.retrievedLastNumbers.map((n) => Math.abs(candidateLast - n)));
                    validCandidates.push({ row: candidate, distance });
                }
                validCandidates.sort((a, b) => a.distance - b.distance);
                for (const { row } of validCandidates.slice(0, MAX_SIBLINGS_PER_GROUP)) {
                    siblingParents.push(row);
                    scoreByParentId.set(row.id, group.bestScore);
                }
            }
        }
        const descendantParents = [];
        const alreadySelectedIds = new Set([
            ...orderedParentRows.map((row) => row.id),
            ...siblingParents.map((row) => row.id),
        ]);
        for (const row of orderedParentRows) {
            const parsedSelf = (0, legal_document_splitter_1.parseItemNumber)((0, hierarchical_context_1.getN2Header)(row));
            if (!parsedSelf)
                continue;
            const childPrefix = `${parsedSelf.numbers.join('.')}.`;
            const childLevel = parsedSelf.level + 1;
            const children = await this.prisma.parentChunk.findMany({
                where: {
                    document_id: row.document_id,
                    metadata: { path: ['n1_header'], equals: (0, hierarchical_context_1.getN1Header)(row) },
                    section_header: { startsWith: childPrefix },
                },
            });
            const directChildren = [];
            for (const child of children) {
                if (alreadySelectedIds.has(child.id))
                    continue;
                if (child.content.length < MIN_PARENT_CONTENT_LENGTH)
                    continue;
                const parsedChild = (0, legal_document_splitter_1.parseItemNumber)((0, hierarchical_context_1.getN2Header)(child));
                if (!parsedChild || parsedChild.level !== childLevel)
                    continue;
                if (!parsedSelf.numbers.every((value, idx) => parsedChild.numbers[idx] === value))
                    continue;
                directChildren.push(child);
            }
            const inheritedScore = scoreByParentId.get(row.id) ?? Infinity;
            for (const child of (0, hierarchical_context_1.sortParentsByStructuralOrder)(directChildren).slice(0, MAX_DESCENDANTS_PER_ITEM)) {
                descendantParents.push(child);
                alreadySelectedIds.add(child.id);
                scoreByParentId.set(child.id, inheritedScore);
            }
        }
        if (siblingParents.length > 0 || descendantParents.length > 0) {
            const parentsByGroup = new Map();
            const groupOrder = [];
            const appendParent = (parent) => {
                const key = `${parent.document_id}|||${(0, hierarchical_context_1.getN1Header)(parent)}`;
                if (!parentsByGroup.has(key)) {
                    parentsByGroup.set(key, []);
                    groupOrder.push(key);
                }
                const groupRows = parentsByGroup.get(key);
                if (!groupRows.some((row) => row.id === parent.id)) {
                    groupRows.push(parent);
                }
            };
            orderedParentRows.forEach(appendParent);
            siblingParents.forEach(appendParent);
            descendantParents.forEach(appendParent);
            orderedParentRows = groupOrder.flatMap((key) => (0, hierarchical_context_1.sortParentsByStructuralOrder)(parentsByGroup.get(key)));
        }
        const retrievedScopeHits = new Map();
        for (const id of orderedParentIds) {
            const row = parentMap.get(id);
            if (!row || row.content.length < MIN_PARENT_CONTENT_LENGTH)
                continue;
            const scopeKey = `${row.document_id}|||${(0, hierarchical_context_1.getN1Header)(row)}`;
            retrievedScopeHits.set(scopeKey, (retrievedScopeHits.get(scopeKey) ?? 0) + 1);
        }
        const beforePrune = orderedParentRows.length;
        orderedParentRows = (0, hierarchical_context_1.pruneForeignAnexoContamination)(orderedParentRows, retrievedScopeHits);
        if (DEBUG_RAG && orderedParentRows.length !== beforePrune) {
            trace(`[COERENCIA] Removidos ${beforePrune - orderedParentRows.length} parent(s) de anexo estranho ao processo dominante`);
        }
        const clusters = (0, hierarchical_context_1.buildClusters)(orderedParentRows, scoreByParentId);
        const boostedClusters = (0, hierarchical_context_1.applyHierarchicalBoost)(clusters);
        const boostedParents = (0, hierarchical_context_1.flattenClusters)(boostedClusters);
        const parentsToUse = boostedParents.length
            ? boostedParents
            : orderedParentRows;
        const provenanceById = new Map();
        const addProvenance = (id, p) => {
            const set = provenanceById.get(id) ?? new Set();
            set.add(p);
            provenanceById.set(id, set);
        };
        for (const id of orderedParentIds)
            addProvenance(id, 'HIT');
        for (const row of descendantParents)
            addProvenance(row.id, 'DESCENDANT');
        for (const row of siblingParents)
            addProvenance(row.id, 'SIBLING');
        const ranked = (0, hierarchical_context_1.rankByProvenance)(parentsToUse, provenanceById);
        const orderedForPrompt = ranked.map((r) => r.row);
        const roleById = new Map(ranked.map((r) => [r.row.id, r.role]));
        if (DEBUG_RAG) {
            trace('\n[PROVENIENCIA] classificacao por origem no conjunto candidato:');
            ranked.forEach((r) => trace(`  ${r.role.padEnd(11)} | origem=[${r.provenance.join(',') || 'desconhecida'}]` +
                ` | section="${r.row.section_header}" | parentId=${r.row.id}`));
        }
        if (DEBUG_RAG) {
            trace('\n[TRACE 5] Ordem retornada pelo Prisma (parentChunk.findMany):');
            parentRows.forEach((row, i) => trace(`  [${i + 1}] id=${row.id} | section="${row.section_header}" | chars=${row.content.length}`));
            const prismaPreservedOrder = orderedParentIds.every((pid, i) => parentRows[i]?.id === pid);
            trace(`[TRACE 5] O Prisma preservou a ordem dos parentIds? ${prismaPreservedOrder ? 'SIM' : 'NAO'}`);
            trace('  (esperado):', orderedParentIds.join(' -> '));
            trace('  (recebido):', parentRows.map((r) => r.id).join(' -> '));
        }
        const triggeringChildByParentId = new Map();
        for (const [child] of childResults) {
            const pid = child.metadata.parentId;
            if (pid && !triggeringChildByParentId.has(pid))
                triggeringChildByParentId.set(pid, child);
        }
        const parents = orderedForPrompt.map((row) => {
            const triggeringChild = triggeringChildByParentId.get(row.id);
            let pageContent = row.content;
            if (triggeringChild &&
                row.content.length > SLIDING_WINDOW_MIN_PARENT_LENGTH) {
                const startIndex = findAnchorIndex(row.content, triggeringChild.pageContent);
                if (startIndex !== -1) {
                    let windowStart = Math.max(0, startIndex - SLIDING_WINDOW_BEFORE);
                    let windowEnd = Math.min(row.content.length, startIndex +
                        triggeringChild.pageContent.length +
                        SLIDING_WINDOW_AFTER);
                    windowStart = snapWindowStart(row.content, windowStart);
                    windowEnd = snapWindowEnd(row.content, windowEnd);
                    const slice = row.content.substring(windowStart, windowEnd);
                    const prefix = windowStart > 0 ? '[...] ' : '';
                    const suffix = windowEnd < row.content.length ? ' [...]' : '';
                    pageContent = `${prefix}${slice}${suffix}`;
                }
            }
            return new documents_1.Document({
                pageContent,
                metadata: {
                    documentId: row.document_id,
                    title: row.metadata?.title ?? '',
                    n1_header: row.metadata?.n1_header ?? '',
                    n2_header: row.metadata?.n2_header ?? '',
                    sectionHeader: row.section_header,
                    parentId: row.id,
                    role: roleById.get(row.id) ?? 'PRINCIPAL',
                },
            });
        });
        if (DEBUG_RAG) {
            trace('\n[TRACE 6] Ordem final dos ParentChunks enviados ao LLM:');
            parents.forEach((doc, i) => trace(`  [Fonte ${i + 1}${doc.metadata.role ? ` — ${doc.metadata.role}` : ''}] parentId=${doc.metadata.parentId} | section="${doc.metadata.sectionHeader}" | chars=${doc.pageContent.length}`));
        }
        const sourceDocIds = Array.from(new Set(parents
            .map((doc) => doc.metadata.documentId)
            .filter((id) => Boolean(id))));
        return { parents, sourceDocIds };
    }
    async query(userQuery, conversationId) {
        const { parents, sourceDocIds } = await this.retrieveParentContexts(userQuery);
        const prompt = buildRagPrompt(parents, userQuery);
        let aiResponse = '';
        let llmFailed = false;
        let truncated = false;
        try {
            const response = await this.llm.invoke(prompt);
            if (typeof response.content === 'string') {
                aiResponse = response.content;
            }
            else if (Array.isArray(response.content) &&
                response.content.length > 0) {
                const textPart = response.content.find((p) => p.type === 'text');
                aiResponse =
                    textPart && 'text' in textPart ? textPart.text : '';
            }
            const finishReason = resolveFinishReason(response);
            if (finishReason === 'MAX_TOKENS') {
                truncated = true;
                this.logger.error('[LLM] Resposta truncada por limite de tokens (MAX_TOKENS) — saida possivelmente incompleta.');
            }
            else if (finishReason && finishReason !== 'STOP') {
                this.logger.warn(`[LLM] finishReason inesperado: ${finishReason}`);
            }
        }
        catch (err) {
            llmFailed = true;
            this.logger.error(`[LLM] Falha em llm.invoke — status=${err?.status ?? err?.code ?? 'n/a'} | message=${err?.message ?? String(err)}`);
        }
        if (llmFailed) {
            aiResponse =
                'Nao foi possivel gerar a resposta neste momento devido a uma falha tecnica na comunicacao com o modelo. Tente novamente em alguns instantes.';
        }
        else if (!aiResponse.trim()) {
            aiResponse =
                'As informacoes disponiveis nos documentos indexados nao sao suficientes para responder a esta pergunta com precisao.';
        }
        else if (truncated) {
            aiResponse +=
                '\n\n(Observacao do sistema: esta resposta pode ter sido interrompida por limite de tamanho e talvez nao cubra todos os itens. Refaca a pergunta de forma mais especifica para obter o restante.)';
        }
        const sourcesMap = new Map();
        for (const parent of parents) {
            const id = parent.metadata.documentId;
            const title = parent.metadata.title;
            if (id && !sourcesMap.has(id))
                sourcesMap.set(id, { id, title });
        }
        const sources = Array.from(sourcesMap.values());
        const saved = await this.prisma.interactionHistory.create({
            data: {
                conversation_id: conversationId,
                user_query: userQuery,
                ai_response: aiResponse,
                responseSources: {
                    create: sourceDocIds.map((id) => ({
                        normative: { connect: { id } },
                    })),
                },
            },
        });
        return {
            id: saved.id,
            created_at: saved.created_at,
            response: aiResponse,
            sources,
        };
    }
};
exports.RagService = RagService;
exports.RagService = RagService = RagService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], RagService);
//# sourceMappingURL=rag.service.js.map