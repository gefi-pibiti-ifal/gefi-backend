import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SESSION_COOKIE } from './session.cookie';
import { UsersService } from '../users/users.service';

/**
 * O que estes casos protegem e uma propriedade de seguranca, nao o formato da
 * resposta: o token de sessao precisa sair SOMENTE no cookie httpOnly. Se algum
 * dia ele voltar a aparecer no corpo, o frontend pode guarda-lo em
 * localStorage e a exposicao a XSS volta junto.
 */
describe('AuthController', () => {
  const config = {
    get: jest.fn(
      (chave: string) =>
        ({ COOKIE_SECURE: true, JWT_EXPIRES_IN: '8h' })[
          chave as 'COOKIE_SECURE' | 'JWT_EXPIRES_IN'
        ],
    ),
  } as unknown as ConfigService;

  const buildResponse = () =>
    ({ cookie: jest.fn(), clearCookie: jest.fn() }) as unknown as Response & {
      cookie: jest.Mock;
      clearCookie: jest.Mock;
    };

  const authService = {
    loginWithGoogle: jest.fn().mockResolvedValue({
      user: { id: 'user-1', email: 'fulano@ifal.edu.br' },
      token: 'jwt-assinado',
    }),
  } as unknown as AuthService;

  const usersService = {
    findById: jest.fn().mockResolvedValue({ id: 'user-1' }),
    toPublic: jest
      .fn()
      .mockReturnValue({ id: 'user-1', email: 'fulano@ifal.edu.br' }),
  } as unknown as UsersService;

  const controller = new AuthController(authService, usersService, config);

  test('o token vai no cookie httpOnly e NAO no corpo da resposta', async () => {
    const res = buildResponse();

    const body = await controller.google({ credential: 'credential' }, res);

    expect(res.cookie).toHaveBeenCalledWith(
      SESSION_COOKIE,
      'jwt-assinado',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
      }),
    );
    expect(JSON.stringify(body)).not.toContain('jwt-assinado');
  });

  test('logout apaga o cookie com os mesmos atributos com que foi criado', () => {
    const res = buildResponse();

    controller.logout(res);

    const [nome, atributos] = res.clearCookie.mock.calls[0];
    expect(nome).toBe(SESSION_COOKIE);
    // `maxAge` precisa ficar de fora: com ele, o navegador trata como cookie
    // novo com validade em vez de remover o existente.
    expect(atributos).not.toHaveProperty('maxAge');
    expect(atributos).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    });
  });

  test('/auth/me devolve o usuario da sessao', async () => {
    const resultado = await controller.me({ user: { id: 'user-1' } });
    expect(resultado.user).toEqual({
      id: 'user-1',
      email: 'fulano@ifal.edu.br',
    });
  });
});
