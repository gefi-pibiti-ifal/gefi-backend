import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
  ) {}

  async register(userData: any) { 
    const existingUser = await this.usersService.findOneByEmail(userData.email);
    if (existingUser) {
      throw new BadRequestException('E-mail já cadastrado');
    }

    const password_hash = await bcrypt.hash(userData.password, 10);
    
    const { password, user_type, ...rest } = userData;
    const formattedUserType = user_type?.toUpperCase(); 

    const user = await this.usersService.create({
      ...rest,
      user_type: formattedUserType,
      password_hash,
    });

    const payload = { id: user.id, email: user.email, user_type: user.user_type };
    
    return {
      token: this.jwtService.sign(payload),
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        user_type: user.user_type,
      },
    };
  }

  async login(email: string, pass: string) {
    const user = await this.usersService.findOneByEmail(email);
    if (!user) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    const isMatch = await bcrypt.compare(pass, user.password_hash);
    if (!isMatch) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    const payload = { id: user.id, email: user.email, user_type: user.user_type };
    return {
      token: this.jwtService.sign(payload),
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        user_type: user.user_type,
      },
    };
  }
}
