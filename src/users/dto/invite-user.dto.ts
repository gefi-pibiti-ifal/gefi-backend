import { ApiProperty } from '@nestjs/swagger';
import { UserType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsOptional } from 'class-validator';

/**
 * Pre-cadastro feito por um administrador. Sao os UNICOS dois campos que
 * alguem define por outra pessoa -- nome e matricula a propria pessoa preenche
 * no primeiro acesso (ver CompleteProfileDto).
 */
export class InviteUserDto {
  @ApiProperty({ example: 'fulano@ifal.edu.br' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'Informe um e-mail valido.' })
  email: string;

  @ApiProperty({ enum: UserType, default: UserType.FISCAL, required: false })
  @IsOptional()
  @IsEnum(UserType, { message: 'Cargo invalido. Use ADMINISTRADOR ou FISCAL.' })
  user_type?: UserType = UserType.FISCAL;
}
