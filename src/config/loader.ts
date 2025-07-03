/**
 * Configuration loader for HAG Effect-TS variant.
 * 
 * Effect-native configuration loading with proper error handling and validation.
 */

import { Effect, Layer, pipe } from 'effect';
import * as Config from 'effect/Config';
import * as ParseResult from '@effect/schema/ParseResult';
import { parse } from 'yaml';
import { join } from '@std/path';
import { SettingsSchema, Settings, DefaultSettings } from './settings_simple.ts';
import { ConfigurationError, ErrorUtils } from '../core/exceptions.ts';

/**
 * Configuration loader service using Effect
 */
export class ConfigLoader {
  /**
   * Load configuration with Effect-native error handling
   */
  static loadSettings = (configPath?: string): Effect.Effect<Settings, ConfigurationError> =>
    pipe(
      Effect.gen(function* () {
        // Load environment variables
        yield* loadEnvironment();

        // Determine config file path
        const resolvedPath = configPath ?? (yield* findConfigFile());
        yield* Effect.logInfo(`Loading configuration from: ${resolvedPath}`);

        // Load and parse configuration file
        const rawConfig = yield* loadConfigFile(resolvedPath);
        
        // Merge with defaults and apply environment overrides
        const mergedConfig = yield* mergeWithDefaults(rawConfig);
        const configWithEnv = yield* applyEnvironmentOverrides(mergedConfig);
        
        // Validate configuration using Effect Schema
        const validatedConfig = yield* validateConfiguration(configWithEnv);
        
        yield* Effect.logInfo('Configuration loaded and validated successfully');
        return validatedConfig;
      }),
      Effect.catchAll((error) =>
        Effect.fail(
          error instanceof ConfigurationError 
            ? error
            : ErrorUtils.configError(
                `Failed to load configuration: ${error}`,
                'config_file',
                configPath
              )
        )
      )
    );

  /**
   * Validate configuration file without loading full application
   */
  static validateConfigFile = (configPath: string): Effect.Effect<{
    valid: boolean;
    errors?: readonly string[];
    config?: Settings;
  }, never> =>
    pipe(
      ConfigLoader.loadSettings(configPath),
      Effect.map((config) => ({ valid: true, config })),
      Effect.catchAll((error) =>
        Effect.succeed({
          valid: false,
          errors: [error.message] as const,
        })
      )
    );

  /**
   * Get current environment information
   */
  static getEnvironmentInfo = (): Effect.Effect<Record<string, unknown>, never> =>
    Effect.sync(() => ({
      deno: {
        version: Deno.version.deno,
        typescript: Deno.version.typescript,
        v8: Deno.version.v8,
      },
      platform: {
        os: Deno.build.os,
        arch: Deno.build.arch,
      },
      environment: {
        hasOpenAI: !!Deno.env.get('OPENAI_API_KEY'),
        hasLangSmith: !!Deno.env.get('LANGCHAIN_API_KEY'),
        configFile: Deno.env.get('HAG_CONFIG_FILE'),
      },
    }));
}

/**
 * Load environment variables from .env file
 */
const loadEnvironment = (): Effect.Effect<void, never> =>
  pipe(
    Effect.tryPromise({
      try: async () => {
        const { load } = await import('@std/dotenv');
        await load({ export: true });
      },
      catch: (error) => error,
    }),
    Effect.catchAll((error) =>
      pipe(
        Effect.logWarning(`Could not load .env file: ${error}`),
        Effect.asVoid
      )
    )
  );

/**
 * Find configuration file in standard locations
 */
const findConfigFile = (): Effect.Effect<string, ConfigurationError> =>
  Effect.gen(function* () {
    const possiblePaths = [
      Deno.env.get('HAG_CONFIG_FILE'),
      'config/hvac_config.yaml',
      'hvac_config.yaml',
      join(Deno.env.get('HOME') ?? '~', '.config', 'hag', 'hvac_config.yaml'),
      '/etc/hag/hvac_config.yaml',
    ].filter(Boolean) as string[];

    for (const path of possiblePaths) {
      const fileExists = yield* pipe(
        Effect.tryPromise({
          try: () => Deno.stat(path),
          catch: () => null,
        }),
        Effect.map((stat) => stat?.isFile ?? false),
        Effect.catchAll(() => Effect.succeed(false))
      );

      if (fileExists) {
        return path;
      }
    }

    // Default to expected location
    return 'config/hvac_config.yaml';
  });

/**
 * Load and parse YAML configuration file
 */
const loadConfigFile = (configPath: string): Effect.Effect<unknown, ConfigurationError> =>
  pipe(
    Effect.tryPromise({
      try: () => Deno.readTextFile(configPath),
      catch: (error) => error,
    }),
    Effect.flatMap((configText) =>
      Effect.try({
        try: () => parse(resolveEnvironmentVariables(configText)),
        catch: (error) => ErrorUtils.configError(
          `Failed to parse YAML configuration: ${error}`,
          'config_file',
          configPath
        ),
      })
    ),
    Effect.catchAll((error: unknown) => {
      if ((error as { error?: unknown }).error instanceof Deno.errors.NotFound) {
        return Effect.fail(
          ErrorUtils.configError(
            `Configuration file not found: ${configPath}`,
            'config_file',
            configPath
          )
        );
      }
      return Effect.fail(
        ErrorUtils.configError(
          `Failed to read configuration file: ${(error as { error?: unknown }).error}`,'config_file',
          configPath
        )
      );
    })
  );

