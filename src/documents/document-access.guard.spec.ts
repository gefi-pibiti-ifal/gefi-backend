import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  DocumentAccessGuard,
  DOCUMENT_ACCESS_SCOPE,
} from './document-access.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

const SECRET = 'segredo-de-teste';

function buildContext(request: any): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('DocumentAccessGuard', () => {
  const jwt = new JwtService({ secret: SECRET });
  let guard: DocumentAccessGuard;
  let bearerFallback: jest.SpyInstance;

  const accessToken = (
    payload: Record<string, unknown>,
    options: Record<string, unknown> = {},
  ) => jwt.sign(payload, options as any);

  beforeEach(() => {
    guard = new DocumentAccessGuard(jwt);
    // O caminho Bearer e o do Passport; aqui so interessa se foi tomado.
    bearerFallback = jest
      .spyOn(JwtAuthGuard.prototype, 'canActivate')
      .mockReturnValue(true as any);
  });

  afterEach(() => bearerFallback.mockRestore());

  test('sem token na query, cai no fluxo Bearer de sempre', () => {
    const request = { method: 'GET', query: {}, params: { id: 'doc-1' } };

    expect(guard.canActivate(buildContext(request))).toBe(true);
    expect(bearerFallback).toHaveBeenCalled();
  });

  test('token valido do documento libera a leitura sem cabecalho', () => {
    const token = accessToken({
      sub: 'user-1',
      doc: 'doc-1',
      scope: DOCUMENT_ACCESS_SCOPE,
    });
    const request = { method: 'GET', query: { token }, params: { id: 'doc-1' } };

    expect(guard.canActivate(buildContext(request))).toBe(true);
    expect(bearerFallback).not.toHaveBeenCalled();
    expect(request).toMatchObject({
      user: { id: 'user-1', scope: DOCUMENT_ACCESS_SCOPE },
    });
  });

  test('token de um documento nao abre outro', () => {
    const token = accessToken({
      sub: 'user-1',
      doc: 'doc-1',
      scope: DOCUMENT_ACCESS_SCOPE,
    });
    const request = { method: 'GET', query: { token }, params: { id: 'doc-2' } };

    expect(() => guard.canActivate(buildContext(request))).toThrow(
      UnauthorizedException,
    );
  });

  test('token de sessao (sem escopo) nao vale como token de arquivo', () => {
    const token = accessToken({ id: 'user-1', user_type: 'ADMINISTRADOR' });
    const request = { method: 'GET', query: { token }, params: { id: 'doc-1' } };

    expect(() => guard.canActivate(buildContext(request))).toThrow(
      /nao corresponde a este documento/,
    );
  });

  test('token expirado e recusado', () => {
    const token = accessToken(
      { sub: 'user-1', doc: 'doc-1', scope: DOCUMENT_ACCESS_SCOPE },
      { expiresIn: '-1s' },
    );
    const request = { method: 'GET', query: { token }, params: { id: 'doc-1' } };

    expect(() => guard.canActivate(buildContext(request))).toThrow(
      /invalido ou expirado/,
    );
  });

  test('token adulterado e recusado', () => {
    const request = {
      method: 'GET',
      query: { token: 'nao.e.um.jwt' },
      params: { id: 'doc-1' },
    };

    expect(() => guard.canActivate(buildContext(request))).toThrow(
      /invalido ou expirado/,
    );
  });

  test('token de leitura nao autoriza escrita (DELETE/POST)', () => {
    const token = accessToken({
      sub: 'user-1',
      doc: 'doc-1',
      scope: DOCUMENT_ACCESS_SCOPE,
    });

    for (const method of ['DELETE', 'POST', 'PATCH']) {
      const request = { method, query: { token }, params: { id: 'doc-1' } };
      expect(() => guard.canActivate(buildContext(request))).toThrow(
        /so vale para leitura/,
      );
    }
  });
});
