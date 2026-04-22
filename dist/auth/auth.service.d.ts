import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
export declare class AuthService {
    private usersService;
    private jwtService;
    constructor(usersService: UsersService, jwtService: JwtService);
    register(userData: any): Promise<{
        id: string;
        full_name: string;
        email: string;
        siap_registration: string | null;
        user_type: import(".prisma/client").$Enums.UserType;
        created_at: Date;
        updated_at: Date;
    }>;
    login(email: string, pass: string): Promise<{
        token: string;
        user: {
            id: string;
            full_name: string;
            email: string;
            user_type: import(".prisma/client").$Enums.UserType;
        };
    }>;
}
