import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/** Global: the throttler storage, the permission cache and the health probe all need it. */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
