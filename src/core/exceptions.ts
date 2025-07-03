/**
 * Core exception classes for HAG Effect-TS variant.
 * 
 * Effect-native error handling with tagged errors and proper type safety.
 */

import { Data } from 'effect';

/**
 * Base HAG error using Effect's Data.TaggedError
 */
export class HAGError extends Data.TaggedError('HAGError')<{
  readonly message: string;
  readonly code?: string;
  readonly cause?: unknown;
}> {}

/**
 * State-related errors for Home Assistant entity state operations
 */
export class StateError extends Data.TaggedError('StateError')<{
  readonly message: string;
  readonly state?: string;
  readonly entityId?: string;
}> {}

/**
 * Configuration validation and loading errors
 */
export class ConfigurationError extends Data.TaggedError('ConfigurationError')<{
  readonly message: string;
  readonly field?: string;
  readonly value?: unknown;
}> {}

/**
 * Connection errors for WebSocket and HTTP communications
 */
export class ConnectionError extends Data.TaggedError('ConnectionError')<{
  readonly message: string;
  readonly endpoint?: string;
  readonly retryAttempt?: number;
}> {}

/**
 * Schema validation errors
 */
export class ValidationError extends Data.TaggedError('ValidationError')<{
  readonly message: string;
  readonly field?: string;
  readonly expectedType?: string;
  readonly actualValue?: unknown;
}> {}

/**
 * HVAC operation specific errors
 */
export class HVACOperationError extends Data.TaggedError('HVACOperationError')<{
  readonly message: string;
  readonly operation?: string;
  readonly entityId?: string;
}> {}

/**
 * AI-related errors for LangChain operations
 */
export class AIError extends Data.TaggedError('AIError')<{
  readonly message: string;
  readonly model?: string;
  readonly context?: string;
}> {}

/**
 * Utility functions for error handling
 */
export const ErrorUtils = {
  /**
   * Create a HAG error from an unknown error
   */
  fromUnknown: (error: unknown, code?: string): HAGError => {
    if (error instanceof Error) {
      return new HAGError({
        message: error.message,
        code,
        cause: error,
      });
    }
    
    return new HAGError({
      message: String(error),
      code,
      cause: error,
    });
  },

  /**
   * Create a state error
   */
  stateError: (message: string, entityId?: string, state?: string): StateError =>
    new StateError({ message, entityId, state }),

  /**
   * Create a configuration error
   */
  configError: (message: string, field?: string, value?: unknown): ConfigurationError =>
    new ConfigurationError({ message, field, value }),

  /**
   * Create a connection error
   */
  connectionError: (message: string, endpoint?: string, retryAttempt?: number): ConnectionError =>
    new ConnectionError({ message, endpoint, retryAttempt }),

  /**
   * Create a validation error
   */
  validationError: (
    message: string,
    field?: string,
    expectedType?: string,
    actualValue?: unknown,
  ): ValidationError =>
    new ValidationError({ message, field, expectedType, actualValue }),

  /**
   * Create an HVAC operation error
   */
  hvacOperationError: (message: string, operation?: string, entityId?: string): HVACOperationError =>
    new HVACOperationError({ message, operation, entityId }),

  /**
   * Create an AI error
   */
  aiError: (message: string, model?: string, context?: string): AIError =>
    new AIError({ message, model, context }),

  /**
   * Extract details from an unknown error or Effect Cause.
   */
  extractErrorDetails: (error: unknown): {
    message: string;
    name: string;
    code?: string;
    stack?: string;
    cause?: unknown;
  } => {
    if (error instanceof HAGError) {
      return {
        message: error.message,
        name: error._tag,
        code: error.code,
        stack: (error.cause instanceof Error) ? error.cause.stack : undefined,
        cause: error.cause,
      };
    } else if (error instanceof Error) {
      return {
        message: error.message,
        name: error.name,
        stack: error.stack,
        cause: undefined,
      };
    } else if (typeof error === 'object' && error !== null && '_tag' in error && 'message' in error) {
      // Handle other Effect TaggedErrors
      return {
        message: (error as any).message,
        name: (error as any)._tag,
        stack: ((error as any).cause instanceof Error) ? (error as any).cause.stack : undefined,
        cause: (error as any).cause,
      };
    }
    return {
      message: String(error),
      name: 'UnknownError',
      stack: undefined,
      cause: undefined,
    };
  },
} as const;