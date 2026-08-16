import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { RequestContext } from '../context/request-context';

/**
 * Opens the AsyncLocalStorage context for every request. It runs before guards,
 * so the JWT strategy can drop the resolved tenant into the same store and the
 * Prisma tenant guard sees it for the rest of the request.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers['x-request-id'];
    const requestId =
      typeof incoming === 'string' &&
      incoming.length > 0 &&
      incoming.length <= 128
        ? incoming
        : randomUUID();

    res.setHeader('x-request-id', requestId);

    RequestContext.run(
      {
        requestId,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      },
      () => next(),
    );
  }
}
