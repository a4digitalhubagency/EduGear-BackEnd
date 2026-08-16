import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { AppConfig } from '../../config/configuration';
import {
  RequestContext,
  TenantContextMissingError,
} from '../context/request-context';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';

interface ErrorBody {
  statusCode: HttpStatus;
  errorCode: string;
  message: string;
  details?: unknown;
  requestId?: string;
  timestamp: string;
  path: string;
}

/**
 * Single exit point for every error. Guarantees one response shape and makes
 * sure stack traces, SQL and Prisma internals never reach a client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const isProduction = this.config.get('app', { infer: true }).isProduction;

    const body = this.toErrorBody(exception, request);

    // 5xx means we broke something — always log with the stack for triage.
    if (body.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        {
          requestId: body.requestId,
          path: body.path,
          method: request.method,
          userId: RequestContext.getAuth()?.userId,
          schoolId: RequestContext.getTenantId(),
          errorCode: body.errorCode,
          err: exception,
        },
        `Unhandled error on ${request.method} ${body.path}`,
      );
    } else if (
      body.statusCode === HttpStatus.FORBIDDEN ||
      body.statusCode === HttpStatus.UNAUTHORIZED
    ) {
      this.logger.warn(
        {
          requestId: body.requestId,
          path: body.path,
          method: request.method,
          userId: RequestContext.getAuth()?.userId,
          schoolId: RequestContext.getTenantId(),
          errorCode: body.errorCode,
        },
        `Access denied on ${request.method} ${body.path}`,
      );
    }

    if (isProduction && body.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      body.message = 'An unexpected error occurred';
      delete body.details;
    }

    response.status(body.statusCode).json(body);
  }

  private toErrorBody(exception: unknown, request: Request): ErrorBody {
    const base = {
      requestId: RequestContext.getRequestId(),
      timestamp: new Date().toISOString(),
      path: request.originalUrl ?? request.url,
    };

    if (exception instanceof AppException) {
      return {
        ...base,
        statusCode: exception.getStatus(),
        errorCode: exception.errorCode,
        message: exception.message,
        details: exception.details,
      };
    }

    if (exception instanceof HttpException) {
      return { ...base, ...this.fromHttpException(exception) };
    }

    // A missing tenant context is always a programming error, never client input.
    if (exception instanceof TenantContextMissingError) {
      return {
        ...base,
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        errorCode: ErrorCode.INTERNAL_ERROR,
        message: exception.message,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return { ...base, ...this.fromPrismaError(exception) };
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        ...base,
        statusCode: HttpStatus.BAD_REQUEST,
        errorCode: ErrorCode.MALFORMED_REQUEST,
        message: 'The request could not be processed',
      };
    }

    return {
      ...base,
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode: ErrorCode.INTERNAL_ERROR,
      message:
        exception instanceof Error
          ? exception.message
          : 'An unexpected error occurred',
    };
  }

  private fromHttpException(exception: HttpException) {
    const status = exception.getStatus();
    const payload = exception.getResponse();

    if (typeof payload === 'object' && payload !== null) {
      const record = payload as Record<string, unknown>;

      // Output of the global ValidationPipe.
      if (Array.isArray(record.message) && status === HttpStatus.BAD_REQUEST) {
        return {
          statusCode: status,
          errorCode: ErrorCode.VALIDATION_ERROR,
          message: 'Request validation failed',
          details: record.message,
        };
      }

      return {
        statusCode: status,
        errorCode:
          (record.errorCode as string) ?? this.defaultCodeForStatus(status),
        message:
          (record.message as string) ??
          (record.error as string) ??
          this.defaultMessage(status),
        details: record.details,
      };
    }

    return {
      statusCode: status,
      errorCode: this.defaultCodeForStatus(status),
      message:
        typeof payload === 'string' ? payload : this.defaultMessage(status),
    };
  }

  private fromPrismaError(exception: Prisma.PrismaClientKnownRequestError) {
    switch (exception.code) {
      case 'P2002': {
        const target = (exception.meta?.target as string[] | undefined)?.join(
          ', ',
        );
        return {
          statusCode: HttpStatus.CONFLICT,
          errorCode: ErrorCode.DUPLICATE_RESOURCE,
          message: target
            ? `A record with the same ${target} already exists`
            : 'A record with the same unique value already exists',
        };
      }
      case 'P2025':
        return {
          statusCode: HttpStatus.NOT_FOUND,
          errorCode: ErrorCode.NOT_FOUND,
          message: 'The requested record was not found',
        };
      case 'P2003':
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          errorCode: ErrorCode.RELATED_RESOURCE_MISSING,
          message: 'A referenced record does not exist',
        };
      case 'P2014':
        return {
          statusCode: HttpStatus.CONFLICT,
          errorCode: ErrorCode.CONFLICT,
          message: 'The change would break a required relation',
        };
      default:
        return {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          errorCode: ErrorCode.INTERNAL_ERROR,
          message: 'A database error occurred',
        };
    }
  }

  private defaultCodeForStatus(status: HttpStatus): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.MALFORMED_REQUEST;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHENTICATED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.CONFLICT;
      case HttpStatus.PAYLOAD_TOO_LARGE:
        return ErrorCode.PAYLOAD_TOO_LARGE;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      case HttpStatus.SERVICE_UNAVAILABLE:
        return ErrorCode.SERVICE_UNAVAILABLE;
      default:
        return ErrorCode.INTERNAL_ERROR;
    }
  }

  private defaultMessage(status: HttpStatus): string {
    return status >= 500
      ? 'An unexpected error occurred'
      : 'Request could not be completed';
  }
}
