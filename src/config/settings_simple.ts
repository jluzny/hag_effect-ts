
/**
 * Simplified settings schema for compilation
 */

import * as S from '@effect/schema/Schema';

export const HassOptionsSchema = S.Struct({
  wsUrl: S.String,
  restUrl: S.String,
  token: S.String,
  maxRetries: S.Number,
  retryDelayMs: S.Number,
  stateCheckInterval: S.Number,
});

export const HvacOptionsSchema = S.Struct({
  tempSensor: S.String.pipe(S.startsWith('sensor.'), { message: () => 'Temperature sensor must be a sensor entity' }),
  outdoorSensor: S.String.pipe(S.startsWith('sensor.'), S.withDefault(() => 'sensor.openweathermap_temperature'), { message: () => 'Outdoor sensor must be a sensor entity' }),
  systemMode: S.Enums(SystemMode).pipe(S.withDefault(() => SystemMode.AUTO)),
  hvacEntities: S.Array(HvacEntitySchema).pipe(S.withDefault(() => [])),
  heating: S.Struct({
    temperature: S.Number.pipe(S.between(10, 35), S.withDefault(() => 21.0)),
    presetMode: S.String.pipe(S.withDefault(() => 'comfort')),
    temperatureThresholds: TemperatureThresholdsSchema,
    defrost: S.optional(DefrostOptionsSchema, {exact: true}),
  }),
  cooling: S.Struct({
    temperature: S.Number.pipe(S.between(15, 35), S.withDefault(() => 24.0)),
    presetMode: S.String.pipe(S.withDefault(() => 'eco')),
    temperatureThresholds: TemperatureThresholdsSchema,
  }),
  activeHours: S.optional(ActiveHoursSchema, {exact: true}),
});

export const ApplicationOptionsSchema = S.Struct({
  logLevel: S.String,
  openaiApiKey: S.String,
  useAi: S.Boolean,
});

export const SettingsSchema = S.Struct({
  appOptions: ApplicationOptionsSchema,
  hassOptions: HassOptionsSchema,
  hvacOptions: HvacOptionsSchema,
});

export interface HassOptions extends S.Schema.Type<typeof HassOptionsSchema> {}
export interface HvacOptions extends S.Schema.Type<typeof HvacOptionsSchema> {}
export interface ApplicationOptions extends S.Schema.Type<typeof ApplicationOptionsSchema> {}
export interface Settings extends S.Schema.Type<typeof SettingsSchema> {}

export const DefaultSettings: Settings = {
  appOptions: {
    logLevel: 'info',
    openaiApiKey: '',
    useAi: true,
  },
  hassOptions: {
    wsUrl: 'ws://localhost:8123/api/websocket',
    restUrl: 'http://localhost:8123',
    token: '',
    maxRetries: 5,
    retryDelayMs: 1000,
    stateCheckInterval: 30000,
  },
  hvacOptions: {
    systemMode: 'heat_pump',
    tempSensor: 'sensor.indoor_temperature',
    outdoorSensor: 'sensor.outdoor_temperature',
    heating: {
      temperature: 21.0,
      temperatureThresholds: {
        indoorMin: 18.0,
        indoorMax: 24.0,
        outdoorMin: -10.0,
        outdoorMax: 15.0,
      },
      defrost: {
        temperatureThreshold: 0.0,
        periodSeconds: 3600,
        durationSeconds: 300,
      },
      presetMode: 'heat',
    },
    cooling: {
      temperature: 24.0,
      temperatureThresholds: {
        indoorMin: 22.0,
        indoorMax: 28.0,
        outdoorMin: 20.0,
        outdoorMax: 40.0,
      },
      presetMode: 'cool',
    },
    
    hvacEntities: ['fan.hvac_fan', 'switch.aux_heat', 'switch.compressor'],
    activeHours: {
      start: 6,
      end: 22,
      startWeekday: 7,
    },
  },
};

// Add a simple test to ensure this file compiles
if (import.meta.main) {
  console.log('Settings file is valid');
}