/**
 * Resolve environment variable placeholders in configuration text
 */
const resolveEnvironmentVariables = (configText: string): string => {
  const envVarPattern = /\$\{([^}]+)\}/g;
  return configText.replace(envVarPattern, (match, envVarName) => {
    const envValue = Deno.env.get(envVarName);
    if (envValue === undefined) {
      Effect.logWarning(`Environment variable not found: ${envVarName}`).pipe(Effect.runSync);
      return match; // Keep the placeholder if not found
    }
    return envValue;
  });
};

/**
 * Merge configuration with default values
 */
const mergeWithDefaults = (config: unknown): Effect.Effect<unknown, never> =>
  Effect.sync(() => {
    const deepMerge = (target: any, source: any) => {
      const output = { ...target };

      if (target && typeof target === 'object' && source && typeof source === 'object') {
        Object.keys(source).forEach(key => {
          if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
            output[key] = deepMerge(target[key], source[key]);
          } else {
            output[key] = source[key];
          }
        });
      }
      return output;
    };

    if (typeof config !== 'object' || config === null) {
      return DefaultSettings;
    }

    return deepMerge(DefaultSettings, config);
  });

/**
 * Apply environment variable overrides
 */
const applyEnvironmentOverrides = (config: unknown): Effect.Effect<unknown, never> =>
  Effect.sync(() => {
    const configObj = config as Record<string, unknown>;
    
    // Home Assistant options
    const hassOptions = { ...(configObj.hassOptions as Record<string, unknown> ?? {}) };
    if (Deno.env.get('HASS_WS_URL')) hassOptions.wsUrl = Deno.env.get('HASS_WS_URL');
    if (Deno.env.get('HASS_REST_URL')) hassOptions.restUrl = Deno.env.get('HASS_REST_URL');
    if (Deno.env.get('HASS_TOKEN')) hassOptions.token = Deno.env.get('HASS_TOKEN');
    if (Deno.env.get('HASS_MAX_RETRIES')) {
      hassOptions.maxRetries = parseInt(Deno.env.get('HASS_MAX_RETRIES')!, 10);
    }

    // Application options
    const appOptions = { ...(configObj.appOptions as Record<string, unknown> ?? {}) };
    if (Deno.env.get('HAG_LOG_LEVEL')) appOptions.logLevel = Deno.env.get('HAG_LOG_LEVEL');
    if (Deno.env.get('HAG_USE_AI')) appOptions.useAi = Deno.env.get('HAG_USE_AI') === 'true';
    if (Deno.env.get('HAG_AI_MODEL')) appOptions.aiModel = Deno.env.get('HAG_AI_MODEL');
    if (Deno.env.get('OPENAI_API_KEY')) appOptions.openaiApiKey = Deno.env.get('OPENAI_API_KEY');
    if (Deno.env.get('HAG_DRY_RUN')) appOptions.dryRun = Deno.env.get('HAG_DRY_RUN') === 'true';

    // HVAC options
    const hvacOptions = { ...(configObj.hvacOptions as Record<string, unknown> ?? {}) };
    if (Deno.env.get('HAG_TEMP_SENSOR')) hvacOptions.tempSensor = Deno.env.get('HAG_TEMP_SENSOR');
    if (Deno.env.get('HAG_OUTDOOR_SENSOR')) hvacOptions.outdoorSensor = Deno.env.get('HAG_OUTDOOR_SENSOR');
    if (Deno.env.get('HAG_SYSTEM_MODE')) hvacOptions.systemMode = Deno.env.get('HAG_SYSTEM_MODE');
    if (Deno.env.get('HAG_HEATING_TEMPERATURE')) hvacOptions.heating = { ...(hvacOptions.heating as Record<string, unknown> ?? {}), temperature: parseFloat(Deno.env.get('HAG_HEATING_TEMPERATURE')!) };
    if (Deno.env.get('HAG_COOLING_TEMPERATURE')) hvacOptions.cooling = { ...(hvacOptions.cooling as Record<string, unknown> ?? {}), temperature: parseFloat(Deno.env.get('HAG_COOLING_TEMPERATURE')!) };

    return { ...configObj, hassOptions, appOptions, hvacOptions };
  });

/**
 * Validate configuration using Effect Schema
 */
const validateConfiguration = (config: unknown): Effect.Effect<Settings, ConfigurationError> =>
  pipe(
    ParseResult.decodeUnknown(SettingsSchema)(config),
    Effect.mapError((parseError) =>
      ErrorUtils.configError(
        `Configuration validation failed: ${parseError.toString()}`,
        'validation',
        config
      )
    )
  );

/**
 * Configuration Layer for dependency injection
 */
export const ConfigLayer = Layer.effectDiscard(
  pipe(
    Config.string('HAG_CONFIG_FILE').pipe(Config.withDefault('')),
    Effect.flatMap((configPath) =>
      ConfigLoader.loadSettings(configPath.length > 0 ? configPath : undefined)
    )
  )
);