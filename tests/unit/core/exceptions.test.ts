/**
 * Unit tests for core exceptions in HAG Effect-TS variant.
 */

import { assertEquals, assertInstanceOf } from '@std/assert';
import { Effect, Exit } from 'effect';
import { 
  HAGError, 
  StateError, 
  ConfigurationError, 
  ConnectionError, 
  ValidationError, 
  HVACOperationError,
  AIError,
  ErrorUtils
} from '../../../src/core/exceptions.ts';

Deno.test('HAGError', async (t) => {
  await t.step('should create basic HAG error', () => {
    const error = new HAGError({ message: 'Test error' });
    assertEquals(error.message, 'Test error');
    assertEquals(error._tag, 'HAGError');
    assertEquals(error.code, undefined);
  });

  await t.step('should create HAG error with code and cause', () => {
    const cause = new Error('Root cause');
    const error = new HAGError({ 
      message: 'Test error', 
      code: 'TEST_CODE', 
      cause 
    });
    assertEquals(error.message, 'Test error');
    assertEquals(error.code, 'TEST_CODE');
    assertEquals(error.cause, cause);
  });

  await t.step('should work with Effect failure', async () => {
    const effect = Effect.fail(new HAGError({ message: 'Test failure' }));
    const exit = await Effect.runPromiseExit(effect);
    
    assertEquals(Exit.isFailure(exit), true);
    if (Exit.isFailure(exit)) {
      assertInstanceOf(exit.cause.defect, HAGError);
      assertEquals(exit.cause.defect.message, 'Test failure');
    }
  });
});

Deno.test('StateError', async (t) => {
  await t.step('should create state error with entity info', () => {
    const error = new StateError({ 
      message: 'Entity not found', 
      state: 'idle', 
      entityId: 'sensor.temp' 
    });
    assertEquals(error.message, 'Entity not found');
    assertEquals(error.state, 'idle');
    assertEquals(error.entityId, 'sensor.temp');
    assertEquals(error._tag, 'StateError');
  });

  await t.step('should work in Effect context', async () => {
    const effect = Effect.fail(new StateError({ 
      message: 'State transition failed', 
      entityId: 'climate.ac' 
    }));
    
    const result = await Effect.runPromiseExit(
      Effect.catchTag(effect, 'StateError', (error) => 
        Effect.succeed(`Caught: ${error.message}`)
      )
    );
    
    assertEquals(Exit.isSuccess(result), true);
    if (Exit.isSuccess(result)) {
      assertEquals(result.value, 'Caught: State transition failed');
    }
  });
});

Deno.test('ConfigurationError', async (t) => {
  await t.step('should create configuration error with field info', () => {
    const error = new ConfigurationError({ 
      message: 'Invalid value', 
      field: 'temperature', 
      value: 50 
    });
    assertEquals(error.message, 'Invalid value');
    assertEquals(error.field, 'temperature');
    assertEquals(error.value, 50);
    assertEquals(error._tag, 'ConfigurationError');
  });

  await t.step('should be catchable by tag', async () => {
    const effect = Effect.gen(function* () {
      yield* Effect.fail(new ConfigurationError({ 
        message: 'Config invalid', 
        field: 'apiKey' 
      }));
      return 'success';
    });

    const result = await Effect.runPromiseExit(
      Effect.catchTag(effect, 'ConfigurationError', (error) =>
        Effect.succeed(`Config error in field: ${error.field}`)
      )
    );

    assertEquals(Exit.isSuccess(result), true);
    if (Exit.isSuccess(result)) {
      assertEquals(result.value, 'Config error in field: apiKey');
    }
  });
});

Deno.test('ConnectionError', async (t) => {
  await t.step('should create connection error with endpoint info', () => {
    const error = new ConnectionError({ 
      message: 'Connection failed', 
      endpoint: 'ws://localhost:8123', 
      retryAttempt: 3 
    });
    assertEquals(error.message, 'Connection failed');
    assertEquals(error.endpoint, 'ws://localhost:8123');
    assertEquals(error.retryAttempt, 3);
    assertEquals(error._tag, 'ConnectionError');
  });
});

Deno.test('ValidationError', async (t) => {
  await t.step('should create validation error with type info', () => {
    const error = new ValidationError({ 
      message: 'Type mismatch', 
      field: 'mode', 
      expectedType: 'string', 
      actualValue: 42 
    });
    assertEquals(error.message, 'Type mismatch');
    assertEquals(error.field, 'mode');
    assertEquals(error.expectedType, 'string');
    assertEquals(error.actualValue, 42);
    assertEquals(error._tag, 'ValidationError');
  });
});

Deno.test('HVACOperationError', async (t) => {
  await t.step('should create HVAC operation error', () => {
    const error = new HVACOperationError({ 
      message: 'Failed to heat', 
      operation: 'heat', 
      entityId: 'climate.ac' 
    });
    assertEquals(error.message, 'Failed to heat');
    assertEquals(error.operation, 'heat');
    assertEquals(error.entityId, 'climate.ac');
    assertEquals(error._tag, 'HVACOperationError');
  });
});

Deno.test('AIError', async (t) => {
  await t.step('should create AI error with model info', () => {
    const error = new AIError({ 
      message: 'Model failed', 
      model: 'gpt-4o-mini', 
      context: 'temperature_analysis' 
    });
    assertEquals(error.message, 'Model failed');
    assertEquals(error.model, 'gpt-4o-mini');
    assertEquals(error.context, 'temperature_analysis');
    assertEquals(error._tag, 'AIError');
  });
});

