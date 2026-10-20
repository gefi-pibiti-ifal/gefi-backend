import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from './token.service';

/**
 * Isola a assinatura de JWT para que AuthModule e UsersModule possam usa-la
 * sem importar um ao outro (ver comentario em token.service.ts).
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      // `registerAsync` e obrigatorio aqui: o `register` sincrono era avaliado
      // na importacao do modulo, antes do ConfigModule validar o ambiente --
      // era isso que tornava tentador o antigo `process.env.JWT_SECRET || '...'`.
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
      }),
    }),
  ],
  providers: [TokenService],
  exports: [TokenService, JwtModule],
})
export class TokenModule {}
