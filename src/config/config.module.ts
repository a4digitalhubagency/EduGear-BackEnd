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
      // Tests build process.env themselves (test/setup-env.ts loads the same
      // two files, then overrides what must not point at anything real) and
      // reading the files again here would undo that. It did: setup-env deletes
      // the R2 credentials so uploads go to a temporary directory, but dotenv
      // only declines to overwrite variables that are *present*, so deleting
      // them simply let the file supply them again — and a developer with real
      // credentials in .env had the whole integration suite writing its
      // fixtures into the live bucket, and failing on its network errors.
      ignoreEnvFile: process.env.NODE_ENV === 'test',
      load: [configFactory],
      validate: validateEnv,
    }),
  ],
})
export class AppConfigModule {}
