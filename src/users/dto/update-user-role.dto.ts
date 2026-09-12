import { ApiProperty } from '@nestjs/swagger';
import { UserType } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpdateUserRoleDto {
  @ApiProperty({ enum: UserType })
  @IsEnum(UserType, { message: 'Cargo invalido. Use ADMINISTRADOR ou FISCAL.' })
  user_type: UserType;
}
