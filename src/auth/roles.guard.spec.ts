import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserType } from '@prisma/client';
import { ROLES_KEY } from './roles.decorator';
import { RolesGuard } from './roles.guard';

/**
 * Estes casos cobrem a restricao de cargo que antes vivia como `if` solto
 * dentro de documents.controller.ts. Ficam aqui, e nao no spec do controller,
 * porque a regra agora e do guard -- e vale para toda rota anotada com @Roles,
 * nao so para as de documentos.
 */
describe('RolesGuard', () => {
  const buildContext = (user: unknown): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    }) as unknown as ExecutionContext;

  const buildGuard = (required: UserType[] | undefined) => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(required),
    } as unknown as Reflector;
    return { guard: new RolesGuard(reflector), reflector };
  };

  test('rota sem @Roles fica liberada para qualquer autenticado', () => {
    const { guard } = buildGuard(undefined);
    expect(
      guard.canActivate(buildContext({ user_type: UserType.FISCAL })),
    ).toBe(true);
  });

  test('administrador passa em rota restrita a administradores', () => {
    const { guard } = buildGuard([UserType.ADMINISTRADOR]);
    expect(
      guard.canActivate(buildContext({ user_type: UserType.ADMINISTRADOR })),
    ).toBe(true);
  });

  test('fiscal e recusado em rota restrita a administradores', () => {
    const { guard } = buildGuard([UserType.ADMINISTRADOR]);
    expect(() =>
      guard.canActivate(buildContext({ user_type: UserType.FISCAL })),
    ).toThrow(ForbiddenException);
  });

  test('requisicao sem usuario e recusada em vez de passar despercebida', () => {
    const { guard } = buildGuard([UserType.ADMINISTRADOR]);
    expect(() => guard.canActivate(buildContext(undefined))).toThrow(
      ForbiddenException,
    );
  });

  test('le a metadata tanto do handler quanto da classe', () => {
    const { guard, reflector } = buildGuard([UserType.ADMINISTRADOR]);
    guard.canActivate(buildContext({ user_type: UserType.ADMINISTRADOR }));

    const espiao = reflector.getAllAndOverride as jest.Mock;
    expect(espiao).toHaveBeenCalledWith(ROLES_KEY, expect.any(Array));
    // Handler primeiro, classe depois: e essa ordem que permite a uma rota
    // sobrescrever o @Roles declarado no controller inteiro.
    expect(espiao.mock.calls[0][1]).toHaveLength(2);
  });
});
