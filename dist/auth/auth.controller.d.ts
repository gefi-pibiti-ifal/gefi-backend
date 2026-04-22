import { AuthService } from './auth.service';
export declare class AuthController {
    private authService;
    constructor(authService: AuthService);
    register(body: any): Promise<{
        id: string;
        full_name: string;
        email: string;
        siap_registration: string | null;
        user_type: import(".prisma/client").$Enums.UserType;
        created_at: Date;
        updated_at: Date;
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
