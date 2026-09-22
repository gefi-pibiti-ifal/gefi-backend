import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_PERSONA_ID } from '../rag/response-persona';

const USER = {
  id: 'user-1',
  full_name: 'Murilo Cavalcante',
  email: 'fiscal@ifal.edu.br',
  siap_registration: '123456',
  user_type: 'FISCAL',
  response_persona: null as string | null,
};

function buildPrismaMock() {
  return {
    user: {
      findUnique: jest.fn(async () => USER),
      update: jest.fn(async ({ data }: any) => ({ id: 'user-1', ...data })),
      create: jest.fn(async ({ data }: any) => ({ id: 'user-1', ...data })),
    },
  };
}

describe('UsersService', () => {
  let service: UsersService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getProfile', () => {
    test('nao expoe o hash da senha', async () => {
      await service.getProfile('user-1');

      const [args] = prisma.user.findUnique.mock.calls[0] as any[];
      expect(args.select.password_hash).toBeUndefined();
      expect(args.select.response_persona).toBe(true);
    });

    test('quem nunca escolheu enxerga o padrao explicito, nao null', async () => {
      const profile = await service.getProfile('user-1');
      expect(profile.response_persona).toBe(DEFAULT_PERSONA_ID);
    });

    test('a escolha gravada e devolvida como esta', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({
        ...USER,
        response_persona: 'CORDIAL',
      } as any);

      expect((await service.getProfile('user-1')).response_persona).toBe('CORDIAL');
    });

    test('usuario inexistente resulta em 404', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null as any);
      await expect(service.getProfile('nao-existe')).rejects.toThrow(NotFoundException);
    });
  });

  describe('setResponsePersona', () => {
    test('grava a personalidade escolhida em forma canonica', async () => {
      const result = await service.setResponsePersona('user-1', 'cordial');
      expect(result.response_persona).toBe('CORDIAL');
    });

    test('personalidade desconhecida e RECUSADA (escrita nao adivinha)', async () => {
      await expect(service.setResponsePersona('user-1', 'ENGRACADO')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    test('valor vazio tambem e recusado', async () => {
      await expect(service.setResponsePersona('user-1', null)).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
