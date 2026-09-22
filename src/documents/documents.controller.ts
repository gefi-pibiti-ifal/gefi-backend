import {
  Controller,
  Post,
  Get,
  Body,
  UseInterceptors,
  UploadedFile,
  UseGuards,
  Req,
  Res,
  BadRequestException,
  Query,
  ForbiddenException,
  Delete,
  Param,
  StreamableFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiBody, ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import type { Response } from 'express';
import { createHash } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { DocumentsService, buildContentDisposition } from './documents.service';
import { decodeUploadFileName } from '../common/file-name';
import { RagService } from '../rag/rag.service';
import type { PageInput } from '../rag/document-location';
import {
  DocumentAccessGuard,
  DOCUMENT_ACCESS_SCOPE,
  DOCUMENT_ACCESS_TTL_SECONDS,
} from './document-access.guard';

import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';

@ApiTags('Documentos')
@ApiBearerAuth()
// DocumentAccessGuard = JwtAuthGuard + aceite de token de leitura na query
// string (necessario para <iframe>/<embed>/pdf.js, que nao enviam cabecalho).
@UseGuards(DocumentAccessGuard)
@Controller('documents')
export class DocumentsController {
  constructor(
    private documentsService: DocumentsService,
    private ragService: RagService,
    private jwtService: JwtService,
  ) {}

  @Post('upload')
  @ApiOperation({ summary: 'Upload de documento normativo' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        document_type: { type: 'string' },
        file: { type: 'string', format: 'binary' },
      },
      required: ['title', 'document_type', 'file'],
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 20 * 1024 * 1024 },
      fileFilter: (_, file, cb) => {
        file.mimetype === 'application/pdf'
          ? cb(null, true)
          : cb(new BadRequestException('Apenas ficheiros PDF são permitidos'), false);
      },
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { title: string; document_type: string },
    @Req() req: any,
  ) {

    if (req.user.user_type !== 'ADMINISTRADOR') {
      throw new ForbiddenException('Apenas administradores podem enviar documentos');
    }

    if (!file?.buffer) {
      throw new BadRequestException('Nenhum ficheiro recebido ou ficheiro vazio.');
    }

    let content: string;
    // Paginas do PDF, na ordem de extracao. Sao a UNICA fonte possivel do
    // numero de pagina de uma fonte: depois de concatenadas, a divisao se
    // perde. A extracao com splitPages produz exatamente o mesmo texto de
    // antes — o proprio loader concatenava as paginas com '\n\n' —, entao o
    // chunking e a recuperacao ficam inalterados.
    let pages: PageInput[] = [];

    try {

      const blob = new Blob([new Uint8Array(file.buffer)], { type: 'application/pdf' });

      const loader = new PDFLoader(blob, { splitPages: true });

      const docs = await loader.load();

      // O loader pula paginas sem itens de texto (capa digitalizada, pagina em
      // branco). Reconstruimos a sequencia COMPLETA de paginas, com texto vazio
      // nas puladas, para que o numero de pagina informado nas fontes seja o do
      // PDF — e nao a posicao da pagina na lista extraida.
      const textByPage = new Map<number, string>();
      docs.forEach((doc, index) => {
        const pageNumber =
          (doc.metadata?.loc?.pageNumber as number | undefined) ?? index + 1;
        textByPage.set(pageNumber, doc.pageContent);
      });
      const totalPages =
        (docs[0]?.metadata?.pdf?.totalPages as number | undefined) ?? docs.length;
      pages = Array.from({ length: totalPages }, (_, i) => ({
        page: i + 1,
        text: textByPage.get(i + 1) ?? '',
      }));

      // Texto identico ao da extracao sem divisao de paginas: o proprio loader
      // concatenava as paginas COM TEXTO usando este mesmo separador.
      content = docs.map((doc) => doc.pageContent).join('\n\n').trim();

      if (!content) {
        throw new BadRequestException(
          'Não foi possível extrair texto. O PDF pode ser baseado em imagens (digitalizado).',
        );
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;

      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Falha na extração pelo LangChain: ${message}`);
    }

    // Gravação na Base de Dados (Prisma) — o arquivo ORIGINAL e preservado
    // junto do texto extraido; sem ele nao ha como oferecer download nem
    // visualizacao fiel da fonte citada.
    const document = await this.documentsService.create({
      title: body.title,
      document_type: body.document_type,
      original_content: content,
      admin_id: req.user.id,
      // O multipart entrega o nome lido como latin1: sem esta reparacao,
      // "INSTRUÇÃO.pdf" e gravado como "INSTRUÃ‡ÃƒO.pdf" e desce no download
      // com os acentos trocados.
      file_name: decodeUploadFileName(file.originalname),
      file_mime_type: file.mimetype,
      file_size: file.size,
      file_hash: createHash('sha256').update(file.buffer).digest('hex'),
      file_data: file.buffer,
      total_pages: pages.length || null,
    });

    // Indexação RAG (em background)
    this.ragService
      .indexDocument(content, document.id, document.title, pages)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[RAG] Falha ao indexar o documento ${document.id}: ${msg}`);
      });

    return document;
  }

  @Get()
  @ApiOperation({ summary: 'Lista documentos com paginação e busca' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'title', required: false, type: String })
  async findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('title') title?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 5;
    return this.documentsService.findAll(pageNum, limitNum, title);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Metadados de um documento fonte (com links de consulta e download)',
  })
  async findOne(@Param('id') id: string) {
    return this.documentsService.findOne(id);
  }

  @Get(':id/file')
  @ApiOperation({
    summary: 'Arquivo original do documento (visualizacao inline ou download)',
  })
  @ApiQuery({
    name: 'download',
    required: false,
    description: 'Qualquer valor diferente de "0"/"false" forca o download',
  })
  async getFile(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
    @Query('download') download?: string,
  ): Promise<StreamableFile> {
    const { data, fileName, mimeType } = await this.documentsService.getFile(id);
    const isDownload =
      download !== undefined && download !== '0' && download !== 'false';

    res.set({
      'Content-Type': mimeType,
      'Content-Length': String(data.length),
      'Content-Disposition': buildContentDisposition(
        isDownload ? 'attachment' : 'inline',
        fileName,
      ),
    });

    return new StreamableFile(data);
  }

  @Get(':id/content')
  @ApiOperation({
    summary:
      'Texto indexado do documento — sistema de coordenadas de char_start/char_end das fontes',
  })
  async getContent(@Param('id') id: string) {
    return this.documentsService.getContent(id);
  }

  @Post(':id/access-token')
  @ApiOperation({
    summary:
      'Emite um token curto para abrir o arquivo em visualizador (iframe/embed/pdf.js)',
  })
  async issueAccessToken(@Param('id') id: string, @Req() req: any) {
    // Confirma que o documento existe e e visivel antes de emitir credencial.
    const document = await this.documentsService.findOne(id);

    const token = await this.jwtService.signAsync(
      { sub: req.user.id, doc: id, scope: DOCUMENT_ACCESS_SCOPE },
      { expiresIn: DOCUMENT_ACCESS_TTL_SECONDS },
    );
    const query = `token=${encodeURIComponent(token)}`;

    return {
      token,
      expires_in: DOCUMENT_ACCESS_TTL_SECONDS,
      // URLs prontas para <iframe src>, <embed> ou window.open — nenhuma delas
      // consegue enviar o cabecalho Authorization.
      view_url: document.view_url ? `${document.view_url}?${query}` : null,
      download_url: document.download_url
        ? `${document.download_url}&${query}`
        : null,
      content_url: `${document.content_url}?${query}`,
    };
  }

  @Post(':id/locations/backfill')
  @ApiOperation({
    summary:
      'Recalcula as coordenadas de um documento ja indexado (nao refaz embeddings)',
  })
  async backfillLocations(@Param('id') id: string, @Req() req: any) {
    if (req.user.user_type !== 'ADMINISTRADOR') {
      throw new ForbiddenException(
        'Apenas administradores podem reprocessar documentos',
      );
    }
    return this.ragService.backfillDocumentLocations(id);
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: any) {
    if (req.user.user_type !== 'ADMINISTRADOR') {
      throw new ForbiddenException('Apenas administradores podem deletar documentos');
    }
    return this.documentsService.remove(id);
  }
}
