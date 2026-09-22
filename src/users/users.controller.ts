import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UsersService } from './users.service';
import { listPersonas } from '../rag/response-persona';

@ApiTags('Usuários')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Perfil e preferencias do usuario autenticado' })
  async me(@Req() req: any) {
    const profile = await this.usersService.getProfile(req.user.id);
    // O catalogo vai junto para a tela de preferencias nao precisar de uma
    // segunda chamada so para saber o que existe.
    return { ...profile, available_personas: listPersonas() };
  }

  @Patch('me/preferences')
  @ApiOperation({ summary: 'Atualiza as preferencias do usuario autenticado' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        response_persona: {
          type: 'string',
          enum: listPersonas().map((persona) => persona.id),
          example: 'CORDIAL',
        },
      },
      required: ['response_persona'],
    },
  })
  async updatePreferences(
    @Body() body: { response_persona: string },
    @Req() req: any,
  ) {
    return this.usersService.setResponsePersona(req.user.id, body.response_persona);
  }
}
