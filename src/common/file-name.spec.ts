import {
  buildContentDisposition,
  decodeUploadFileName,
  toAsciiFileName,
} from './file-name';

// O nome que o multipart entrega quando um arquivo UTF-8 e lido como latin1.
function asMultipartReadsIt(utf8Name: string): string {
  return Buffer.from(utf8Name, 'utf8').toString('latin1');
}

describe('decodeUploadFileName', () => {
  const cases = [
    'INSTRUÇÃO NORMATIVA Nº 5, DE 26 DE MAIO DE 2017.pdf',
    'LEI Nº 14.133, DE 1º DE ABRIL DE 2021.pdf',
    'Contrato de Prestação de Serviços — Anexo.pdf',
    'Fiscalização & Execução (revisão).pdf',
  ];

  test.each(cases)('recupera o nome original de "%s"', (original) => {
    expect(decodeUploadFileName(asMultipartReadsIt(original))).toBe(original);
  });

  test('nome ja correto passa intacto', () => {
    const name = 'INSTRUÇÃO NORMATIVA Nº 5.pdf';
    expect(decodeUploadFileName(name)).toBe(name);
  });

  test('nome puramente ASCII passa intacto', () => {
    expect(decodeUploadFileName('CONTRATO_N_06_2024-REITORIA.pdf')).toBe(
      'CONTRATO_N_06_2024-REITORIA.pdf',
    );
  });

  test('nome fora de latin1 (ex.: outro alfabeto) nao e alterado', () => {
    expect(decodeUploadFileName('规范.pdf')).toBe('规范.pdf');
  });

  test('vazio e preservado', () => {
    expect(decodeUploadFileName('')).toBe('');
  });

  test('reparar duas vezes nao corrompe (idempotente sobre o nome ja correto)', () => {
    const original = 'INSTRUÇÃO NORMATIVA Nº 5.pdf';
    const once = decodeUploadFileName(asMultipartReadsIt(original));
    expect(decodeUploadFileName(once)).toBe(original);
  });
});

describe('toAsciiFileName', () => {
  test('translitera acentos em vez de apagar', () => {
    expect(toAsciiFileName('INSTRUÇÃO NORMATIVA.pdf')).toBe('INSTRUCAO NORMATIVA.pdf');
    expect(toAsciiFileName('Fiscalização e Execução.pdf')).toBe(
      'Fiscalizacao e Execucao.pdf',
    );
  });

  test('ordinais e travessoes ganham equivalente ASCII', () => {
    expect(toAsciiFileName('LEI Nº 14.133, DE 1º DE ABRIL — DOU.pdf')).toBe(
      'LEI No 14.133, DE 1o DE ABRIL - DOU.pdf',
    );
  });

  test('nome ASCII nao e alterado', () => {
    expect(toAsciiFileName('Contrato_10-2023.pdf')).toBe('Contrato_10-2023.pdf');
  });
});

describe('buildContentDisposition', () => {
  test('acentos sobrevivem no fallback ASCII e no filename*', () => {
    const header = buildContentDisposition(
      'attachment',
      'INSTRUÇÃO NORMATIVA Nº 5.pdf',
    );

    expect(header).toContain('filename="INSTRUCAO NORMATIVA No 5.pdf"');
    expect(header).toContain(
      "filename*=UTF-8''INSTRU%C3%87%C3%83O%20NORMATIVA%20N%C2%BA%205.pdf",
    );
    expect(header).not.toContain('_'); // era exatamente isto que aparecia antes
  });

  test('nome corrompido pelo multipart e reparado antes de virar cabecalho', () => {
    const header = buildContentDisposition(
      'attachment',
      asMultipartReadsIt('INSTRUÇÃO NORMATIVA Nº 5.pdf'),
    );

    expect(header).toContain('filename="INSTRUCAO NORMATIVA No 5.pdf"');
  });

  test('inline para visualizacao, attachment para download', () => {
    expect(buildContentDisposition('inline', 'norma.pdf')).toContain('inline;');
    expect(buildContentDisposition('attachment', 'norma.pdf')).toContain('attachment;');
  });

  test('remove quebras de linha e aspas (injecao de cabecalho)', () => {
    const header = buildContentDisposition('attachment', 'a"\r\nX-Injetado: sim\r\n.pdf');

    expect(header).not.toMatch(/[\r\n]/);
    expect(header).not.toContain('a"');
  });

  test('nome vazio cai num nome padrao', () => {
    expect(buildContentDisposition('inline', '   ')).toContain(
      'filename="documento.pdf"',
    );
  });
});
