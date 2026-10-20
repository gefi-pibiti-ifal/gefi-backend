import { ApiProperty } from '@nestjs/swagger';
import { IsJWT, IsNotEmpty, IsString } from 'class-validator';

export class GoogleLoginDto {
  @ApiProperty({
    description:
      'ID token devolvido pelo Google Identity Services no callback do botao (campo `credential`).',
    example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6...',
  })
  @IsString()
  @IsNotEmpty({ message: 'A credencial do Google e obrigatoria.' })
  @IsJWT({ message: 'A credencial do Google nao esta no formato esperado.' })
  credential: string;
}
