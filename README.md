# HAG Effect-TS Variant

This is an experimental alpha version migrating from Rust-based Hass HVAC automation to Effect-TS to evaluate the latest tools and frameworks in the ecosystem.

Home Assistant aGentic HVAC automation system - Modern functional TypeScript implementation with Effect-TS ecosystem.

## Overview

This is the Effect-TS variant of HAG, featuring:
- **Effect System**: Effect-TS for functional programming patterns
- **Dependency Management**: Effect Context/Layer system
- **Validation**: @effect/schema (Effect-native)
- **Logging**: Effect Logger
- **HTTP/WebSocket**: @effect/platform
- **CLI**: @effect/cli (Effect-native)
- **Error Handling**: Effect tagged errors
- **State Machine**: XState v5

## Features

- ✅ **Type-safe configuration** with Effect Schema validation
- ✅ **XState-powered HVAC state machine** with heating/cooling strategies  
- ✅ **Effect-native WebSocket client** with proper error handling
- ✅ **AI-powered decision making** with Effect-wrapped LangChain
- ✅ **Defrost cycle management** using Effect Fiber system
- ✅ **Functional programming patterns** with Effect-TS
- ✅ **Advanced error handling** with typed errors and Railway-oriented programming

## Quick Start

### Prerequisites

- Deno 2.x
- Home Assistant instance with WebSocket API access
- OpenAI API key (optional, for AI features)

### Installation

```bash
# Clone and enter the directory
cd hag_ts

# Check configuration
deno task check

# Install dependencies (automatic with Deno)
deno cache src/main.ts
```

### Configuration

1. Copy the example configuration:
```bash
cp config/hvac_config.yaml config/my_config.yaml
```

2. Edit `config/my_config.yaml` with your Home Assistant details:
```yaml
hassOptions:
  wsUrl: ws://your-hass-instance:8123/api/websocket
  restUrl: http://your-hass-instance:8123
  token: your_long_lived_access_token

hvacOptions:
  tempSensor: sensor.your_temperature_sensor
  hvacEntities:
    - entityId: climate.your_hvac_device
      enabled: true
```

3. Set environment variables (optional):
```bash
export HASS_TOKEN="your_token"
export HAG_USE_AI="true"           # Enable AI features
export OPENAI_API_KEY="your_key"   # Required for AI
```

### Running

```bash
# Development mode
deno task dev

# With specific config
deno task dev --config config/my_config.yaml

# Build executable
deno task build

# Run tests
deno task test
```

## Architecture

### Effect-TS Patterns

Uses Effect for functional programming with proper error handling:

```typescript
const getState = (entityId: string): Effect.Effect<HassState, StateError> =>
  Effect.tryPromise({
    try: () => fetch(`/api/states/${entityId}`).then(r => r.json()),
    catch: (error) => new StateError({
      message: `Failed to get state for ${entityId}`,
      entityId
    })
  });
```

### Dependency Management

Effect Context/Layer system for dependency injection:

```typescript
export class HomeAssistantClient extends Context.Tag("HomeAssistantClient")<
  HomeAssistantClient,
  {
    readonly getState: (entityId: string) => Effect.Effect<HassState, HAGError>;
    readonly callService: (call: ServiceCall) => Effect.Effect<void, HAGError>;
  }
>() {}

const AppLayer = Layer.provide(
  HVACControllerLive,
  Layer.merge(HomeAssistantClientLive, Logger.pretty)
);
```

### Configuration

Effect Schema for validation:

```typescript
const HvacOptionsSchema = S.struct({
  tempSensor: S.string.pipe(S.pattern(/^sensor\..+/)),
  systemMode: S.literal("auto", "heat_only", "cool_only", "off"),
  // ...
});
```

### Error Handling

Effect Data.TaggedError for type-safe errors:

```typescript
export class StateError extends Data.TaggedError("StateError")<{
  readonly message: string;
  readonly entityId?: string;
}> {}
```

### CLI with Effect

Effect CLI for command-line interface:

```typescript
const configOption = Options.file("config").pipe(
  Options.withAlias("c"),
  Options.withDescription("Configuration file path")
);

const hagCommand = Command.make("hag", { config: configOption }).pipe(
  Command.withHandler(({ config }) =>
    Effect.gen(function* () {
      yield* Effect.log(`Starting HAG with config: ${config}`);
      // Effect-based application logic
    })
  )
);
```

## CLI Usage

```bash
# Basic usage
hag

# With options
hag --config my_config.yaml

# Validate configuration
hag validate --config my_config.yaml

# Show status
hag status

# Manual override with Effect error handling
hag override heat --temperature 22
```

## Development

### Project Structure

```
src/
├── config/          # Effect Schema configuration
├── core/            # Effect-native utilities and tagged errors
├── home-assistant/  # Effect-wrapped HA client
├── hvac/           # HVAC logic with Effect patterns
│   ├── strategies/ # Effect-based heating/cooling strategies
│   └── tools/      # Effect-wrapped LangChain tools
├── types/          # TypeScript type definitions
└── main.ts         # Effect application entry point
```

### Testing

Effect TestServices for dependency testing:

```bash
# Run all tests
deno task test

# Run specific test file
deno test tests/unit/test_hvac_controller.ts

# Run with Effect test layers
deno test tests/integration/
```

### Effect Patterns

#### Error Handling
```typescript
const safeOperation = pipe(
  dangerousOperation(),
  Effect.catchAll(error => 
    Effect.logError("Operation failed", { error })
    .pipe(Effect.andThen(Effect.fail(new HAGError({ message: "Safe fallback" }))))
  )
);
```

#### Resource Management
```typescript
const withConnection = <A, E>(
  operation: (client: HomeAssistantClient) => Effect.Effect<A, E>
): Effect.Effect<A, E | ConnectionError> =>
  Effect.acquireUseRelease(
    connectToHomeAssistant(),
    operation,
    (client) => client.disconnect()
  );
```

#### Concurrent Operations
```typescript
const parallelChecks = Effect.all([
  getIndoorTemperature(),
  getOutdoorTemperature(),
  getSystemStatus()
], { concurrency: "unbounded" });
```

## Effect-TS Benefits

1. **Type Safety**: Compile-time guarantees for error handling
2. **Functional Patterns**: Immutable data structures and pure functions
3. **Resource Safety**: Automatic resource cleanup with acquire/release
4. **Concurrency**: Safe concurrent operations with Fiber system
5. **Testability**: Easy mocking with TestServices and Layers
6. **Composability**: Modular effects that compose naturally

## Migration from JavaScript Variant

Key differences from the traditional variant:

1. **No dependency injection framework** - Use Effect Context/Layer
2. **No try/catch blocks** - Use Effect error handling
3. **No manual resource cleanup** - Use Effect resource management
4. **No callback-based async** - Use Effect with proper scheduling
5. **No mutable state** - Use Effect Ref for shared state

## License

Same as parent HAG project.