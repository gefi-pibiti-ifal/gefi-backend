// ---------------------------------------------------------------------------
// file-name.ts
//
// Nome de arquivo entre o upload e o download. Dois problemas distintos moram
// aqui, e os dois apareciam como "os acentos viraram _" no arquivo baixado:
//
//   1. o nome CHEGA corrompido do upload (multipart lido como latin1);
//   2. o nome SAI corrompido no cabecalho (fallback ASCII trocando tudo o que
//      nao e ASCII por "_").
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// decodeUploadFileName
//
// O parser de multipart (busboy, sob o multer) decodifica o nome do arquivo
// como latin1. Um nome em UTF-8 — "INSTRUÇÃO NORMATIVA.pdf" — chega entao como
// a leitura byte a byte desses bytes em latin1 ("INSTRUÃ‡ÃƒO NORMATIVA.pdf"),
// e era ISSO que ficava gravado no banco.
//
// A correcao e reinterpretar os bytes: latin1 de volta para UTF-8. So se
// aplica quando o resultado e comprovadamente o texto original — o nome tem de
// ser EXATAMENTE a leitura latin1 de uma sequencia UTF-8 valida (ida e volta
// identica). Um nome ja correto ("Instrução.pdf") falha nessa verificacao e
// volta intacto: nada e "consertado" no escuro.
// ---------------------------------------------------------------------------
export function decodeUploadFileName(name: string): string {
  if (!name) return name;
  // Sem bytes altos nao ha o que reinterpretar (nome puramente ASCII).
  if (!/[\u0080-\u00FF]/.test(name)) return name;
  // Caracteres fora de latin1 nao poderiam ter vindo desse tipo de leitura.
  if (/[^\u0000-\u00FF]/.test(name)) return name;

  const repaired = Buffer.from(name, 'latin1').toString('utf8');
  if (repaired.includes('\uFFFD')) return name; // nao era UTF-8 lido como latin1
  const roundTrip = Buffer.from(repaired, 'utf8').toString('latin1');
  return roundTrip === name ? repaired : name;
}

// Caracteres sem decomposicao em NFD que ainda assim tem equivalente ASCII
// obvio e frequente em titulos de normas ("Nº 147", "1º de abril").
const ASCII_EQUIVALENTS: Array<[RegExp, string]> = [
  [/[ºᵒ]/g, 'o'],
  [/[ªᵃ]/g, 'a'],
  [/[–—−]/g, '-'],
  [/[“”„«»]/g, ''],
  [/[‘’‚]/g, ''],
  [/…/g, '...'],
  [/[\u00A0\u2007\u202F]/g, ' '],
];

// ---------------------------------------------------------------------------
// toAsciiFileName
//
// Versao ASCII do nome, usada no parametro `filename` do Content-Disposition —
// o que clientes antigos (e parsers ingenuos que so procuram `filename=`) leem.
//
// Acentos sao TRANSLITERADOS, nao apagados: "Instrução" vira "Instrucao", e
// nao "Instru__o". So vira "_" o que nao tem equivalente ASCII algum.
// ---------------------------------------------------------------------------
export function toAsciiFileName(name: string): string {
  let out = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const [pattern, replacement] of ASCII_EQUIVALENTS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/[^\x20-\x7E]/g, '_');
}

/**
 * Monta o cabecalho Content-Disposition de forma segura.
 *
 * O nome do arquivo vem do upload (portanto do usuario): CR/LF e aspas sao
 * removidos para que ele nao possa injetar cabecalhos. O nome real vai em
 * `filename*` (RFC 5987, UTF-8 percent-encoded), que e o que os navegadores
 * atuais usam; `filename` leva a transliteracao ASCII como reserva.
 *
 * Atencao: para o JAVASCRIPT do frontend conseguir LER este cabecalho numa
 * resposta cross-origin, ele precisa estar em Access-Control-Expose-Headers
 * (ver enableCors em main.ts) — sem isso o fetch nao enxerga o nome.
 */
export function buildContentDisposition(
  type: 'inline' | 'attachment',
  fileName: string,
): string {
  const sanitized =
    decodeUploadFileName(fileName).replace(/[\r\n"\\]/g, '').trim() ||
    'documento.pdf';
  const ascii = toAsciiFileName(sanitized);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(sanitized)}`;
}
