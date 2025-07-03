/**
 * Dependency management for HAG Effect-TS variant.
 * 
 * Uses Effect Context/Layer system for functional dependency injection.
 */

import { Effect, Context, Layer, Logger, LogLevel, pipe } from 'effect';
import { NodeHttpClient } from '@effect/platform-node';
import { Settings, HvacOptions, HassOptions, ApplicationOptions } from '../config/settings_simple.ts';
import { ConfigLoader } from '../config/loader.ts';
import { ConfigurationError, ErrorUtils } from '../core/exceptions.ts';
import { HVACControllerLive } from '../hvac/controller.ts';
import { HVACStateMachineLive } from '../hvac/state-machine.ts';
import { HomeAssistantClientLive } from '../home-assistant/client.ts';
// import { HVACAgent } from '../ai/agent.ts'; // Optional AI agent

/**
 * Configuration Context tags
 */
export class SettingsService extends Context.Tag('SettingsService')<
  SettingsService,
  Settings
>() {}

export class HvacOptionsService extends Context.Tag('HvacOptionsService')<
  HvacOptionsService,
  HvacOptions
>() {}

export class HassOptionsService extends Context.Tag('HassOptionsService')<
  HassOptionsService,
  HassOptions
>() {}

export class ApplicationOptionsService extends Context.Tag('ApplicationOptionsService')<
  ApplicationOptionsService,
  ApplicationOptions
>() {}

/**
 * Core services Context tags
 */
export class LoggerService extends Context.Tag('LoggerService')<
  LoggerService,
  {
    readonly info: (message: string, data?: Record<string, unknown>) => Effect.Effect<void, never>;
    readonly error: (message: string, error?: unknown) => Effect.Effect<void, never>;
    readonly debug: (message: string, data?: Record<string, unknown>) => Effect.Effect<void, never>;
    readonly warning: (message: string, data?: Record<string, unknown>) => Effect.Effect<void, never>;
  }
>() {}

export class ConfigService extends Context.Tag('ConfigService')<
  ConfigService,
  {
    readonly getSettings: () => Effect.Effect<Settings, never>;
    readonly getHvacOptions: () => Effect.Effect<HvacOptions, never>;
    readonly getHassOptions: () => Effect.Effect<HassOptions, never>;
    readonly getApplicationOptions: () => Effect.Effect<ApplicationOptions, never>;
    readonly updateSettings: (newSettings: Partial<Settings>) => Effect.Effect<void, ConfigurationError>;
  }
>() {}

/**
 * Configuration layers
 */

/**
 * Settings layer that loads configuration
 */
export const SettingsLayer = Layer.effect(
  SettingsService,
  Effect.gen(function* () {
    const configPath = yield* Effect.fromNullable(Deno.env.get('HAG_CONFIG_FILE')).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    const settings = yield* ConfigLoader.loadSettings(configPath);
    
    yield* Effect.logInfo('Configuration loaded successfully', {
      systemMode: settings.hvacOptions.systemMode,
      aiEnabled: settings.appOptions.useAi,
    });
    
    return settings;
  })
);

/**
 * HVAC options layer derived from settings
 */
export const HvacOptionsLayer = Layer.effect(
  HvacOptionsService,
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    return settings.hvacOptions;
  })
);

/**
 * Home Assistant options layer derived from settings
 */
export const HassOptionsLayer = Layer.effect(
  HassOptionsService,
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    return settings.hassOptions;
  })
);

/**
 * Application options layer derived from settings
 */
export const ApplicationOptionsLayer = Layer.effect(
  ApplicationOptionsService,
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    return settings.appOptions;
  })
);

/**
 * Logger layer with configuration-based log level
 */
export const LoggerLayer = Layer.effect(
  LoggerService,
  Effect.gen(function* () {
    const appOptions = yield* ApplicationOptionsService;
    
    // Map string log level to Effect LogLevel
    const effectLogLevel = (() => {
      switch (appOptions.logLevel.toLowerCase()) {
        case 'debug': return LogLevel.Debug;
        case 'info': return LogLevel.Info;
        case 'warning': return LogLevel.Warning;
        case 'error': return LogLevel.Error;
        default: return LogLevel.Info;
      }
    })();

    // Create logger with configured level
    const _logger = Logger.make(({ logLevel, message, ...rest }) => {
      const timestamp = new Date().toISOString();
      const levelName = logLevel;
      const formattedMessage = `[${timestamp}] ${levelName} ${message}`;
      
      if (Object.keys(rest).length > 0) {
        console.log(formattedMessage, rest);
      } else {
        console.log(formattedMessage);
      }
    });

    return LoggerService.of({
      info: (message: string, data?: Record<string, unknown>) =>
        pipe(
          Effect.logInfo(message, data),
          Logger.withMinimumLogLevel(effectLogLevel)
        ),
      
      error: (message: string, error?: unknown, data?: Record<string, unknown>) =>
        pipe(
          Effect.logError(message, { error, ...data }),
          Logger.withMinimumLogLevel(effectLogLevel)
        ),
      
      debug: (message: string, data?: Record<string, unknown>) =>
        pipe(
          Effect.logDebug(message, data),
          Logger.withMinimumLogLevel(effectLogLevel)
        ),
      
      warning: (message: string, data?: Record<string, unknown>) =>
        pipe(
          Effect.logWarning(message, data),
          Logger.withMinimumLogLevel(effectLogLevel)
        ),
    });
  })
);

/**
 * Configuration service layer
 */
