import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * Escopo dos tokens de ACESSO A ARQUIVO. Um token de login nao tem escopo; um
 * token de arquivo nao serve para mais nada alem de ler o documento para o
 * qual foi emitido (ver DocumentAccessGuard e JwtStrategy).
 */
export const DOCUMENT_ACCESS_SCOPE = 'document-file';

/** Validade curta: o link so precisa sobreviver ao carregamento do visualizador. */
export const DOCUMENT_ACCESS_TTL_SECONDS = 600;

export interface DocumentAccessPayload {
  sub: string;
  doc: string;
  scope: typeof DOCUMENT_ACCESS_SCOPE;
}

// ---------------------------------------------------------------------------
// DocumentAccessGuard
//
// O problema que este guard resolve: um <iframe src>, <embed>, <object> ou o
// pdf.js apontado para uma URL NAO enviam o cabecalho Authorization. Com o
// guard JWT puro, a rota do arquivo respondia 401 e o visualizador ficava em
// branco — o documento simplesmente nao aparecia, embora o arquivo estivesse
// gravado e a rota funcionasse via fetch com Bearer.
//
// A saida e aceitar tambem um token de curta duracao na query string, emitido
// sob demanda por um usuario ja autenticado (POST /documents/:id/access-token).
// Regras que mantem isso estreito:
//   - so em requisicoes GET (nada de apagar ou reprocessar com este token);
//   - o token vale para UM documento — `doc` tem de bater com o :id da rota;
//   - o token carrega escopo proprio e NAO carrega user_type, entao nao passa
//     nas verificacoes de administrador;
//   - sem token na query, o comportamento e exatamente o de antes (Bearer).
// ---------------------------------------------------------------------------
@Injectable()
export class DocumentAccessGuard extends JwtAuthGuard {
  constructor(private readonly jwtService: JwtService) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const token =
      typeof request.query?.token === 'string' ? request.query.token : '';

    if (!token) return super.canActivate(context);

    if (request.method !== 'GET') {
      throw new UnauthorizedException(
        'Token de acesso ao documento so vale para leitura',
      );
    }

    let payload: DocumentAccessPayload;
    try {
      payload = this.jwtService.verify<DocumentAccessPayload>(token);
    } catch {
      throw new UnauthorizedException(
        'Token de acesso ao documento invalido ou expirado',
      );
    }

    if (
      payload?.scope !== DOCUMENT_ACCESS_SCOPE ||
      !payload.doc ||
      payload.doc !== request.params?.id
    ) {
      throw new UnauthorizedException(
        'Token de acesso nao corresponde a este documento',
      );
    }

    request.user = { id: payload.sub, scope: DOCUMENT_ACCESS_SCOPE };
    return true;
  }
}
