import { SetMetadata } from '@nestjs/common';
import { UserType } from '@prisma/client';

export const ROLES_KEY = 'gefi:roles';

/**
 * Restringe uma rota a determinados cargos.
 *
 * Use SEMPRE junto do JwtAuthGuard e nesta ordem -- o RolesGuard le
 * `request.user`, que so existe depois que o guard de autenticacao rodou:
 *
 *   @UseGuards(JwtAuthGuard, RolesGuard)
 *   @Roles(UserType.ADMINISTRADOR)
 */
export const Roles = (...roles: UserType[]) => SetMetadata(ROLES_KEY, roles);
