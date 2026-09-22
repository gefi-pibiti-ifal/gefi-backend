/**
 * Compara a MESMA pergunta nas duas personalidades, contra o modelo real.
 *
 * Existe porque nao ha eval automatizado: toda mudanca de prompt so pode ser
 * julgada lendo a saida. Este script reduz isso a um comando e limpa o que
 * cria (conversa, interacoes e fontes de teste saem do banco no final).
 *
 * Uso — com a API de pe em :3999 (PORT=3999 node dist/main.js):
 *   node scripts/comparar-personas.js
 *   node scripts/comparar-personas.js "sua pergunta aqui"
 *
 * O que olhar na saida:
 *   - a ABERTURA orienta o trabalho, ou so anuncia a lista que vem embaixo?
 *   - os TITULOS dizem o momento do trabalho, ou repetem a finalidade do item?
 *   - a frase de cada bloco e traducao, ou o texto da norma recolado?
 *   - as duas personalidades saem DIFERENTES uma da outra?
 */
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const API = 'http://127.0.0.1:3999/api';
const PERGUNTA =
  process.argv[2] ||
  'Quais são as rotinas de fiscalização mensal exigidas no Anexo VIII-B da IN 05/2017?';

(async () => {
  const user = await p.user.findFirst();
  const token = jwt.sign(
    { id: user.id, email: user.email, user_type: user.user_type },
    process.env.JWT_SECRET || 'gefi_secret_key_2026',
    { expiresIn: '20m' },
  );
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const post = async (u, b) =>
    (await fetch(API + u, { method: 'POST', headers: h, body: JSON.stringify(b) })).json();

  const conv = await post('/chat/conversations', { title: 'TMP 5B' });
  for (const persona of ['INSTITUCIONAL', 'CORDIAL']) {
    const r = await post('/chat/ask', { conversation_id: conv.id, query: PERGUNTA, persona });
    console.log('='.repeat(78));
    console.log(`[${r.persona}]`);
    console.log('='.repeat(78));
    console.log(r.ai_response);
    console.log();
  }

  const ints = await p.interactionHistory.findMany({
    where: { conversation_id: conv.id },
    select: { id: true },
  });
  const ids = ints.map((i) => i.id);
  const srcs = await p.responseSource.findMany({
    where: { interaction_id: { in: ids } },
    select: { id: true },
  });
  await p.responseSourceExcerpt.deleteMany({
    where: { response_source_id: { in: srcs.map((x) => x.id) } },
  });
  await p.responseSource.deleteMany({ where: { interaction_id: { in: ids } } });
  await p.interactionHistory.deleteMany({ where: { conversation_id: conv.id } });
  await p.conversation.delete({ where: { id: conv.id } });
  console.log('(conversa de teste removida)');
  await p.$disconnect();
})();
