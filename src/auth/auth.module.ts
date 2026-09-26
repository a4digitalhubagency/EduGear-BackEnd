import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { PlatformAdminModule } from '../platform/platform-admin.module';
import { TenantsModule } from '../tenants/tenants.module';
import { AccessControlService } from './access-control.service';
import { MembershipCacheService } from './membership-cache.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { JwtStrategy } from './strategies/jwt.strategy';

/**
 * Global because the guards registered app-wide depend on AccessControlService.
 */
@Global()
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({}),
    TenantsModule,
    // The strategy resolves platform tokens through it.
    PlatformAdminModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    AccessControlService,
    MembershipCacheService,
    JwtStrategy,
  ],
  exports: [AccessControlService, PasswordService, TokenService],
})
export class AuthModule {}
