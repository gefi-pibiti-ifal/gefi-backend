import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserType } from '@prisma/client';
import { ROLES_KEY } from './roles.decorator';

/**
 * Centraliza a checagem de cargo que antes estava repetida como `if` solto
 * dentro de tres handlers de documents.controller.ts. O problema daquela forma
 * nao era o codigo duplicado: era o fato de que ESQUECER o `if` num handler
 * novo nao produz erro nenhum -- a rota simplesmente nasce aberta. Aqui a
 * permissao vira declaracao no topo do metodo, visivel na leitura.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserType[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Sem @Roles, o guard nao opina: quem decide o acesso e o JwtAuthGuard.
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest().user as
      { user_type?: UserType } | undefined;

    if (!user?.user_type || !required.includes(user.user_type)) {
      throw new ForbiddenException(`Acao restrita a: ${required.join(', ')}.`);
    }

    return true;
  }
}