export const ConfigServiceLayer = Layer.effect(
  ConfigService,
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    const hvacOptions = yield* HvacOptionsService;
    const hassOptions = yield* HassOptionsService;
    const appOptions = yield* ApplicationOptionsService;
    
    return ConfigService.of({
      getSettings: () => Effect.succeed(settings),
      
      getHvacOptions: () => Effect.succeed(hvacOptions),
      
      getHassOptions: () => Effect.succeed(hassOptions),
      
      getApplicationOptions: () => Effect.succeed(appOptions),
      
      updateSettings: (newSettings: Partial<Settings>) =>
        Effect.gen(function* () {
          const updatedSettings = { ...settings, ...newSettings };
          
          // Validate updated settings
          yield* Effect.try({
            try: () => {
              // Here we would re-validate the merged settings
              // For now, we'll just return the updated settings
              return updatedSettings;
            },
            catch: (error) => ErrorUtils.configError(
              `Settings update validation failed: ${error}`,
              'update',
              newSettings
            ),
          });
          
          yield* Effect.logInfo('Settings updated', { 
            updated: Object.keys(newSettings) 
          });
        }),
    });
  })
);

/**
 * Core layers combined
 */
export const CoreLayer = pipe(
  Layer.mergeAll(
    SettingsLayer,
    HvacOptionsLayer,
    HassOptionsLayer,
    ApplicationOptionsLayer,
  ),
  Layer.merge(LoggerLayer),
  Layer.merge(ConfigServiceLayer)
);

/**
 * Application container using Effect Layer composition
 */
export class ApplicationContainer {
  private runtime?: unknown;
  
  /**
   * Initialize the application with layers
   */
  static initialize = (configPath?: string): Effect.Effect<ApplicationContainer, ConfigurationError> =>
    Effect.gen(function* () {
      // Set config path if provided
      if (configPath) {
        Deno.env.set('HAG_CONFIG_FILE', configPath);
      }
      
      // Create runtime with core layers
      const runtime = yield* Effect.runtime<never>();
      
      yield* Effect.logInfo('✅ Application container initialized successfully');
      
      return new ApplicationContainer(runtime);
    });

  private constructor(runtime: unknown) {
    this.runtime = runtime;
  }

  /**
   * Run an effect with the application context
   */
  run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
    if (!this.runtime) {
      throw new Error('Container not initialized');
    }
    return Effect.runPromise(effect);
  };

  /**
   * Run an effect and handle errors
   */
  runSafe = <A, E>(effect: Effect.Effect<A, E>): Promise<A | null> =>
    this.run(
      pipe(
        effect,
        Effect.catchAll((error) =>
          pipe(
            Effect.logError('Effect execution failed', { error }),
            Effect.andThen(Effect.succeed(null))
          )
        )
      )
    );

  /**
   * Get service from context
   */
  getService = <A>(_tag: Context.Tag<string, A>): Effect.Effect<A, never> =>
    Effect.fail("Service resolution not implemented" as never);

  /**
   * Get settings
   */
  getSettings = (): Effect.Effect<Settings, never> =>
    Effect.fail("Settings not available in container mode" as never);

  /**
   * Dispose of resources
   */
  dispose = (): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      // Cleanup logic would go here
      // For example, stopping services, closing connections, etc.
      
      yield* Effect.logInfo('✅ Application container disposed successfully');
    });
}

/**
 * Global container instance
 */
let globalContainer: ApplicationContainer | undefined;

/**
 * Create and initialize application container
 */
export const createContainer = (configPath?: string): Effect.Effect<ApplicationContainer, ConfigurationError> =>
  Effect.gen(function* () {
    // Dispose existing container if any
    if (globalContainer) {
      yield* globalContainer.dispose();
    }
    
    // Initialize new container
    const container = yield* ApplicationContainer.initialize(configPath);
    globalContainer = container;
    
    return container;
  });

/**
 * Get global container instance
 */
export const getContainer = (): Effect.Effect<ApplicationContainer, ConfigurationError> =>
  Effect.gen(function* () {
    if (!globalContainer) {
      yield* Effect.fail(
        ErrorUtils.configError(
          'Container not initialized. Call createContainer() first.',
          'container'
        )
      );
    }
    
    return globalContainer!;
  });

/**
 * Dispose global container
 */
export const disposeContainer = (): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    if (globalContainer) {
      yield* globalContainer.dispose();
      globalContainer = undefined;
    }
  });

/**
 * Utility to run effects with automatic container setup
 */
export const runWithContainer = <A, E>(
  effect: Effect.Effect<A, E>,
  configPath?: string
): Effect.Effect<A, E | ConfigurationError> =>
  Effect.gen(function* () {
    const container = yield* createContainer(configPath);
    
    try {
      return yield* Effect.promise(() => container.run(effect));
    } finally {
      yield* container.dispose();
    }
  });

/**
 * Main application layers for dependency injection
 */
export const MainLayer = pipe(
  CoreLayer,
  Layer.merge(NodeHttpClient.layer),
  Layer.merge(HomeAssistantClientLive),
  Layer.merge(HVACStateMachineLive),
  Layer.merge(HVACControllerLive),
  // Conditionally merge AI layer if AI is enabled
  Layer.merge(Layer.effect(
    HVACAgent,
    Effect.gen(function* () {
      const appOptions = yield* ApplicationOptionsService;
      if (appOptions.useAi) {
        return yield* HVACAgentLive;
      } else {
        return HVACAgent.of({
          processTemperatureChange: () => Effect.fail(ErrorUtils.aiError("AI agent is not enabled")),
          manualOverride: () => Effect.fail(ErrorUtils.aiError("AI agent is not enabled")),
          evaluateEfficiency: () => Effect.fail(ErrorUtils.aiError("AI agent is not enabled")),
          getStatusSummary: () => Effect.succeed({ success: false, error: "AI agent is not enabled" }),
          clearHistory: () => Effect.void,
          getHistoryLength: () => Effect.succeed(0),
        });
      }
    })
  ))
);