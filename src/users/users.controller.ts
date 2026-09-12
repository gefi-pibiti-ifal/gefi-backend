import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserType } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SESSION_COOKIE, opcoesDoCookie } from '../auth/session.cookie';
import { TokenService } from '../auth/token.service';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import { InviteUserDto } from './dto/invite-user.dto';
import { ListUsersDto } from './dto/list-users.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { UsersService } from './users.service';

@ApiTags('Usuarios')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly tokenService: TokenService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Primeiro acesso. Note que o cargo nao aparece em lugar nenhum deste
   * handler: ele veio do convite e so muda pela rota de administrador abaixo.
   */
  @Patch('me')
  @ApiOperation({
    summary: 'Completa o proprio perfil (nome e matricula SIAP)',
  })
  @ApiResponse({
    status: 400,
    description: 'Campos invalidos, ou tentativa de enviar cargo/e-mail.',
  })
  async completeProfile(
    @Req() req: any,
    @Body() dto: CompleteProfileDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.usersService.completeProfile(req.user.id, dto);

    // `profile_completed` faz parte do payload do token; sem reemitir, o
    // PrivateRoute do frontend continuaria devolvendo a pessoa para
    // /complete-profile ate o token expirar.
    res.cookie(
      SESSION_COOKIE,
      this.tokenService.assinar(user),
      opcoesDoCookie(this.config),
    );

    return { user: this.usersService.toPublic(user) };
  }

  @Get()
  @Roles(UserType.ADMINISTRADOR)
  @ApiOperation({ summary: 'Lista usuarios (busca e paginacao)' })
  list(@Query() query: ListUsersDto) {
    return this.usersService.list(query);
  }

  @Post()
  @Roles(UserType.ADMINISTRADOR)
  @ApiOperation({ summary: 'Pre-cadastra um usuario (e-mail + cargo)' })
  @ApiResponse({
    status: 201,
    description: 'Convite criado; a pessoa completa o perfil no 1o login.',
  })
  @ApiResponse({ status: 409, description: 'E-mail ja cadastrado e ativo.' })
  async invite(@Req() req: any, @Body() dto: InviteUserDto) {
    return { user: await this.usersService.invite(dto, req.user.id) };
  }

  @Patch(':id')
  @Roles(UserType.ADMINISTRADOR)
  @ApiOperation({ summary: 'Altera o cargo de um usuario' })
  async updateRole(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserRoleDto,
  ) {
    return {
      user: await this.usersService.updateRole(id, dto.user_type, req.user.id),
    };
  }

  @Delete(':id')
  @Roles(UserType.ADMINISTRADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove ou revoga o acesso de um usuario',
    description:
      'Convite nunca usado e sem registros vinculados e apagado; conta com historico e revogada, ' +
      'para preservar a autoria de documentos e conversas.',
  })
  remove(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.remove(id, req.user.id);
  }
}
