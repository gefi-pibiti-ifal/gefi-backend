import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Length, Matches } from 'class-validator';

/**
 * Primeiro acesso: a pessoa completa o que o Google nao fornece.
 *
 * Repare no que NAO esta aqui: `email` e `user_type`. Eles vieram do convite e
 * da conta Google, e aceita-los neste corpo recriaria exatamente a falha do
 * /auth/register antigo -- escolher o proprio cargo. Com `forbidNonWhitelisted`
 * ligado no ValidationPipe, manda-los aqui devolve 400.
 */
export class CompleteProfileDto {
  @ApiProperty({ example: 'Daniel Berg' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'O nome completo e obrigatorio.' })
  @Length(3, 120, {
    message: 'O nome completo deve ter entre 3 e 120 caracteres.',
  })
  full_name: string;

  @ApiProperty({ example: '1234567' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'A matricula SIAP e obrigatoria.' })
  @Matches(/^[0-9]{4,20}$/, {
    message: 'A matricula SIAP deve conter de 4 a 20 digitos.',
  })
  siap_registration: string;
}
