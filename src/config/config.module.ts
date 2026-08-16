import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { configFactory } from './configuration';
import { validateEnv } from './env.validation';

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // .env.local wins over .env so a developer can override without touching the shared file.
      envFilePath: ['.env.local', '.env'],
      load: [configFactory],
      validate: validateEnv,
    }),
  ],
})
export class AppConfigModule {}
