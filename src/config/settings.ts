/**
 * Configuration settings for HAG Effect-TS variant using Effect Schema.
 * 
 * Type-safe configuration schemas with Effect-native validation.
 */

import * as S from '@effect/schema/Schema';
import { SystemMode, LogLevel } from '../types/common.ts';

/**
 * Home Assistant connection options schema
 */
export const HassOptionsSchema = S.struct({
  wsUrl: S.string.pipe(
    S.pattern(/^wss?:\/\/.+/),
    S.description('WebSocket URL for Home Assistant')
  ),
  restUrl: S.string.pipe(
    S.pattern(/^https?:\/\/.+/),
    S.description('REST API URL for Home Assistant')
  ),
  token: S.string.pipe(
    S.minLength(1),
    S.description('Long-lived access token')
  ),
  maxRetries: S.number.pipe(
    S.int(),
    S.positive(),
    S.withDefault(() => 5),
    S.description('Maximum connection retry attempts')
  ),
  retryDelayMs: S.number.pipe(
    S.int(),
    S.positive(),
    S.withDefault(() => 1000),
    S.description('Delay between retries in milliseconds')
  ),
  stateCheckInterval: S.number.pipe(
    S.int(),
    S.positive(),
    S.withDefault(() => 300000),
    S.description('State check interval in milliseconds')
  ),
});

/**
 * Temperature threshold configuration schema with cross-field validation
 */
export const TemperatureThresholdsSchema = S.struct({
  indoorMin: S.number.pipe(
    S.between(-50, 60),
    S.description('Minimum indoor temperature')
  ),
  indoorMax: S.number.pipe(
    S.between(-50, 60),
    S.description('Maximum indoor temperature')
  ),
  outdoorMin: S.number.pipe(
    S.between(-50, 60),
    S.description('Minimum outdoor temperature for operation')
  ),
  outdoorMax: S.number.pipe(
    S.between(-50, 60),
    S.description('Maximum outdoor temperature for operation')
  ),
}).pipe(
  S.filter((data) => data.indoorMin < data.indoorMax, {
    message: () => 'Indoor min temperature must be less than max temperature',
  }),
  S.filter((data) => data.outdoorMin < data.outdoorMax, {
    message: () => 'Outdoor min temperature must be less than max temperature',
  })
);

/**
 * Defrost cycle configuration schema
 */
export const DefrostOptionsSchema = S.struct({
  temperatureThreshold: S.number.pipe(
    S.withDefault(() => 0.0),
    S.description('Temperature below which defrost is needed')
  ),
  periodSeconds: S.number.pipe(
    S.int(),
    S.positive(),
    S.withDefault(() => 3600),
    S.description('Defrost cycle period in seconds')
  ),
  durationSeconds: S.number.pipe(
    S.int(),
    S.positive(),
    S.withDefault(() => 300),
    S.description('Defrost cycle duration in seconds')
  ),
});

/**
 * Heating configuration schema
 */
export const HeatingOptionsSchema = S.struct({
  temperature: S.number.pipe(
    S.between(10, 35),
    S.withDefault(() => 21.0),
    S.description('Target heating temperature')
  ),
  presetMode: S.string.pipe(
    S.withDefault(() => 'comfort'),
    S.description('Heating preset mode')
  ),
  temperatureThresholds: TemperatureThresholdsSchema,
  defrost: S.optional(DefrostOptionsSchema).pipe(
    S.description('Defrost configuration')
  ),
});

/**
 * Cooling configuration schema
 */
export const CoolingOptionsSchema = S.struct({
  temperature: S.number.pipe(
    S.between(15, 35),
    S.withDefault(() => 24.0),
    S.description('Target cooling temperature')
  ),
  presetMode: S.string.pipe(
    S.withDefault(() => 'eco'),
    S.description('Cooling preset mode')
  ),
  temperatureThresholds: TemperatureThresholdsSchema,
});

/**
 * Active hours configuration schema
 */
export const ActiveHoursSchema = S.struct({
  start: S.number.pipe(
    S.int(),
    S.between(0, 23),
    S.withDefault(() => 8),
    S.description('Start hour (24h format)')
  ),
  startWeekday: S.number.pipe(
    S.int(),
    S.between(0, 23),
    S.withDefault(() => 7),
    S.description('Weekday start hour')
  ),
  end: S.number.pipe(
    S.int(),
    S.between(0, 23),
    S.withDefault(() => 22),
    S.description('End hour (24h format)')
  ),
});

/**
 * HVAC entity configuration schema
 */
