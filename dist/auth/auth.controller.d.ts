import { AuthService } from './auth.service';
export declare class AuthController {
    private authService;
    constructor(authService: AuthService);
    register(body: any): Promise<{
        token: string;
        user: {
            id: string;
            full_name: string;
            email: string;
            user_type: import(".prisma/client").$Enums.UserType;
        };
    }>;
    login(body: any): Promise<{
        token: string;
        user: {
            id: string;
            full_name: string;
            email: string;
            user_type: import(".prisma/client").$Enums.UserType;
        };
    }>;
}
