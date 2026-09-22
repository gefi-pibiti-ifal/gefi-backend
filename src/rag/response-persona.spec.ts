import { Document } from '@langchain/core/documents';
import { buildRagPrompt } from './rag.service';
import {
  DEFAULT_PERSONA,
  DEFAULT_PERSONA_ID,
  RESPONSE_PERSONAS,
  isKnownPersona,
  listPersonas,
  resolveEffectivePersona,
  resolvePersona,
  type ResponsePersona,
} from './response-persona';

const personas = Object.values(RESPONSE_PERSONAS);

const contexts = [
  new Document({
    pageContent: 'Ao final de cada periodo mensal, o fiscal verificara a regularidade.',
    metadata: {
      title: 'IN 05/2017',
      n1_header: 'ANEXO VIII-B',
      n2_header: '10.2.',
      sectionHeader: '10.2.',
      role: 'PRINCIPAL',
    },
  }),
];

const promptFor = (persona: ResponsePersona) =>
  buildRagPrompt(contexts, 'Qual a rotina mensal?', persona);

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------
describe('catalogo de personalidades', () => {
  test('a padrao e INSTITUCIONAL — o comportamento que ja estava em producao', () => {
    expect(DEFAULT_PERSONA_ID).toBe('INSTITUCIONAL');
    expect(DEFAULT_PERSONA.id).toBe('INSTITUCIONAL');
  });

  test('toda personalidade tem os textos que a interface precisa', () => {
    for (const persona of personas) {
      expect(persona.label).toBeTruthy();
      expect(persona.description).toBeTruthy();
      expect(persona.sample).toBeTruthy();
      expect(persona.register.trim()).toBeTruthy();
      expect(persona.opening.trim()).toBeTruthy();
      expect(persona.procedural.trim()).toBeTruthy();
      expect(persona.finalCheck.trim()).toBeTruthy();
    }
  });

  test('o catalogo marca exatamente uma opcao como padrao', () => {
    const catalog = listPersonas();
    expect(catalog).toHaveLength(personas.length);
    expect(catalog.filter((p) => p.is_default)).toHaveLength(1);
    expect(catalog.find((p) => p.is_default)!.id).toBe(DEFAULT_PERSONA_ID);
  });

  test('os exemplos da interface sao distintos entre si', () => {
    const samples = new Set(personas.map((p) => p.sample));
    expect(samples.size).toBe(personas.length);
  });
});

describe('resolvePersona — leitura tolerante', () => {
  test.each(['INSTITUCIONAL', 'CORDIAL'])('aceita o id %s', (id) => {
    expect(resolvePersona(id).id).toBe(id);
  });

  test('aceita variacao de caixa e espaco (entrada de cliente)', () => {
    expect(resolvePersona(' cordial ').id).toBe('CORDIAL');
  });

  test.each([null, undefined, '', 'ENGRACADO', 42, {}])(
    'valor invalido (%p) cai no padrao em vez de falhar',
    (value) => {
      expect(resolvePersona(value).id).toBe(DEFAULT_PERSONA_ID);
    },
  );

  test('isKnownPersona separa o que pode ser GRAVADO do que e apenas lido', () => {
    expect(isKnownPersona('CORDIAL')).toBe(true);
    expect(isKnownPersona('cordial')).toBe(true);
    expect(isKnownPersona('ENGRACADO')).toBe(false);
    expect(isKnownPersona(null)).toBe(false);
  });
});

describe('resolveEffectivePersona — precedencia', () => {
  test('a pergunta vence a conversa e a preferencia', () => {
    expect(
      resolveEffectivePersona({
        request: 'CORDIAL',
        conversation: 'INSTITUCIONAL',
        user: 'INSTITUCIONAL',
      }).id,
    ).toBe('CORDIAL');
  });

  test('sem pedido na pergunta, vale o que a conversa fixou', () => {
    expect(
      resolveEffectivePersona({ conversation: 'CORDIAL', user: 'INSTITUCIONAL' }).id,
    ).toBe('CORDIAL');
  });

  test('sem conversa fixada, vale a preferencia do usuario', () => {
    expect(resolveEffectivePersona({ user: 'CORDIAL' }).id).toBe('CORDIAL');
  });

  test('nada escolhido em lugar nenhum: padrao do sistema', () => {
    expect(resolveEffectivePersona({}).id).toBe(DEFAULT_PERSONA_ID);
    expect(
      resolveEffectivePersona({ request: null, conversation: null, user: null }).id,
    ).toBe(DEFAULT_PERSONA_ID);
  });

  test('um nivel invalido e ignorado e o proximo assume', () => {
    // Cliente desatualizado mandando lixo nao pode apagar a escolha da conversa.
    expect(
      resolveEffectivePersona({ request: 'ENGRACADO', conversation: 'CORDIAL' }).id,
    ).toBe('CORDIAL');
  });
});

