import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import * as dotenv from 'dotenv';
import { SESSION_COOKIE } from './auth/session.cookie';

// Mantido antes do NestFactory de proposito: o PrismaClient le DATABASE_URL de
// process.env no momento em que e instanciado, e nao ha garantia de que isso
// aconteca depois do ConfigModule popular o ambiente.
dotenv.config();

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix('api');

  // Atras de proxy (Caddy -> Next -> API), o IP do socket e sempre o do
  // container do frontend. Sem `trust proxy`, o ThrottlerGuard (que usa req.ip)
  // contaria TODOS os usuarios como um so e o limite de 120 req/min valeria
  // para o site inteiro. TRUST_PROXY aceita o formato do Express: numero de
  // saltos, true/false, ou lista de redes (ex.: "loopback, uniquelocal").
  // So defina quando a API NAO estiver exposta direto a internet.
  const trustProxy = process.env.TRUST_PROXY?.trim();
  if (trustProxy) {
    app.set(
      'trust proxy',
      /^\d+$/.test(trustProxy)
        ? Number(trustProxy)
        : trustProxy === 'true'
          ? true
          : trustProxy === 'false'
            ? false
            : trustProxy,
    );
  }

  // Necessario para que a JwtStrategy consiga ler o token: ele vive no cookie
  // httpOnly, e sem este middleware `req.cookies` simplesmente nao existe.
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      // `whitelist` descarta campos nao declarados no DTO e
      // `forbidNonWhitelisted` transforma o envio deles em 400. Sao as duas
      // opcoes que impedem a reedicao da falha do /auth/register antigo, onde o
      // corpo `any` deixava o cliente escolher o proprio `user_type`.
      whitelist: true,
      forbidNonWhitelisted: true,
      // Sem isto, `page`/`limit` de query string chegariam como string e os
      // @IsInt dos DTOs falhariam.
      transform: true,
    }),
  );

  // CORS aberto + cookie de credencial e proibido pelo navegador, e nao ha
  // motivo para o backend aceitar qualquer origem: em producao o frontend fala
  // com ele pelo proxy same-origin do Next. A env existe para cenarios de
  // desenvolvimento em que o front roda em outra porta.
  const origens = config.get<string[]>('CORS_ORIGIN') ?? [];
  if (origens.length > 0) {
    app.enableCors({ origin: origens, credentials: true });
    logger.log(`CORS liberado para: ${origens.join(', ')}`);
  } else {
    logger.log('CORS desabilitado (acesso esperado via proxy same-origin).');
  }

  const swaggerConfig = new DocumentBuilder()
    .setTitle('GeFi Docs API (NestJS)')
    .setDescription(
      'API para gestão de documentos normativos e chat assistido por IA (RAG)',
    )
    .setVersion('1.0')
    // A sessao e um cookie, nao um header Authorization: o "Authorize" do
    // Swagger e informativo -- o navegador ja envia o cookie sozinho depois
    // que voce faz login pelo frontend na mesma origem.
    .addCookieAuth(SESSION_COOKIE)
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api-docs', app, document);

  await app.listen(config.get<number>('PORT') ?? 3000);
  logger.log(`Application is running on: ${await app.getUrl()}`);
  logger.log(`Swagger documentation: ${await app.getUrl()}/api-docs`);
}

void bootstrap();
