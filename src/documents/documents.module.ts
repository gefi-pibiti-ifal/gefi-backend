import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DocumentsService } from './documents.service';
import { DocumentsController } from './documents.controller';
import { DocumentAccessGuard } from './document-access.guard';
import { PrismaModule } from 'src/prisma/prisma.module';
import { RagModule } from 'src/rag/rag.module';

@Module({
  imports: [
    PrismaModule,
    RagModule,
    // Mesmo segredo do login: os tokens de acesso a arquivo sao JWTs curtos,
    // distinguidos do token de sessao pelo campo `scope`.
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'gefi_secret_key_2026',
    }),
  ],
  providers: [DocumentsService, DocumentAccessGuard],
  controllers: [DocumentsController],
})
export class DocumentsModule {}