// ---------------------------------------------------------------------------
// A INVARIANTE: personalidade muda o tom, nunca o conteudo.
// ---------------------------------------------------------------------------
describe('personalidade nao altera o que a resposta diz', () => {
  test('o prompt so difere no bloco de registro e na linha de conferencia', () => {
    const institucional = promptFor(RESPONSE_PERSONAS.INSTITUCIONAL);
    const cordial = promptFor(RESPONSE_PERSONAS.CORDIAL);

    // Removendo o que cada persona contribui, os dois prompts sao IDENTICOS.
    const strip = (prompt: string, persona: ResponsePersona) =>
      prompt
        .replace(persona.register, '<REGISTRO>')
        .replace(persona.opening, '<ABERTURA>')
        .replace(persona.procedural, '<PROCEDIMENTAL>')
        .replace(persona.finalCheck, '<CHECK>');

    expect(strip(institucional, RESPONSE_PERSONAS.INSTITUCIONAL)).toBe(
      strip(cordial, RESPONSE_PERSONAS.CORDIAL),
    );
  });

  test.each(personas)('$id preserva a estrutura da resposta', (persona) => {
    const prompt = promptFor(persona);

    // Abertura tipada e modos
    expect(prompt).toContain('A RESPOSTA E ORGANIZADA PELA PERGUNTA, NUNCA PELA NORMA');
    expect(prompt).toContain('IDENTIFIQUE O TIPO DE RESPOSTA QUE A PERGUNTA PEDE');
    expect(prompt).toContain('ESTRUTURA DA RESPOSTA PONTUAL');
    // a abertura interativa existe nas duas, com o mesmo teto e o mesmo teste
    expect(prompt).toContain('a) LINHA DE ENTRADA');
    expect(prompt).toContain('b) A RESPOSTA');
    expect(prompt).toContain('TRES TESTES, aplicados sempre');
    expect(prompt).toContain('ESTRUTURA E FORMATO (modo procedimental)');
    // Citacao e fundamentacao
    expect(prompt).toContain('## Fundamentacao');
    expect(prompt).toContain('**Item X – Anexo Y – Documento Z**');
    // Cobertura e fidelidade
    expect(prompt).toContain('COBRIR NAO E TRANSCREVER');
    expect(prompt).toContain('FIDELIDADE AO TEXTO NORMATIVO');
    expect(prompt).toContain('"As informacoes disponiveis nao sao suficientes."');
  });

  test.each(personas)('$id mantem a regra de redacao propria (nao copiar)', (persona) => {
    const prompt = promptFor(persona);
    expect(prompt).toContain('A RESPOSTA E ESCRITA POR VOCE, NAO COPIADA DA NORMA');
    expect(prompt).toContain('ERRADO (colagem)');
    expect(prompt).toContain('CERTO (sintese fiel)');
  });

  test.each(personas)('$id nao afrouxa o grounding', (persona) => {
    const prompt = promptFor(persona);
    expect(prompt).toContain('Use somente o conteudo dos trechos fornecidos');
    expect(prompt).toContain('Nao opine, nao recomende e nao avalie o caso do usuario');
    expect(prompt).toContain('em caso de duvida entre soar melhor e ser fiel, escolha SEMPRE ser fiel');
  });

  test.each(personas)('$id recebe o mesmo contexto recuperado', (persona) => {
    const prompt = promptFor(persona);
    expect(prompt).toContain('Ao final de cada periodo mensal, o fiscal verificara a regularidade.');
    expect(prompt).toContain('Qual a rotina mensal?');
  });
});

