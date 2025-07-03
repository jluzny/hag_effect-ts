
import * as S from '@effect/schema/Schema';
import { SystemMode, LogLevel } from '../types/common.ts';

/**
 * Home Assistant connection options schema
 */
export const HassOptionsSchema = S.Struct({
  wsUrl: S.String.pipe(S.pattern(/^wss?:\/\//, { message: () => 'WebSocket URL must start with ws:// or wss://' })),
  restUrl: S.String.pipe(S.pattern(/^https?:\/\//, { message: () => 'REST API URL must start with http:// or https://' })),
  token: S.String.pipe(S.minLength(1)),
  maxRetries: S.Number.pipe(S.int(), S.positive(), S.withDefault(() => 5)),
  retryDelayMs: S.Number.pipe(S.int(), S.positive(), S.withDefault(() => 1000)),
  stateCheckInterval: S.Number.pipe(S.int(), S.positive(), S.withDefault(() => 300000)),
});

/**
 * Temperature threshold configuration schema
 */
export const TemperatureThresholdsSchema = S.Struct({
  indoorMin: S.Number.pipe(S.between(-50, 60)),
  indoorMax: S.Number.pipe(S.between(-50, 60)),
  outdoorMin: S.Number.pipe(S.between(-50, 60)),
  outdoorMax: S.Number.pipe(S.between(-50, 60)),
}).pipe(
    S.filter(data => data.indoorMin < data.indoorMax, { message: () => 'Indoor min temperature must be less than max temperature' }),
    S.filter(data => data.outdoorMin < data.outdoorMax, { message: () => 'Outdoor min temperature must be less than max temperature' })
);

/**
 * Defrost cycle configuration schema
 */
export const DefrostOptionsSchema = S.Struct({
  temperatureThreshold: S.Number.pipe(S.withDefault(() => 0.0)),
  periodSeconds: S.Number.pipe(S.int(), S.positive(), S.withDefault(() => 3600)),
  durationSeconds: S.Number.pipe(S.int(), S.positive(), S.withDefault(() => 300)),
});

/**
 * Heating configuration schema
 */
export const HeatingOptionsSchema = S.Struct({
  temperature: S.Number.pipe(S.between(10, 35), S.withDefault(() => 21.0)),
  presetMode: S.String.pipe(S.withDefault(() => 'comfort')),
  temperatureThresholds: TemperatureThresholdsSchema,
  defrost: S.optional(DefrostOptionsSchema, {exact: true}),
});

/**
 * Cooling configuration schema
 */
export const CoolingOptionsSchema = S.Struct({
  temperature: S.Number.pipe(S.between(15, 35), S.withDefault(() => 24.0)),
  presetMode: S.String.pipe(S.withDefault(() => 'eco')),
  temperatureThresholds: TemperatureThresholdsSchema,
});

/**
 * Active hours configuration schema
 */
export const ActiveHoursSchema = S.Struct({
  start: S.Number.pipe(S.int(), S.between(0, 23), S.withDefault(() => 8)),
  startWeekday: S.Number.pipe(S.int(), S.between(0, 23), S.withDefault(() => 7)),
  end: S.Number.pipe(S.int(), S.between(0, 23), S.withDefault(() => 22)),
});

/**
 * HVAC entity configuration schema
 */
export const HvacEntitySchema = S.Struct({
    entityId: S.String.pipe(S.filter(val => val.includes('.'), { message: () => 'Entity ID must be in format "domain.entity"' })),
    enabled: S.Boolean.pipe(S.withDefault(() => true)),
    defrost: S.Boolean.pipe(S.withDefault(() => false)),
});

/**
 * HVAC system configuration schema
 */
export const HvacOptionsSchema = S.Struct({
  tempSensor: S.String.pipe(S.startsWith('sensor.'), { message: () => 'Temperature sensor must be a sensor entity' }),
  outdoorSensor: S.String.pipe(S.startsWith('sensor.'), S.withDefault(() => 'sensor.openweathermap_temperature'), { message: () => 'Outdoor sensor must be a sensor entity' }),
  systemMode: S.Enums(SystemMode).pipe(S.withDefault(() => SystemMode.AUTO)),
  hvacEntities: S.Array(HvacEntitySchema).pipe(S.withDefault(() => [])),
  heating: HeatingOptionsSchema,
  cooling: CoolingOptionsSchema,
  activeHours: S.optional(ActiveHoursSchema, {exact: true}),
});

/**
 * Application-level configuration schema
 */
export const ApplicationOptionsSchema = S.Struct({
  logLevel: S.Enums(LogLevel).pipe(S.withDefault(() => LogLevel.DEBUG)),
  useAi: S.Boolean.pipe(S.withDefault(() => false)),
  aiModel: S.String.pipe(S.withDefault(() => 'gpt-4o-mini')),
  aiTemperature: S.Number.pipe(S.between(0, 2), S.withDefault(() => 0.1)),
  openaiApiKey: S.optional(S.String, {exact: true}),
  dryRun: S.Boolean.pipe(S.withDefault(() => false)),
});

/**
 * Main application settings schema
 */
export const SettingsSchema = S.Struct({
  appOptions: S.optional(ApplicationOptionsSchema, {default: () => ({})}),
  hassOptions: HassOptionsSchema,
  hvacOptions: HvacOptionsSchema,
});

// Export types inferred from schemas
export interface HassOptions extends S.Schema.Type<typeof HassOptionsSchema> {}
export interface TemperatureThresholds extends S.Schema.Type<typeof TemperatureThresholdsSchema> {}
export interface DefrostOptions extends S.Schema.Type<typeof DefrostOptionsSchema> {}
export interface HeatingOptions extends S.Schema.Type<typeof HeatingOptionsSchema> {}
export interface CoolingOptions extends S.Schema.Type<typeof CoolingOptionsSchema> {}
export interface ActiveHours extends S.Schema.Type<typeof ActiveHoursSchema> {}
export interface HvacEntity extends S.Schema.Type<typeof HvacEntitySchema> {}
export interface HvacOptions extends S.Schema.Type<typeof HvacOptionsSchema> {}
export interface ApplicationOptions extends S.Schema.Type<typeof ApplicationOptionsSchema> {}
export interface Settings extends S.Schema.Type<typeof SettingsSchema> {}
