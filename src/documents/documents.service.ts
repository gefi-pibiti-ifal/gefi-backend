import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { readPageMap } from '../rag/document-location';
import { buildDocumentLinks } from '../rag/response-sources';

// Campos seguros para respostas de API: TUDO menos file_data, que e o PDF
// inteiro e so trafega pela rota de arquivo. Selecionar explicitamente evita
// que uma coluna nova vaze por acidente num `findMany` sem select.
const DOCUMENT_SUMMARY_SELECT = {
  id: true,
  deleted_at: true,
  title: true,
  document_type: true,
  created_at: true,
  updated_at: true,
  file_name: true,
  file_mime_type: true,
  file_size: true,
  total_pages: true,
} as const;

/**
 * Monta o cabecalho Content-Disposition de forma segura.
 *
 * O nome do arquivo vem do upload (portanto do usuario): CR/LF e aspas sao
 * removidos para que ele nao possa injetar cabecalhos, e a forma `filename*`
 * (RFC 5987) preserva acentos — comuns em titulos de normas — sem depender do
 * que o cliente aceita em bytes crus.
 */
export function buildContentDisposition(
  type: 'inline' | 'attachment',
  fileName: string,
): string {
  const sanitized = fileName.replace(/[\r\n"\\]/g, '').trim() || 'documento.pdf';
  const ascii = sanitized.replace(/[^\x20-\x7E]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(sanitized)}`;
}

@Injectable()
export class DocumentsService {
  constructor(private prisma: PrismaService) {}

  async create(data: any) {
    return this.prisma.normativeDocument.create({
      data,
      select: { ...DOCUMENT_SUMMARY_SELECT, original_content: true, admin_id: true },
    });
  }

  async findAll(page: number = 1, limit: number = 10, title?: string) {
    const skip = (page - 1) * limit;

    const where = {
      deleted_at: null,
      ...(title ? { title: { contains: title, mode: 'insensitive' as const } } : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.normativeDocument.findMany({
        where,
        select: {
          id: true,
          title: true,
          document_type: true,
          created_at: true,
          file_name: true,
          file_size: true,
          total_pages: true,
        },
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.normativeDocument.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Metadados de um documento fonte, com os links de visualizacao/download.
   * E o que o frontend precisa para transformar uma fonte num link clicavel.
   */
  async findOne(id: string) {
    const document = await this.prisma.normativeDocument.findFirst({
      where: { id, deleted_at: null },
      select: DOCUMENT_SUMMARY_SELECT,
    });
    if (!document) throw new NotFoundException('Documento nao encontrado');

    return {
      ...document,
      file: {
        available: Boolean(document.file_name),
        name: document.file_name,
        mime_type: document.file_mime_type,
        size: document.file_size,
      },
      ...buildDocumentLinks(document.id, Boolean(document.file_name)),
    };
  }

  /**
   * Arquivo original para visualizacao/download.
   *
   * Documentos enviados antes da preservacao do arquivo nao tem binario: a
   * resposta e 404 com uma mensagem que diz o que fazer (consultar o texto
   * indexado ou reenviar o PDF), nunca um arquivo vazio.
   */
  async getFile(id: string) {
    const document = await this.prisma.normativeDocument.findFirst({
      where: { id, deleted_at: null },
      select: {
        id: true,
        title: true,
        file_name: true,
        file_mime_type: true,
        file_size: true,
        file_data: true,
      },
    });
    if (!document) throw new NotFoundException('Documento nao encontrado');
    if (!document.file_data) {
      throw new NotFoundException(
        'Este documento foi indexado antes da preservacao do arquivo original. ' +
          'O texto continua disponivel em /api/documents/' +
          id +
          '/content; para habilitar o download, reenvie o PDF.',
      );
    }

    return {
      data: Buffer.from(document.file_data),
      fileName: document.file_name ?? `${document.title}.pdf`,
      mimeType: document.file_mime_type ?? 'application/pdf',
    };
  }

  /**
   * Texto indexado do documento — o mesmo que o RAG dividiu em trechos, e
   * portanto o sistema de coordenadas de char_start/char_end das fontes.
   *
   * Serve tanto como visualizador alternativo (documentos sem arquivo
   * original) quanto como base para o frontend destacar o trecho citado.
   * Documentos indexados antes desta funcionalidade caem no texto extraido
   * original — util para leitura, porem sem alinhamento com os offsets, o que
   * e sinalizado por `aligned_with_offsets`.
   */
  async getContent(id: string) {
    const document = await this.prisma.normativeDocument.findFirst({
      where: { id, deleted_at: null },
      select: {
        id: true,
        title: true,
        document_type: true,
        indexed_content: true,
        original_content: true,
        page_map: true,
        total_pages: true,
        file_name: true,
      },
    });
    if (!document) throw new NotFoundException('Documento nao encontrado');

    const aligned = Boolean(document.indexed_content);
    return {
      id: document.id,
      title: document.title,
      document_type: document.document_type,
      content: document.indexed_content ?? document.original_content,
      aligned_with_offsets: aligned,
      total_pages: document.total_pages,
      page_map: readPageMap(document.page_map),
      ...buildDocumentLinks(document.id, Boolean(document.file_name)),
    };
  }

  async remove(id: string) {
    const document = await this.prisma.normativeDocument.findFirst({
      where: { id, deleted_at: null },
    });

    if (!document) {
      throw new NotFoundException('Documento não encontrado ou já removido');
    }

    // 1. Remove os vetores da tabela do LangChain (pgvector)
    //    metadata é JSONB — usa o operador ->> para comparar o campo documentId
    await this.prisma.$executeRaw`
      DELETE FROM documentos_vetorizados
      WHERE metadata->>'documentId' = ${id}
    `;

    // 2. Deleta fisicamente o documento.
    //    O Cascade no ParentChunk (schema.prisma) apaga os parent_chunks automaticamente.
    //    O ResponseSource não tem Cascade, então deletamos antes para evitar FK violation.
    //    Os trechos (response_source_excerpts) saem em cascata com o ResponseSource.
    await this.prisma.responseSource.deleteMany({
      where: { normative_id: id },
    });

    return this.prisma.normativeDocument.delete({
      where: { id },
      select: DOCUMENT_SUMMARY_SELECT,
    });
  }
}