Deno.test('ErrorUtils', async (t) => {
  await t.step('should create HAG error from unknown error', () => {
    const originalError = new Error('Original error');
    const hagError = ErrorUtils.fromUnknown(originalError, 'TEST_CODE');
    
    assertEquals(hagError.message, 'Original error');
    assertEquals(hagError.code, 'TEST_CODE');
    assertEquals(hagError.cause, originalError);
    assertEquals(hagError._tag, 'HAGError');
  });

  await t.step('should create HAG error from string', () => {
    const hagError = ErrorUtils.fromUnknown('String error');
    
    assertEquals(hagError.message, 'String error');
    assertEquals(hagError.cause, 'String error');
    assertEquals(hagError._tag, 'HAGError');
  });

  await t.step('should create state error', () => {
    const error = ErrorUtils.stateError('State failed', 'sensor.temp', 'unavailable');
    
    assertEquals(error.message, 'State failed');
    assertEquals(error.entityId, 'sensor.temp');
    assertEquals(error.state, 'unavailable');
    assertEquals(error._tag, 'StateError');
  });

  await t.step('should create configuration error', () => {
    const error = ErrorUtils.configError('Config invalid', 'temperature', 100);
    
    assertEquals(error.message, 'Config invalid');
    assertEquals(error.field, 'temperature');
    assertEquals(error.value, 100);
    assertEquals(error._tag, 'ConfigurationError');
  });

  await t.step('should create connection error', () => {
    const error = ErrorUtils.connectionError('Failed to connect', 'ws://test', 2);
    
    assertEquals(error.message, 'Failed to connect');
    assertEquals(error.endpoint, 'ws://test');
    assertEquals(error.retryAttempt, 2);
    assertEquals(error._tag, 'ConnectionError');
  });

  await t.step('should create validation error', () => {
    const error = ErrorUtils.validationError('Invalid type', 'mode', 'HVACMode', 'invalid');
    
    assertEquals(error.message, 'Invalid type');
    assertEquals(error.field, 'mode');
    assertEquals(error.expectedType, 'HVACMode');
    assertEquals(error.actualValue, 'invalid');
    assertEquals(error._tag, 'ValidationError');
  });

  await t.step('should create HVAC operation error', () => {
    const error = ErrorUtils.hvacOperationError('Operation failed', 'cool', 'climate.ac');
    
    assertEquals(error.message, 'Operation failed');
    assertEquals(error.operation, 'cool');
    assertEquals(error.entityId, 'climate.ac');
    assertEquals(error._tag, 'HVACOperationError');
  });

  await t.step('should create AI error', () => {
    const error = ErrorUtils.aiError('AI failed', 'gpt-4', 'analysis');
    
    assertEquals(error.message, 'AI failed');
    assertEquals(error.model, 'gpt-4');
    assertEquals(error.context, 'analysis');
    assertEquals(error._tag, 'AIError');
  });
});

Deno.test('Effect integration', async (t) => {
  await t.step('should work with Effect.catchTags for multiple error types', async () => {
    const effect = Effect.gen(function* () {
      // Randomly fail with different error types
      const rand = Math.random();
      if (rand < 0.33) {
        yield* Effect.fail(new StateError({ message: 'State error' }));
      } else if (rand < 0.66) {
        yield* Effect.fail(new ConfigurationError({ message: 'Config error' }));
      } else {
        yield* Effect.fail(new ConnectionError({ message: 'Connection error' }));
      }
      return 'success';
    });

    const result = await Effect.runPromiseExit(
      Effect.catchTags(effect, {
        StateError: (error) => Effect.succeed(`State: ${error.message}`),
        ConfigurationError: (error) => Effect.succeed(`Config: ${error.message}`),
        ConnectionError: (error) => Effect.succeed(`Connection: ${error.message}`),
      })
    );

    assertEquals(Exit.isSuccess(result), true);
    if (Exit.isSuccess(result)) {
      const message = result.value;
      const isValidMessage = 
        message.startsWith('State:') || 
        message.startsWith('Config:') || 
        message.startsWith('Connection:');
      assertEquals(isValidMessage, true);
    }
  });

  await t.step('should work with Effect.catchAll for generic error handling', async () => {
    const effect = Effect.fail(new HVACOperationError({ 
      message: 'HVAC failed',
      operation: 'heat' 
    }));

    const result = await Effect.runPromiseExit(
      Effect.catchAll(effect, (error) => 
        Effect.succeed(`Caught error: ${error._tag}`)
      )
    );

    assertEquals(Exit.isSuccess(result), true);
    if (Exit.isSuccess(result)) {
      assertEquals(result.value, 'Caught error: HVACOperationError');
    }
  });

  await t.step('should propagate errors through Effect chains', async () => {
    const effect = Effect.gen(function* () {
      yield* Effect.succeed('Step 1');
      yield* Effect.fail(new AIError({ message: 'AI processing failed' }));
      yield* Effect.succeed('Step 3'); // Should not reach here
    });

    const result = await Effect.runPromiseExit(effect);

    assertEquals(Exit.isFailure(result), true);
    if (Exit.isFailure(result)) {
      assertInstanceOf(result.cause.defect, AIError);
      assertEquals(result.cause.defect.message, 'AI processing failed');
    }
  });

  await t.step('should work with Effect.retry for error recovery', async () => {
    let attempts = 0;
    
    const effect = Effect.gen(function* () {
      attempts++;
      if (attempts < 3) {
        yield* Effect.fail(new ConnectionError({ 
          message: 'Connection failed',
          retryAttempt: attempts 
        }));
      }
      return 'Connected successfully';
    });

    const result = await Effect.runPromiseExit(
      Effect.retry(effect, { times: 3 })
    );

    assertEquals(Exit.isSuccess(result), true);
    if (Exit.isSuccess(result)) {
      assertEquals(result.value, 'Connected successfully');
    }
    assertEquals(attempts, 3);
  });
});