import {
  Controller,
  Post,
  Get,
  Body,
  UseInterceptors,
  UploadedFile,
  UseGuards,
  Req,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DocumentsService } from './documents.service';
import { RagService } from '../rag/rag.service';

const pdfModule = require('pdf-parse');

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
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: any,
    @Req() req: any,
  ) {
    const pdf = pdfModule.default ? pdfModule.default : pdfModule;

    const pdfData = await pdf(file.buffer);


    const content = pdfData.text;

    const document = await this.documentsService.create({
      title: body.title,
      document_type: body.document_type,
      original_content: content,
      admin_id: req.user.id,
    });

    await this.ragService.indexDocument(
      content,
      document.id,
      document.title,
    );

    return document;
  }

  @Get()
  @ApiOperation({ summary: 'Lista todos os documentos' })
  findAll() {
    return this.documentsService.findAll();
  }
}