export const HvacEntitySchema = S.struct({
  entityId: S.string.pipe(
    S.pattern(/^[a-z_]+\.[a-z0-9_]+$/),
    S.description('Home Assistant entity ID in format "domain.entity"')
  ),
  enabled: S.boolean.pipe(
    S.withDefault(() => true),
    S.description('Whether entity is enabled')
  ),
  defrost: S.boolean.pipe(
    S.withDefault(() => false),
    S.description('Whether entity supports defrost')
  ),
});

/**
 * HVAC system configuration schema
 */
export const HvacOptionsSchema = S.struct({
  tempSensor: S.string.pipe(
    S.pattern(/^sensor\..+/),
    S.description('Temperature sensor entity ID')
  ),
  outdoorSensor: S.string.pipe(
    S.pattern(/^sensor\..+/),
    S.withDefault(() => 'sensor.openweathermap_temperature'),
    S.description('Outdoor temperature sensor')
  ),
  systemMode: S.literal(SystemMode.AUTO, SystemMode.HEAT_ONLY, SystemMode.COOL_ONLY, SystemMode.OFF).pipe(
    S.withDefault(() => SystemMode.AUTO),
    S.description('System operation mode')
  ),
  hvacEntities: S.array(HvacEntitySchema).pipe(
    S.withDefault(() => []),
    S.description('HVAC entities to control')
  ),
  heating: HeatingOptionsSchema,
  cooling: CoolingOptionsSchema,
  activeHours: S.optional(ActiveHoursSchema).pipe(
    S.description('Active hours configuration')
  ),
});

/**
 * Application-level configuration schema
 */
export const ApplicationOptionsSchema = S.struct({
  logLevel: S.literal(LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARNING, LogLevel.ERROR).pipe(
    S.withDefault(() => LogLevel.INFO),
    S.description('Logging level')
  ),
  useAi: S.boolean.pipe(
    S.withDefault(() => false),
    S.description('Enable AI agent for HVAC decisions')
  ),
  aiModel: S.string.pipe(
    S.withDefault(() => 'gpt-4o-mini'),
    S.description('AI model to use')
  ),
  aiTemperature: S.number.pipe(
    S.between(0, 2),
    S.withDefault(() => 0.1),
    S.description('AI model temperature')
  ),
  openaiApiKey: S.optional(S.string).pipe(
    S.description('OpenAI API key for AI agent')
  ),
});

/**
 * Main application settings schema
 */
export const SettingsSchema = S.struct({
  appOptions: ApplicationOptionsSchema.pipe(
    S.withDefault(() => ({}))
  ),
  hassOptions: HassOptionsSchema,
  hvacOptions: HvacOptionsSchema,
});

// Export types inferred from schemas using Effect Schema
export type HassOptions = S.Schema.Type<typeof HassOptionsSchema>;
export type TemperatureThresholds = S.Schema.Type<typeof TemperatureThresholdsSchema>;
export type DefrostOptions = S.Schema.Type<typeof DefrostOptionsSchema>;
export type HeatingOptions = S.Schema.Type<typeof HeatingOptionsSchema>;
export type CoolingOptions = S.Schema.Type<typeof CoolingOptionsSchema>;
export type ActiveHours = S.Schema.Type<typeof ActiveHoursSchema>;
export type HvacEntity = S.Schema.Type<typeof HvacEntitySchema>;
export type HvacOptions = S.Schema.Type<typeof HvacOptionsSchema>;
export type ApplicationOptions = S.Schema.Type<typeof ApplicationOptionsSchema>;
export type Settings = S.Schema.Type<typeof SettingsSchema>;

/**
 * Default configuration factory functions
 */
export const DefaultSettings = {
  appOptions: (): ApplicationOptions => ({
    logLevel: LogLevel.INFO,
    useAi: false,
    aiModel: 'gpt-3.5-turbo',
    aiTemperature: 0.1,
  }),

  hassOptions: (wsUrl: string, restUrl: string, token: string): HassOptions => ({
    wsUrl,
    restUrl,
    token,
    maxRetries: 5,
    retryDelayMs: 1000,
    stateCheckInterval: 300000,
  }),

  activeHours: (): ActiveHours => ({
    start: 8,
    startWeekday: 7,
    end: 22,
  }),

  temperatureThresholds: (
    indoorMin: number,
    indoorMax: number,
    outdoorMin: number,
    outdoorMax: number,
  ): TemperatureThresholds => ({
    indoorMin,
    indoorMax,
    outdoorMin,
    outdoorMax,
  }),

  defrostOptions: (): DefrostOptions => ({
    temperatureThreshold: 0.0,
    periodSeconds: 3600,
    durationSeconds: 300,
  }),
} as const;