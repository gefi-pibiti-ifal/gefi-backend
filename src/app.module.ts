import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { UsersModule } from './users/users.module';
import { DocumentsModule } from './documents/documents.module';
import { ChatModule } from './chat/chat.module';
import { validate } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      // Derruba o boot quando falta config critica (JWT_SECRET, GOOGLE_CLIENT_ID).
      // Antes disso, um deploy sem JWT_SECRET subia assinando com um segredo
      // que estava literalmente no codigo-fonte.
      validate,
    }),
    // Limite global generoso; /auth/google restringe mais via @Throttle.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    AuthModule,
    UsersModule,
    DocumentsModule,
    ChatModule,
  ],
  controllers: [AppController],
  // RagService NAO e declarado aqui: ele e provido (e exportado) pelo
  // RagModule, que e @Global. Declara-lo tambem neste modulo criava uma
  // SEGUNDA instancia do servico — com um segundo pool de conexoes PG e uma
  // segunda inicializacao do PGVectorStore a cada boot.
  providers: [
    AppService,
    // Sem registrar o guard globalmente, o @Throttle em /auth/google seria
    // apenas metadado decorativo -- nao limitaria nada.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
