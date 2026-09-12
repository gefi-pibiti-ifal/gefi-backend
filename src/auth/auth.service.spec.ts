import { ForbiddenException } from '@nestjs/common';
import { User, UserType } from '@prisma/client';
import { AuthService } from './auth.service';
import { GoogleService, type GoogleIdentity } from './google.service';
import { TokenService } from './token.service';
import { UsersService } from '../users/users.service';

/**
 * O ponto sensivel do sistema: aqui se decide quem entra.
 *
 * A regra que estes casos travam e a inversao em relacao ao login antigo --
 * provar identidade no Google NAO da acesso. Acesso vem de uma linha que um
 * administrador criou antes. Uma regressao aqui reabriria o auto-cadastro.
 */
describe('AuthService.loginWithGoogle', () => {
  const IDENTIDADE: GoogleIdentity = {
    sub: 'google-sub-123',
    email: 'fulano@ifal.edu.br',
    name: 'Fulano de Tal',
    picture: 'https://lh3.googleusercontent.com/foto',
    hd: 'ifal.edu.br',
  };

  const convidado = (extra: Partial<User> = {}): User => ({
    id: 'user-1',
    email: 'fulano@ifal.edu.br',
    full_name: null,
    siap_registration: null,
    profile_completed: false,
    google_sub: null,
    picture_url: null,
    user_type: UserType.FISCAL,
    revoked_at: null,
    invited_by_id: null,
    last_login_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...extra,
  });

  let usersService: jest.Mocked<
    Pick<
      UsersService,
      'findByGoogleSub' | 'findOneByEmail' | 'registrarLogin' | 'toPublic'
    >
  >;
  let googleService: jest.Mocked<Pick<GoogleService, 'verificarCredential'>>;
  let tokenService: jest.Mocked<Pick<TokenService, 'assinar'>>;
  let service: AuthService;

  beforeEach(() => {
    usersService = {
      findByGoogleSub: jest.fn().mockResolvedValue(null),
      findOneByEmail: jest.fn().mockResolvedValue(null),
      registrarLogin: jest.fn().mockImplementation(async (id, dados) =>
        convidado({
          id,
          google_sub: dados.googleSub,
          picture_url: dados.pictureUrl,
        }),
      ),
      toPublic: jest.fn().mockImplementation((user: User) => ({
        id: user.id,
        email: user.email,
      })),
    };
    googleService = {
      verificarCredential: jest.fn().mockResolvedValue(IDENTIDADE),
    };
    tokenService = { assinar: jest.fn().mockReturnValue('jwt-assinado') };

    service = new AuthService(
      usersService as unknown as UsersService,
      googleService as unknown as GoogleService,
      tokenService as unknown as TokenService,
    );
  });

  test('conta institucional valida SEM pre-cadastro e recusada', async () => {
    await expect(service.loginWithGoogle('credential')).rejects.toThrow(
      ForbiddenException,
    );
    expect(usersService.registrarLogin).not.toHaveBeenCalled();
    expect(tokenService.assinar).not.toHaveBeenCalled();
  });

  test('primeiro acesso vincula a conta Google ao convite feito por e-mail', async () => {
    usersService.findOneByEmail.mockResolvedValue(convidado());

    const { token } = await service.loginWithGoogle('credential');

    expect(usersService.registrarLogin).toHaveBeenCalledWith('user-1', {
      googleSub: IDENTIDADE.sub,
      pictureUrl: IDENTIDADE.picture,
    });
    expect(token).toBe('jwt-assinado');
  });

  test('acessos seguintes acham a pessoa pelo google_sub, nao pelo e-mail', async () => {
    usersService.findByGoogleSub.mockResolvedValue(
      convidado({ google_sub: IDENTIDADE.sub }),
    );

    await service.loginWithGoogle('credential');

    // Busca por e-mail nem chega a acontecer: e isso que faz o login sobreviver
    // a uma renomeacao de endereco no Workspace.
    expect(usersService.findOneByEmail).not.toHaveBeenCalled();
  });

  test('acesso revogado e recusado mesmo com credencial valida', async () => {
    usersService.findOneByEmail.mockResolvedValue(
      convidado({ revoked_at: new Date() }),
    );

    await expect(service.loginWithGoogle('credential')).rejects.toThrow(
      /revogado/i,
    );
    expect(tokenService.assinar).not.toHaveBeenCalled();
  });

  test('outra conta Google reivindicando um e-mail ja vinculado e recusada', async () => {
    usersService.findOneByEmail.mockResolvedValue(
      convidado({ google_sub: 'outro-sub' }),
    );

    await expect(service.loginWithGoogle('credential')).rejects.toThrow(
      ForbiddenException,
    );
    expect(usersService.registrarLogin).not.toHaveBeenCalled();
  });

  test('credencial invalida nao chega a consultar o banco', async () => {
    googleService.verificarCredential.mockRejectedValue(
      new Error('assinatura invalida'),
    );

    await expect(service.loginWithGoogle('credential')).rejects.toThrow();
    expect(usersService.findByGoogleSub).not.toHaveBeenCalled();
    expect(usersService.findOneByEmail).not.toHaveBeenCalled();
  });
});
