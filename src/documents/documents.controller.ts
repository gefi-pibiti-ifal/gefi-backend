import {
  Controller,
  Post,
  Get,
  Body,
  UseInterceptors,
  UploadedFile,
  UseGuards,
  Req,
  BadRequestException,
  Query,
  ForbiddenException,
  Delete,
  Param,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiBody, ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DocumentsService } from './documents.service';
import { RagService } from '../rag/rag.service';

import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';

@ApiTags('Documentos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('documents')
export class DocumentsController {
  constructor(
    private documentsService: DocumentsService,
    private ragService: RagService,
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
    
    try {
    
      const blob = new Blob([new Uint8Array(file.buffer)], { type: 'application/pdf' });
      
      const loader = new PDFLoader(blob, { splitPages: false });

      const docs = await loader.load();
      
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

    // Gravação na Base de Dados (Prisma)
    const document = await this.documentsService.create({
      title: body.title,
      document_type: body.document_type,
      original_content: content,
      admin_id: req.user.id,
    });

    // Indexação RAG (em background)
    this.ragService
      .indexDocument(content, document.id, document.title)
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

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  async remove(@Param('id') id: string, @Req() req: any) {
    if (req.user.user_type !== 'ADMINISTRADOR') {
      throw new ForbiddenException('Apenas administradores podem deletar documentos');
    }
    return this.documentsService.remove(id);
  }
}