import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { BootstrapService } from './bootstrap.service';
import { GoogleService } from './google.service';
import { JwtStrategy } from './jwt.strategy';
import { RolesGuard } from './roles.guard';
import { TokenModule } from './token.module';

@Module({
  imports: [UsersModule, PassportModule, PrismaModule, TokenModule],
  providers: [
    AuthService,
    GoogleService,
    JwtStrategy,
    RolesGuard,
    BootstrapService,
  ],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