// ---------------------------------------------------------------------------
// O que de fato muda
// ---------------------------------------------------------------------------
describe('o que cada personalidade muda', () => {
  test('INSTITUCIONAL proibe a segunda pessoa', () => {
    const prompt = promptFor(RESPONSE_PERSONAS.INSTITUCIONAL);
    expect(prompt).toContain('NAO se dirija ao leitor na segunda pessoa');
    expect(prompt).toContain('Registro INSTITUCIONAL e impessoal');
    expect(prompt).not.toContain('Pode falar com o leitor na segunda pessoa');
  });

  test('CORDIAL libera a segunda pessoa com moderacao', () => {
    const prompt = promptFor(RESPONSE_PERSONAS.CORDIAL);
    expect(prompt).toContain('Registro CORDIAL e profissional');
    expect(prompt).toContain('Pode falar com o leitor na segunda pessoa');
    expect(prompt).toContain('uma ou duas vezes na resposta inteira');
    expect(prompt).not.toContain('NAO se dirija ao leitor na segunda pessoa');
  });

  test('CORDIAL pode explicar o porque — mas so o que os trechos sustentam', () => {
    const prompt = promptFor(RESPONSE_PERSONAS.CORDIAL);
    expect(prompt).toContain('explique o PORQUE quando ele ajudar a aplicar a regra');
    expect(prompt).toContain('inventar o porque e mais grave do que omiti-lo');
    expect(prompt).toContain('Nunca antecipe o que os trechos nao respondem');
  });

  test('CORDIAL continua barrando o que costuma vir junto com "tom amigavel"', () => {
    const prompt = promptFor(RESPONSE_PERSONAS.CORDIAL);
    expect(prompt).toContain('Espero ter ajudado');
    expect(prompt).toContain('emoji');
    expect(prompt).toContain('ponto de exclamacao');
    expect(prompt).toContain('Otima pergunta');
  });

  test('INSTITUCIONAL abre de forma sobria, sem falar com o leitor', () => {
    const prompt = promptFor(RESPONSE_PERSONAS.INSTITUCIONAL);
    expect(prompt).toContain('Linha de entrada no registro INSTITUCIONAL');
    expect(prompt).toContain('O que decide aqui e o valor da contratacao.');
    expect(prompt).toContain('Vamos analisar o que diz a norma.'); // como exemplo do que NAO fazer
    expect(prompt).not.toContain('Linha de entrada no registro CORDIAL');
  });

  test('CORDIAL abre falando com o leitor, sem virar saudacao', () => {
    const prompt = promptFor(RESPONSE_PERSONAS.CORDIAL);
    expect(prompt).toContain('Linha de entrada no registro CORDIAL');
    expect(prompt).toContain('e o melhor lugar da resposta para falar COM o leitor');
    expect(prompt).toContain('desde que a confusao esteja nos proprios trechos, nunca suposta');
    expect(prompt).toContain('Vamos la!'); // como exemplo do que NAO fazer
    expect(prompt).not.toContain('Linha de entrada no registro INSTITUCIONAL');
  });

  test('os exemplos de abertura das duas personalidades sao distintos', () => {
    expect(RESPONSE_PERSONAS.INSTITUCIONAL.opening).not.toBe(
      RESPONSE_PERSONAS.CORDIAL.opening,
    );
    // e o exemplo mostrado na interface ja traz a abertura interativa
    for (const persona of personas) {
      expect(persona.sample.split(/(?<=\.)\s/).length).toBeGreaterThanOrEqual(2);
    }
  });

  // ---------------------------------------------------------------------------
  // Modo procedimental: era onde as duas personalidades saiam identicas, porque
  // o esqueleto do 5B nao deixava espaco para voz nenhuma.
  // ---------------------------------------------------------------------------
  test('as duas personalidades tem voz propria no modo procedimental', () => {
    const inst = promptFor(RESPONSE_PERSONAS.INSTITUCIONAL);
    const cord = promptFor(RESPONSE_PERSONAS.CORDIAL);

    expect(inst).toContain('No registro INSTITUCIONAL, a abertura e as frases de bloco sao impessoais');
    expect(cord).toContain('No registro CORDIAL, a abertura e as frases de bloco falam com quem vai executar');
    expect(inst).not.toContain('falam com quem vai executar');
    expect(cord).not.toContain('a abertura e as frases de bloco sao impessoais');
  });

  test('o exemplo de frase de bloco difere entre as personalidades', () => {
    // O mesmo dispositivo, traduzido em duas vozes: e o que o 5B nao permitia.
    expect(promptFor(RESPONSE_PERSONAS.INSTITUCIONAL)).toContain(
      'confirma-se que o que era devido no mes anterior foi mesmo pago',
    );
    expect(promptFor(RESPONSE_PERSONAS.CORDIAL)).toContain(
      'voce confirma que o que era devido no mes anterior foi mesmo pago',
    );
  });

  test('CORDIAL nao afrouxa os limites do registro no modo procedimental', () => {
    expect(RESPONSE_PERSONAS.CORDIAL.procedural).toContain(
      'sem saudacao, sem exclamacao, sem elogio a pergunta',
    );
  });

  test('cada personalidade leva a sua propria linha de conferencia final', () => {
    expect(promptFor(RESPONSE_PERSONAS.INSTITUCIONAL)).toContain(
      'Sobrou "voce" dirigido ao leitor',
    );
    expect(promptFor(RESPONSE_PERSONAS.CORDIAL)).toContain(
      'O tom ficou proximo sem virar conversa?',
    );
  });

  test('sem argumento, buildRagPrompt usa a personalidade padrao', () => {
    expect(buildRagPrompt(contexts, 'Qual a rotina mensal?')).toBe(
      promptFor(DEFAULT_PERSONA),
    );
  });
});
