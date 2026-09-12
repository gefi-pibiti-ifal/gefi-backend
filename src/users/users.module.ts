import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TokenModule } from '../auth/token.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * Importa TokenModule, e nao AuthModule: o controller so precisa REEMITIR o
 * cookie ao concluir o perfil, e depender do AuthModule inteiro criaria um
 * ciclo (AuthModule ja importa este).
 */
@Module({
  imports: [PrismaModule, TokenModule],
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
