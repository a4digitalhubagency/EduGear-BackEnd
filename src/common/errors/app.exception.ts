import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-codes';

const CONFLICT_STATUS: number = HttpStatus.CONFLICT;

export interface ValidationDetail {
  field: string;
  constraints: string[];
}

/**
 * Every deliberate error thrown by the application. Carries a stable code so the
 * exception filter never has to guess how to render it.
 */
export class AppException extends HttpException {
  readonly errorCode: ErrorCode;
  readonly details?: ValidationDetail[] | Record<string, unknown>;

  constructor(
    status: HttpStatus,
    errorCode: ErrorCode,
    message: string,
    details?: ValidationDetail[] | Record<string, unknown>,
  ) {
    super({ errorCode, message, details }, status);
    this.errorCode = errorCode;
    this.details = details;
  }

  static badRequest(message: string, code = ErrorCode.MALFORMED_REQUEST) {
    return new AppException(HttpStatus.BAD_REQUEST, code, message);
  }

  static unauthorized(
    message = 'Authentication required',
    code = ErrorCode.UNAUTHENTICATED,
  ) {
    return new AppException(HttpStatus.UNAUTHORIZED, code, message);
  }

  static forbidden(
    message = 'You do not have access to this resource',
    code = ErrorCode.FORBIDDEN,
  ) {
    return new AppException(HttpStatus.FORBIDDEN, code, message);
  }

  static notFound(resource: string, code = ErrorCode.NOT_FOUND) {
    return new AppException(
      HttpStatus.NOT_FOUND,
      code,
      `${resource} not found`,
    );
  }

  static conflict(message: string, code = ErrorCode.CONFLICT) {
    return new AppException(HttpStatus.CONFLICT, code, message);
  }

  static duplicate(message: string) {
    return new AppException(
      HttpStatus.CONFLICT,
      ErrorCode.DUPLICATE_RESOURCE,
      message,
    );
  }

  /** True for a 409 we raised: a clash with the current state, not a failure. */
  static isConflict(error: unknown): boolean {
    return (
      error instanceof AppException && error.getStatus() === CONFLICT_STATUS
    );
  }

  static internal(message = 'An unexpected error occurred') {
    return new AppException(
      HttpStatus.INTERNAL_SERVER_ERROR,
      ErrorCode.INTERNAL_ERROR,
      message,
    );
  }
}
