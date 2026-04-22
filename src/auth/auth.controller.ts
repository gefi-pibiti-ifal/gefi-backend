import { Controller, Post, Body } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';

@ApiTags('Autenticação')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Cadastro de novo usuário' })
  @ApiResponse({ status: 201, description: 'Usuário criado com sucesso' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        full_name: { type: 'string', example: 'Daniel Berg' },
        email: { type: 'string', example: 'daniel@email.com' },
        password: { type: 'string', example: '123456' },
        siap_registration: { type: 'string', example: '123456', nullable: true },
        user_type: {
          type: 'string',
          enum: ['ADMINISTRATOR', 'FISCAL'],
          example: 'FISCAL',
        },
      },
      required: ['full_name', 'email', 'password'],
    },
  })
  register(@Body() body: any) {
    return this.authService.register(body);
  }

  @Post('login')
  @ApiOperation({ summary: 'Login de usuário' })
  @ApiResponse({ status: 200, description: 'Login bem-sucedido, retorna token JWT' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        email: { type: 'string', example: 'daniel@email.com' },
        password: { type: 'string', example: '123456' },
      },
      required: ['email', 'password'],
    },
  })
  login(@Body() body: any) {
    return this.authService.login(body.email, body.password);
  }
}