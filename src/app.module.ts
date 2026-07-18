import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { UsersModule } from './users/users.module';
import { DocumentsModule } from './documents/documents.module';
import { ChatModule } from './chat/chat.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
    }),
    PrismaModule,
    AuthModule,
    UsersModule,
    DocumentsModule,
    ChatModule
  ],
  controllers: [AppController],
  // RagService NAO e declarado aqui: ele e provido (e exportado) pelo
  // RagModule, que e @Global. Declara-lo tambem neste modulo criava uma
  // SEGUNDA instancia do servico — com um segundo pool de conexoes PG e uma
  // segunda inicializacao do PGVectorStore a cada boot.
  providers: [AppService],
})
export class AppModule {}
