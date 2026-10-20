import { BadRequestException, ConflictException } from '@nestjs/common';
import { UserType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';

const ADMIN_ID = 'admin-1';

function buildPrisma() {
  return {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest
        .fn()
        .mockImplementation(async ({ data }) => ({ id: 'novo', ...data })),
      update: jest.fn().mockImplementation(async ({ where, data }) => ({
        id: where.id,
        ...data,
      })),
      delete: jest.fn().mockResolvedValue(undefined),
      count: jest.fn().mockResolvedValue(0),
    },
    $transaction: jest.fn(),
  };
}

describe('UsersService', () => {
  let prisma: ReturnType<typeof buildPrisma>;
  let service: UsersService;

  beforeEach(() => {
    prisma = buildPrisma();
    service = new UsersService(prisma as unknown as PrismaService);
  });

  describe('invite', () => {
    test('cria a linha com e-mail e cargo, deixando o perfil em branco', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await service.invite(
        { email: 'Fulano@IFAL.edu.br', user_type: UserType.FISCAL },
        ADMIN_ID,
      );

      const { data } = prisma.user.create.mock.calls[0][0];
      // E-mail normalizado: sem isso, "Fulano@" e "fulano@" viram contas distintas
      // e o login (que compara com o e-mail minusculo do Google) nao encontraria a linha.
      expect(data.email).toBe('fulano@ifal.edu.br');
      expect(data.user_type).toBe(UserType.FISCAL);
      expect(data.invited_by_id).toBe(ADMIN_ID);
      expect(data.full_name).toBeUndefined();
    });

    test('cargo omitido cai em FISCAL, nunca em ADMINISTRADOR', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await service.invite({ email: 'fulano@ifal.edu.br' }, ADMIN_ID);

      expect(prisma.user.create.mock.calls[0][0].data.user_type).toBe(
        UserType.FISCAL,
      );
    });

    test('e-mail ja ativo e recusado', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        revoked_at: null,
      });

      await expect(
        service.invite({ email: 'fulano@ifal.edu.br' }, ADMIN_ID),
      ).rejects.toThrow(ConflictException);
    });

    test('reconvidar alguem revogado reativa em vez de falhar', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        revoked_at: new Date(),
      });

      await service.invite(
        { email: 'fulano@ifal.edu.br', user_type: UserType.FISCAL },
        ADMIN_ID,
      );

      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.user.update.mock.calls[0][0].data.revoked_at).toBeNull();
    });
  });

  describe('completeProfile', () => {
    test('marca o perfil como concluido', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });

      await service.completeProfile('user-1', {
        full_name: 'Fulano de Tal',
        siap_registration: '1234567',
      });

      expect(prisma.user.update.mock.calls[0][0].data).toEqual({
        full_name: 'Fulano de Tal',
        siap_registration: '1234567',
        profile_completed: true,
      });
    });
  });

  describe('updateRole', () => {
    test('administrador nao altera o proprio cargo', async () => {
      await expect(
        service.updateRole(ADMIN_ID, UserType.FISCAL, ADMIN_ID),
      ).rejects.toThrow(BadRequestException);
    });

    test('rebaixar o ultimo administrador ativo e bloqueado', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'outro-admin',
        user_type: UserType.ADMINISTRADOR,
      });
      prisma.user.count.mockResolvedValue(0); // nenhum outro admin sobraria

      await expect(
        service.updateRole('outro-admin', UserType.FISCAL, ADMIN_ID),
      ).rejects.toThrow(/ultima conta de administrador/i);
    });

    test('rebaixar um admin quando existe outro e permitido', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'outro-admin',
        user_type: UserType.ADMINISTRADOR,
      });
      prisma.user.count.mockResolvedValue(1);

      await service.updateRole('outro-admin', UserType.FISCAL, ADMIN_ID);

      expect(prisma.user.update.mock.calls[0][0].data).toEqual({
        user_type: UserType.FISCAL,
      });
    });
  });

  describe('remove', () => {
    const semHistorico = {
      conversations: 0,
      normativeDocuments: 0,
      systemAudits: 0,
    };

    test('administrador nao remove o proprio acesso', async () => {
      await expect(service.remove(ADMIN_ID, ADMIN_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    test('convite nunca usado e apagado de verdade', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        user_type: UserType.FISCAL,
        _count: semHistorico,
      });

      const resultado = await service.remove('user-1', ADMIN_ID);

      expect(prisma.user.delete).toHaveBeenCalledWith({
        where: { id: 'user-1' },
      });
      expect(resultado).toEqual({ revogado: false });
    });

    test('conta com historico e revogada, preservando a autoria dos registros', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        user_type: UserType.FISCAL,
        _count: { ...semHistorico, normativeDocuments: 2 },
      });

      const resultado = await service.remove('user-1', ADMIN_ID);

      expect(prisma.user.delete).not.toHaveBeenCalled();
      expect(resultado).toEqual({ revogado: true });

      const { data } = prisma.user.update.mock.calls[0][0];
      expect(data.revoked_at).toBeInstanceOf(Date);
      // Desvincular a conta Google faz um eventual reconvite comecar limpo.
      expect(data.google_sub).toBeNull();
    });

    test('remover o ultimo administrador ativo e bloqueado', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'outro-admin',
        user_type: UserType.ADMINISTRADOR,
        _count: semHistorico,
      });
      prisma.user.count.mockResolvedValue(0);

      await expect(service.remove('outro-admin', ADMIN_ID)).rejects.toThrow(
        /ultima conta de administrador/i,
      );
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });
  });

  describe('toPublic', () => {
    test('nao expoe o google_sub', () => {
      const publico = service.toPublic({
        id: 'user-1',
        email: 'fulano@ifal.edu.br',
        google_sub: 'google-sub-123',
        invited_by_id: ADMIN_ID,
        updated_at: new Date(),
      } as never);

      expect(publico).not.toHaveProperty('google_sub');
      expect(publico).toHaveProperty('email');
    });
  });
});
