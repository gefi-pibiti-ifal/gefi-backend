import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { GoogleLoginDto } from './dto/google-login.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { SESSION_COOKIE, opcoesDoCookie } from './session.cookie';

@ApiTags('Autenticacao')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly config: ConfigService,
  ) {}

  @Post('google')
  @HttpCode(HttpStatus.OK)
  // Verificar um ID token custa uma chamada de rede; sem limite, a rota vira
  // um amplificador barato para quem quiser martelar o servico.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Login com conta Google institucional' })
  @ApiResponse({
    status: 200,
    description: 'Sessao criada; o token vai no cookie httpOnly.',
  })
  @ApiResponse({
    status: 403,
    description: 'E-mail nao pre-cadastrado ou acesso revogado.',
  })
  async google(
    @Body() dto: GoogleLoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, token } = await this.authService.loginWithGoogle(
      dto.credential,
    );

    // O token NAO vai no corpo: se fosse devolvido, o frontend poderia guarda-lo
    // em localStorage e recriaria exatamente a exposicao que este desenho evita.
    res.cookie(SESSION_COOKIE, token, opcoesDoCookie(this.config));

    return { user };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Encerra a sessao apagando o cookie' })
  logout(@Res({ passthrough: true }) res: Response) {
    // `clearCookie` so remove se os atributos baterem com os do `res.cookie`.
    const { maxAge, ...atributos } = opcoesDoCookie(this.config);
    res.clearCookie(SESSION_COOKIE, atributos);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Usuario da sessao atual' })
  @ApiResponse({ status: 401, description: 'Sem cookie de sessao valido.' })
  async me(@Req() req: any) {
    // O frontend nao consegue ler o cookie httpOnly, entao esta rota e a forma
    // de ele saber quem esta logado ao montar a aplicacao.
    const user = await this.usersService.findById(req.user.id);
    return { user: user ? this.usersService.toPublic(user) : null };
  }
}
