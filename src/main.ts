/**
 * Main application entry point for HAG Effect-TS variant.
 * 
 * CLI application using @effect/cli with Effect-native patterns.
 */

import { Effect, Context, Layer, pipe, Exit } from 'effect';
import { Command, Args, Options } from '@effect/cli';
import { Terminal } from '@effect/terminal';
import { NodeContext, NodeRuntime } from '@effect/platform-node';
import { createContainer, disposeContainer, ApplicationContainer } from './core/container.ts';
import { HVACController } from './hvac/controller.ts';
import { ConfigLoader } from './config/loader.ts';
import { LoggerService } from './core/container.ts';
import { ErrorUtils } from './core/exceptions.ts';

/**
 * Global container reference
 */
let container: ApplicationContainer | undefined;

/**
 * Cleanup handler
 */
const cleanup = (): Effect.Effect<void, never> =>
  pipe(
    Effect.gen(function* () {
      if (container) {
        yield* container.dispose();
        container = undefined;
      }
    }),
    Effect.catchAll(() => Effect.void)
  );

/**
 * Setup cleanup handlers
 */
const setupCleanup = (): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    // Handle process termination
    process.on('SIGINT', () => {
      console.log('\n🛑 Received SIGINT, shutting down gracefully...');
      Effect.runPromise(cleanup()).finally(() => process.exit(0));
    });

    process.on('SIGTERM', () => {
      console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
      Effect.runPromise(cleanup()).finally(() => process.exit(0));
    });

    // Handle unhandled errors
    process.on('unhandledRejection', (reason) => {
      console.error('❌ Unhandled promise rejection:', reason);
      Effect.runPromise(cleanup()).finally(() => process.exit(1));
    });

    process.on('uncaughtException', (error) => {
      console.error('❌ Uncaught exception:', error);
      Effect.runPromise(cleanup()).finally(() => process.exit(1));
    });
  });

/**
 * Run HAG application
 */
const runApplication = (configPath?: string): Effect.Effect<void, never> =>
  pipe(
    Effect.gen(function* () {
      // Setup cleanup handlers
      yield* setupCleanup();
      
      // Create and initialize container
      container = yield* createContainer(configPath);
      
      // Get HVAC controller
      const controller = yield* container.getService(HVACController);
      
      // Start the controller
      yield* controller.start;
      
      yield* Effect.log('🏠 HAG HVAC automation is running...');
      yield* Effect.log('📊 Press Ctrl+C to stop gracefully');
      
      // Keep the application running
      yield* Effect.forever(Effect.sleep('1 second'));
    }),
    Effect.catchAll((error) =>
      pipe(
        Effect.logError('❌ Application failed', { error }),
        Effect.andThen(cleanup()),
        Effect.andThen(Effect.succeed(undefined))
      )
    ),
    Effect.asVoid
  );

/**
 * Validate configuration command
 */
const validateConfig = (configPath: string): Effect.Effect<void, never> =>
  pipe(
    ConfigLoader.validateConfigFile(configPath),
    Effect.flatMap((result) => {
      if (result.valid && result.config) {
        return pipe(
          Effect.log(`✅ Configuration is valid: ${configPath}`),
          Effect.andThen(Effect.log(`   Log level: ${result.config.appOptions.logLevel}`)),
          Effect.andThen(Effect.log(`   AI enabled: ${result.config.appOptions.useAi}`)),
          Effect.andThen(Effect.log(`   Temperature sensor: ${result.config.hvacOptions.tempSensor}`)),
          Effect.andThen(Effect.log(`   System mode: ${result.config.hvacOptions.systemMode}`)),
          Effect.andThen(Effect.log(`   HVAC entities: ${result.config.hvacOptions.hvacEntities.length}`))
        );
      } else {
        return pipe(
          Effect.log(`❌ Configuration validation failed: ${configPath}`),
          Effect.andThen(() => {
            if (result.errors) {
              return Effect.all(
                result.errors.map(error => Effect.log(`   Error: ${error}`)),
                { concurrency: 'unbounded' }
              );
            }
            return Effect.void;
          }),
          Effect.andThen(Effect.die('Configuration validation failed'))
        );
      }
    }),
    Effect.catchAll((error) =>
      pipe(
        Effect.logError('❌ Configuration validation error', { error }),
        Effect.andThen(Effect.die('Configuration validation error'))
      )
    ),
    Effect.asVoid
  );

/**
 * Get system status
 */
const getStatus = (configPath?: string): Effect.Effect<void, never> =>
  pipe(
    Effect.gen(function* () {
      container = yield* createContainer(configPath);
      const controller = yield* container.getService(HVACController);
      
      // Start controller briefly to get status
      yield* controller.start;
      const status = yield* controller.getStatus;
      yield* controller.stop;
      
      yield* Effect.log('\n📊 HAG System Status');
      yield* Effect.log('=' + '='.repeat(29));
      yield* Effect.log(`Controller Running: ${status.controller.running}`);
      yield* Effect.log(`HA Connected: ${status.controller.haConnected}`);
      yield* Effect.log(`Temperature Sensor: ${status.controller.tempSensor}`);
      yield* Effect.log(`System Mode: ${status.controller.systemMode}`);
      yield* Effect.log(`AI Enabled: ${status.controller.aiEnabled}`);
      
      if (status.stateMachine) {
        yield* Effect.log(`\nState Machine: ${status.stateMachine.currentState}`);
        if (status.stateMachine.hvacMode) {
          yield* Effect.log(`HVAC Mode: ${status.stateMachine.hvacMode}`);
        }
        
        if (status.stateMachine.conditions) {
          const conditions = status.stateMachine.conditions;
          if (conditions.indoorTemp) {
            yield* Effect.log(`Indoor Temp: ${conditions.indoorTemp}°C`);
          }
          if (conditions.outdoorTemp) {
            yield* Effect.log(`Outdoor Temp: ${conditions.outdoorTemp}°C`);
          }
        }
      }
      
      if (status.aiAnalysis) {
        yield* Effect.log(`\nAI Analysis:\n${status.aiAnalysis}`);
      }
    }),
    Effect.catchAll((error) =>
      pipe(
        Effect.logError('❌ Failed to get status', { error }),
        Effect.andThen(Effect.die('Failed to get status'))
      )
    ),
    Effect.asVoid
  );

