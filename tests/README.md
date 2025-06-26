# HAG Effect-TS Variant - Test Suite

This directory contains comprehensive tests for the HAG Effect-TS variant using functional programming patterns with Effect Context/Layer dependency injection.

## Test Structure

```
tests/
├── unit/                    # Unit tests for individual components
│   ├── core/               # Core functionality tests
│   │   └── exceptions.test.ts
│   ├── config/             # Configuration schema tests
│   │   └── settings.test.ts
│   └── types/              # Type definition tests
│       └── common.test.ts
├── integration/            # Integration tests
│   └── hvac-integration.test.ts
└── README.md              # This file
```

## Running Tests

### All Tests
```bash
deno task test
```

### Unit Tests Only
```bash
deno task test:unit
```

### Integration Tests Only
```bash
deno task test:integration
```

### Watch Mode (Auto-rerun on changes)
```bash
deno task test:watch
```

### Coverage Report
```bash
deno task test:coverage
```

## Test Categories

### Unit Tests
- **Core Exceptions**: Tests for Effect tagged errors and ErrorUtils
- **Configuration Schemas**: Validation of Effect Schema definitions
- **Type Definitions**: Enum values and type structure validation

### Integration Tests
- **Effect Layer Composition**: Testing Context/Layer dependency injection
- **HVAC Controller Integration**: Full system integration with Effect patterns
- **Error Handling**: Effect-native error handling with tagged errors

## Test Patterns

### Effect Pattern Testing
Tests use Effect-native patterns throughout:

```typescript
await t.step('should work with Effect failure', async () => {
  const effect = Effect.fail(new HAGError({ message: 'Test failure' }));
  const exit = await Effect.runPromiseExit(effect);
  
  assertEquals(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    assertInstanceOf(exit.cause.defect, HAGError);
  }
});
```

### Layer-Based Dependency Injection
Tests use Layer composition for service dependencies:

```typescript
const TestLayer = Layer.mergeAll(
  Layer.succeed(SettingsService, mockSettings),
  Layer.succeed(HvacOptionsService, mockSettings.hvacOptions),
  MockHomeAssistantClient,
  MockHVACStateMachine
);

const effect = Effect.gen(function* () {
  const controller = yield* HVACController;
  const result = yield* controller.start;
  return result;
});

const result = await Effect.runPromise(
  Effect.provide(effect, TestLayer)
);
```

### Schema Validation Testing
Tests use Effect Schema for validation:

```typescript
await t.step('should validate with Effect Schema', async () => {
  const validConfig = { /* ... */ };
  const result = await Effect.runPromise(S.decode(HvacOptionsSchema)(validConfig));
  assertEquals(result.systemMode, SystemMode.AUTO);
});

await t.step('should reject invalid config', async () => {
  const invalidConfig = { /* ... */ };
  const effect = S.decode(HvacOptionsSchema)(invalidConfig);
  const exit = await Effect.runPromiseExit(effect);
  
  assertEquals(Exit.isFailure(exit), true);
});
```

### Error Handling Testing
Tests demonstrate Effect error handling patterns:

```typescript
const effect = Effect.catchTags(someEffect, {
  StateError: (error) => Effect.succeed(`State: ${error.message}`),
  ConfigurationError: (error) => Effect.succeed(`Config: ${error.message}`),
  ConnectionError: (error) => Effect.succeed(`Connection: ${error.message}`),
});
```

## Test Coverage

The test suite covers:

- ✅ **Effect Tagged Errors**: All error types and ErrorUtils
- ✅ **Effect Schema**: Configuration validation and transformations
- ✅ **Context/Layer System**: Dependency injection and service composition
- ✅ **Effect Patterns**: Error handling, composition, and resource management
- ✅ **HVAC Operations**: Controller operations using Effect patterns
- ✅ **Concurrent Operations**: Effect.all and parallel execution
- ✅ **Resource Management**: Proper cleanup and lifecycle management

## Effect-Specific Testing Features

### Error Recovery and Retry
```typescript
const effect = Effect.retry(
  someFailingOperation,
  { times: 3 }
);

const result = await Effect.runPromise(effect);
```

### Concurrent Operations
```typescript
const results = yield* Effect.all([
  controller.getStatus,
  haClient.getStats,
  stateMachine.getStatus,
], { concurrency: 'unbounded' });
```

### Resource Safety
```typescript
const effect = Effect.gen(function* () {
  yield* resource.acquire;
  try {
    return yield* useResource(resource);
  } finally {
    yield* resource.release;
  }
});
```

### Effect Composition
```typescript
const composedEffect = Effect.gen(function* () {
  const config = yield* ConfigService;
  const client = yield* HomeAssistantClient;
  const result = yield* client.getState(config.tempSensor);
  return result;
});
```

## Mock Services

### Effect Layer Mocks
Tests use Layer-based mocks that integrate seamlessly with Effect DI:

```typescript
const MockHomeAssistantClient = Layer.effect(
  HomeAssistantClient,
  Effect.gen(function* () {
    const stateRef = yield* Ref.make(initialState);
    
    return HomeAssistantClient.of({
      connect: () => pipe(stateRef, Ref.update(s => ({ ...s, connected: true }))),
      getState: (entityId) => /* Effect implementation */,
      // ...
    });
  })
);
```

### State Management
Uses Effect Ref for state management in tests:

```typescript
const stateRef = yield* Ref.make(initialState);
const updateState = (newValue) => Ref.update(stateRef, () => newValue);
const getState = () => Ref.get(stateRef);
```

## Contributing

When adding new features:

1. **Use Effect patterns** throughout tests
2. **Leverage Layer composition** for dependency injection
3. **Handle errors with tagged errors** and proper Effect error handling
4. **Use Effect.gen** for readable async code
5. **Test both success and failure paths** with Effect.either or Effect.catchAll
6. **Use Ref for state management** in mock services

## Performance Benefits

Effect-TS tests offer several performance advantages:

- **Lazy evaluation**: Effects are only executed when run
- **Efficient composition**: Layer composition is optimized
- **Resource management**: Automatic cleanup and resource safety
- **Concurrent execution**: Built-in support for parallel operations
- **Memory efficiency**: Functional patterns reduce memory overhead

## Effect-TS Best Practices in Tests

1. **Always use Effect.gen** for readable async operations
2. **Prefer Effect.all** for concurrent operations
3. **Use Effect.catchAll or Effect.catchTags** for error handling
4. **Leverage Layer.succeed** for simple service mocks
5. **Use Ref.make** for stateful mock services
6. **Test with Effect.runPromiseExit** to examine both success and failure cases