/**
 * Manual override command
 */
const manualOverride = (
  action: string,
  configPath?: string,
  temperature?: number
): Effect.Effect<void, never> =>
  pipe(
    Effect.gen(function* () {
      container = yield* createContainer(configPath);
      const controller = yield* container.getService(HVACController);
      
      yield* controller.start;
      
      const options: Record<string, unknown> = {};
      if (temperature !== undefined) {
        options.temperature = temperature;
      }
      
      const result = yield* controller.manualOverride(action, options);
      
      if (result.success) {
        yield* Effect.log(`✅ Manual override successful: ${action}`);
        if (temperature) {
          yield* Effect.log(`   Target temperature: ${temperature}°C`);
        }
      } else {
        yield* Effect.log(`❌ Manual override failed: ${result.error}`);
        yield* Effect.die('Manual override failed');
      }
      
      yield* controller.stop;
    }),
    Effect.catchAll((error) =>
      pipe(
        Effect.logError('❌ Manual override error', { error }),
        Effect.andThen(Effect.die('Manual override error'))
      )
    ),
    Effect.asVoid
  );

/**
 * Show environment information
 */
const showEnvironment = (): Effect.Effect<void, never> =>
  pipe(
    ConfigLoader.getEnvironmentInfo(),
    Effect.map((envInfo) => {
      console.log('\n🌍 Environment Information');
      console.log('=' + '='.repeat(26));
      console.log('Deno:', JSON.stringify(envInfo.deno, null, 2));
      console.log('Platform:', JSON.stringify(envInfo.platform, null, 2));
      console.log('Environment:', JSON.stringify(envInfo.environment, null, 2));
    }),
    Effect.asVoid
  );

/**
 * CLI Options
 */
const configOption = Options.file('config').pipe(
  Options.withAlias('c'),
  Options.withDescription('Configuration file path'),
  Options.optional
);

const logLevelOption = Options.text('log-level').pipe(
  Options.withDescription('Log level (debug, info, warning, error)'),
  Options.withDefault('info')
);

const temperatureOption = Options.integer('temperature').pipe(
  Options.withAlias('t'),
  Options.withDescription('Target temperature'),
  Options.optional
);

/**
 * CLI Commands
 */

// Main run command
const runCommand = Command.make('run', {
  options: Effect.struct({
    config: configOption,
    logLevel: logLevelOption,
  }),
}).pipe(
  Command.withDescription('Run HAG HVAC automation'),
  Command.withHandler(({ config }) => runApplication(config))
);

// Validate configuration command
const validateCommand = Command.make('validate', {
  options: Effect.struct({
    config: Options.file('config').pipe(
      Options.withAlias('c'),
      Options.withDescription('Configuration file path')
    ),
  }),
}).pipe(
  Command.withDescription('Validate configuration file'),
  Command.withHandler(({ config }) => validateConfig(config))
);

// Status command
const statusCommand = Command.make('status', {
  options: Effect.struct({
    config: configOption,
  }),
}).pipe(
  Command.withDescription('Get system status'),
  Command.withHandler(({ config }) => getStatus(config))
);

// Manual override command
const overrideCommand = Command.make('override', {
  args: Args.text('action').pipe(
    Args.withDescription('HVAC action (heat, cool, off)')
  ),
  options: Effect.struct({
    config: configOption,
    temperature: temperatureOption,
  }),
}).pipe(
  Command.withDescription('Manual HVAC override'),
  Command.withHandler(({ action }, { config, temperature }) => 
    manualOverride(action, config, temperature)
  )
);

// Environment info command
const envCommand = Command.make('env').pipe(
  Command.withDescription('Show environment information'),
  Command.withHandler(() => showEnvironment())
);

/**
 * Main CLI application
 */
const cli = Command.make('hag').pipe(
  Command.withDescription('🏠 HAG - Home Assistant aGentic HVAC Automation'),
  Command.withSubcommands([
    runCommand,
    validateCommand,
    statusCommand,
    overrideCommand,
    envCommand,
  ])
);

/**
 * Main application entry point
 */
const main: Effect.Effect<void, never> = pipe(
  cli,
  Command.run({
    name: 'HAG Effect-TS',
    version: '1.0.0',
  }),
  Effect.provide(NodeContext.layer),
  Effect.catchAll((error) =>
    pipe(
      Effect.logError('❌ CLI error', { error }),
      Effect.andThen(cleanup()),
      Effect.andThen(Effect.die('CLI error'))
    )
  )
);

// Run the CLI
if (import.meta.main) {
  pipe(
    main,
    Effect.catchAll((error) =>
      pipe(
        Effect.logError('❌ Application error', { error }),
        Effect.andThen(cleanup()),
        Effect.andThen(Effect.succeed(undefined))
      )
    ),
    NodeRuntime.runMain
  );
}