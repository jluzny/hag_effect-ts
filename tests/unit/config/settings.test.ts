/**
 * Unit tests for configuration schemas in HAG Effect-TS variant.
 */

import { assertEquals, assertThrows as _assertThrows } from '@std/assert';
import { Effect, Exit } from 'effect';
import { Schema as S, ParseResult } from '@effect/schema';
import { ApplicationOptionsSchema, HassOptionsSchema, HvacOptionsSchema, SettingsSchema } from '../../../src/config/settings_simple.ts';
import { LogLevel, SystemMode } from '../../../src/types/common.ts';

// Re-export types to avoid lint errors
export type { Settings as _Settings, HvacOptions as _HvacOptions } from '../../../src/config/settings_simple.ts';

Deno.test('HassOptionsSchema', async (t) => {
  await t.step('should validate valid Home Assistant config', async () => {
    const validConfig = {
      wsUrl: 'ws://localhost:8123/api/websocket',
      restUrl: 'http://localhost:8123',
      token: 'long_lived_access_token',
      maxRetries: 3,
      retryDelayMs: 1000,
    };

    const result = await Effect.runPromise(S.decode(HassOptionsSchema)(validConfig));
    
    assertEquals(result.wsUrl, validConfig.wsUrl);
    assertEquals(result.restUrl, validConfig.restUrl);
    assertEquals(result.token, validConfig.token);
    assertEquals(result.maxRetries, validConfig.maxRetries);
    assertEquals(result.retryDelayMs, validConfig.retryDelayMs);
  });

  await t.step('should apply defaults for optional fields', async () => {
    const minimalConfig = {
      wsUrl: 'ws://localhost:8123/api/websocket',
      restUrl: 'http://localhost:8123',
      token: 'token',
    };

    const result = await Effect.runPromise(S.decode(HassOptionsSchema)(minimalConfig));
    
    assertEquals(result.maxRetries, 3);
    assertEquals(result.retryDelayMs, 1000);
  });

  await t.step('should reject invalid URLs', async () => {
    const invalidConfig = {
      wsUrl: 'not-a-url',
      restUrl: 'http://localhost:8123',
      token: 'token',
    };

    const effect = S.decode(HassOptionsSchema)(invalidConfig);
    const exit = await Effect.runPromiseExit(effect);
    
    assertEquals(Exit.isFailure(exit), true);
    if (Exit.isFailure(exit)) {
      assertEquals(ParseResult.isParseError(exit.cause.defect), true);
    }
  });

  await t.step('should reject invalid retry values', async () => {
    const invalidConfig = {
      wsUrl: 'ws://localhost:8123/api/websocket',
      restUrl: 'http://localhost:8123',
      token: 'token',
      maxRetries: -1,
    };

    const effect = S.decode(HassOptionsSchema)(invalidConfig);
    const exit = await Effect.runPromiseExit(effect);
    
    assertEquals(Exit.isFailure(exit), true);
  });
});

Deno.test('HvacOptionsSchema', async (t) => {
  await t.step('should validate valid HVAC config', async () => {
    const validConfig = {
      tempSensor: 'sensor.indoor_temperature',
      outdoorSensor: 'sensor.outdoor_temperature',
      systemMode: SystemMode.AUTO,
      hvacEntities: [
        {
          entityId: 'climate.living_room',
          enabled: true,
          defrost: false,
        },
      ],
      heating: {
        temperature: 21.0,
        presetMode: 'comfort',
        temperatureThresholds: {
          indoorMin: 19.0,
          indoorMax: 22.0,
          outdoorMin: -10.0,
          outdoorMax: 15.0,
        },
      },
      cooling: {
        temperature: 24.0,
        presetMode: 'eco',
        temperatureThresholds: {
          indoorMin: 23.0,
          indoorMax: 26.0,
          outdoorMin: 10.0,
          outdoorMax: 45.0,
        },
      },
    };

    const result = await Effect.runPromise(S.decode(HvacOptionsSchema)(validConfig));
    
    assertEquals(result.tempSensor, validConfig.tempSensor);
    assertEquals(result.systemMode, SystemMode.AUTO);
    assertEquals(result.hvacEntities.length, 1);
    assertEquals(result.heating.temperature, 21.0);
    assertEquals(result.cooling.temperature, 24.0);
  });

  await t.step('should reject invalid sensor entity IDs', async () => {
    const invalidConfig = {
      tempSensor: 'invalid_sensor_id',
      hvacEntities: [],
      heating: {},
      cooling: {},
    };

    const effect = S.decode(HvacOptionsSchema)(invalidConfig);
    const exit = await Effect.runPromiseExit(effect);
    
    assertEquals(Exit.isFailure(exit), true);
  });

  await t.step('should validate defrost configuration', async () => {
    const configWithDefrost = {
      tempSensor: 'sensor.indoor_temperature',
      hvacEntities: [],
      heating: {
        defrost: {
          temperatureThreshold: 0.0,
          periodSeconds: 3600,
          durationSeconds: 300,
        },
      },
      cooling: {},
    };

    const result = await Effect.runPromise(S.decode(HvacOptionsSchema)(configWithDefrost));
    
    assertEquals(result.heating.defrost?.temperatureThreshold, 0.0);
    assertEquals(result.heating.defrost?.periodSeconds, 3600);
    assertEquals(result.heating.defrost?.durationSeconds, 300);
  });

  await t.step('should validate active hours configuration', async () => {
    const configWithActiveHours = {
      tempSensor: 'sensor.indoor_temperature',
      hvacEntities: [],
      heating: {},
      cooling: {},
      activeHours: {
        start: 8,
        startWeekday: 7,
        end: 22,
      },
    };

    const result = await Effect.runPromise(S.decode(HvacOptionsSchema)(configWithActiveHours));
    
    assertEquals(result.activeHours?.start, 8);
    assertEquals(result.activeHours?.startWeekday, 7);
    assertEquals(result.activeHours?.end, 22);
  });
});

Deno.test('ApplicationOptionsSchema', async (t) => {
  await t.step('should validate application options with defaults', async () => {
    const result = await Effect.runPromise(S.decode(ApplicationOptionsSchema)({}));
    
    assertEquals(result.logLevel, LogLevel.INFO);
    assertEquals(result.useAi, false);
    assertEquals(result.aiModel, 'gpt-4o-mini');
    assertEquals(result.aiTemperature, 0.1);
    assertEquals(result.openaiApiKey, undefined);
  });

  await t.step('should validate AI configuration', async () => {
    const aiConfig = {
      logLevel: LogLevel.DEBUG,
      useAi: true,
      aiModel: 'gpt-4',
      aiTemperature: 0.5,
      openaiApiKey: 'sk-test-key',
    };

    const result = await Effect.runPromise(S.decode(ApplicationOptionsSchema)(aiConfig));
    
    assertEquals(result.logLevel, LogLevel.DEBUG);
    assertEquals(result.useAi, true);
    assertEquals(result.aiModel, 'gpt-4');
    assertEquals(result.aiTemperature, 0.5);
    assertEquals(result.openaiApiKey, 'sk-test-key');
  });

  await t.step('should reject invalid AI temperature', async () => {
    const invalidConfig = {
      aiTemperature: 3.0, // Above max of 2.0
    };

    const effect = S.decode(ApplicationOptionsSchema)(invalidConfig);
    const exit = await Effect.runPromiseExit(effect);
    
    assertEquals(Exit.isFailure(exit), true);
  });
});

Deno.test('SettingsSchema', async (t) => {
  await t.step('should validate complete settings', async () => {
    const completeSettings = {
      appOptions: {
        logLevel: LogLevel.INFO,
        useAi: false,
      },
      hassOptions: {
        wsUrl: 'ws://localhost:8123/api/websocket',
        restUrl: 'http://localhost:8123',
        token: 'test_token',
      },
      hvacOptions: {
        tempSensor: 'sensor.indoor_temperature',
        hvacEntities: [
          {
            entityId: 'climate.test',
            enabled: true,
            defrost: false,
          },
        ],
        heating: {
          temperature: 21.0,
          presetMode: 'comfort',
          temperatureThresholds: {
            indoorMin: 19.0,
            indoorMax: 22.0,
            outdoorMin: -10.0,
            outdoorMax: 15.0,
          },
        },
        cooling: {
          temperature: 24.0,
          presetMode: 'eco',
          temperatureThresholds: {
            indoorMin: 23.0,
            indoorMax: 26.0,
            outdoorMin: 10.0,
            outdoorMax: 45.0,
          },
        },
      },
    };

    const result = await Effect.runPromise(S.decode(SettingsSchema)(completeSettings));
    
    assertEquals(result.appOptions.logLevel, LogLevel.INFO);
    assertEquals(result.hassOptions.wsUrl, completeSettings.hassOptions.wsUrl);
    assertEquals(result.hvacOptions.tempSensor, completeSettings.hvacOptions.tempSensor);
  });

  await t.step('should apply nested defaults', async () => {
    const minimalSettings = {
      hassOptions: {
        wsUrl: 'ws://localhost:8123/api/websocket',
        restUrl: 'http://localhost:8123',
        token: 'test_token',
      },
      hvacOptions: {
        tempSensor: 'sensor.indoor_temperature',
        hvacEntities: [],
        heating: {},
        cooling: {},
      },
    };

    const result = await Effect.runPromise(S.decode(SettingsSchema)(minimalSettings));
    
    assertEquals(result.appOptions.logLevel, LogLevel.INFO);
    assertEquals(result.appOptions.useAi, false);
    assertEquals(result.hvacOptions.systemMode, SystemMode.AUTO);
    assertEquals(result.hvacOptions.outdoorSensor, 'sensor.openweathermap_temperature');
  });
});

Deno.test('Temperature thresholds validation', async (t) => {
  await t.step('should enforce temperature ranges', async () => {
    const invalidHeating = {
      tempSensor: 'sensor.temp',
      hvacEntities: [],
      heating: {
        temperature: 50, // Above max of 35
      },
      cooling: {},
    };

    const effect = S.decode(HvacOptionsSchema)(invalidHeating);
    const exit = await Effect.runPromiseExit(effect);
    
    assertEquals(Exit.isFailure(exit), true);
  });

  await t.step('should enforce outdoor temperature ranges', async () => {
    const invalidThresholds = {
      tempSensor: 'sensor.temp',
      hvacEntities: [],
      heating: {
        temperatureThresholds: {
          indoorMin: 15.0,
          indoorMax: 25.0,
          outdoorMin: -60.0, // Below min of -50
          outdoorMax: 20.0,
        },
      },
      cooling: {},
    };

    const effect = S.decode(HvacOptionsSchema)(invalidThresholds);
    const exit = await Effect.runPromiseExit(effect);
    
    assertEquals(Exit.isFailure(exit), true);
  });
});

Deno.test('Entity validation', async (t) => {
  await t.step('should validate HVAC entity IDs', async () => {
    const validEntity = {
      tempSensor: 'sensor.temp',
      hvacEntities: [
        {
          entityId: 'climate.living_room_ac',
          enabled: true,
          defrost: true,
        },
      ],
      heating: {},
      cooling: {},
    };

    const result = await Effect.runPromise(S.decode(HvacOptionsSchema)(validEntity));
    
    assertEquals(result.hvacEntities[0].entityId, 'climate.living_room_ac');
    assertEquals(result.hvacEntities[0].enabled, true);
    assertEquals(result.hvacEntities[0].defrost, true);
  });

  await t.step('should reject invalid entity ID format', async () => {
    const invalidEntity = {
      tempSensor: 'sensor.temp',
      hvacEntities: [
        {
          entityId: 'invalid_format',
        },
      ],
      heating: {},
      cooling: {},
    };

    const effect = S.decode(HvacOptionsSchema)(invalidEntity);
    const exit = await Effect.runPromiseExit(effect);
    
    assertEquals(Exit.isFailure(exit), true);
  });
});

Deno.test('Effect Schema Integration', async (t) => {
  await t.step('should work with Effect error handling', async () => {
    const invalidSettings = {
      hassOptions: {
        wsUrl: 'invalid-url',
        restUrl: 'http://localhost:8123',
        token: 'token',
      },
      hvacOptions: {
        tempSensor: 'invalid_sensor',
        hvacEntities: [],
        heating: {},
        cooling: {},
      },
    };

    const effect = Effect.gen(function* () {
      const settings = yield* S.decode(SettingsSchema)(invalidSettings);
      return settings;
    });

    const result = await Effect.runPromiseExit(
      Effect.catchAll(effect, (error) => 
        Effect.succeed(`Validation failed: ${error._tag}`)
      )
    );

    assertEquals(Exit.isSuccess(result), true);
    if (Exit.isSuccess(result)) {
      assertEquals(result.value.startsWith('Validation failed:'), true);
    }
  });

  await t.step('should compose with other Effects', async () => {
    const validSettings = {
      hassOptions: {
        wsUrl: 'ws://localhost:8123/api/websocket',
        restUrl: 'http://localhost:8123',
        token: 'token',
      },
      hvacOptions: {
        tempSensor: 'sensor.indoor_temperature',
        hvacEntities: [],
        heating: {},
        cooling: {},
      },
    };

    const effect = Effect.gen(function* () {
      const settings = yield* S.decode(SettingsSchema)(validSettings);
      const systemMode = settings.hvacOptions.systemMode;
      const aiEnabled = settings.appOptions.useAi;
      
      return `System: ${systemMode}, AI: ${aiEnabled}`;
    });

    const result = await Effect.runPromise(effect);
    assertEquals(result, 'System: auto, AI: false');
  });

  await t.step('should validate with custom transformations', async () => {
    // Test that the schema properly applies defaults and transformations
    const minimalConfig = {
      hassOptions: {
        wsUrl: 'ws://localhost:8123/api/websocket',
        restUrl: 'http://localhost:8123',
        token: 'token',
      },
      hvacOptions: {
        tempSensor: 'sensor.temp',
        hvacEntities: [],
        heating: {},
        cooling: {},
      },
    };

    const effect = S.decode(SettingsSchema)(minimalConfig);
    const result = await Effect.runPromise(effect);

    // Check that defaults were applied correctly
    assertEquals(result.appOptions.logLevel, LogLevel.INFO);
    assertEquals(result.appOptions.useAi, false);
    assertEquals(result.appOptions.aiModel, 'gpt-4o-mini');
    assertEquals(result.hvacOptions.systemMode, SystemMode.AUTO);
    assertEquals(result.hvacOptions.outdoorSensor, 'sensor.openweathermap_temperature');
    assertEquals(result.hvacOptions.heating.temperature, 21.0);
    assertEquals(result.hvacOptions.cooling.temperature, 24.0);
  });

  await t.step('should handle complex nested validation', async () => {
    const complexConfig = {
      appOptions: {
        logLevel: LogLevel.DEBUG,
        useAi: true,
        aiModel: 'gpt-4',
        openaiApiKey: 'sk-test-key',
      },
      hassOptions: {
        wsUrl: 'ws://ha.local:8123/api/websocket',
        restUrl: 'https://ha.local:8123',
        token: 'very_long_lived_access_token_here',
        maxRetries: 5,
        retryDelayMs: 2000,
      },
      hvacOptions: {
        tempSensor: 'sensor.indoor_temperature',
        outdoorSensor: 'sensor.weather_temperature',
        systemMode: SystemMode.HEAT_ONLY,
        hvacEntities: [
          {
            entityId: 'climate.heat_pump_main',
            enabled: true,
            defrost: true,
          },
          {
            entityId: 'climate.heat_pump_aux',
            enabled: false,
            defrost: false,
          },
        ],
        heating: {
          temperature: 22.5,
          presetMode: 'boost',
          temperatureThresholds: {
            indoorMin: 20.0,
            indoorMax: 23.0,
            outdoorMin: -15.0,
            outdoorMax: 10.0,
          },
          defrost: {
            temperatureThreshold: -2.0,
            periodSeconds: 7200,
            durationSeconds: 600,
          },
        },
        cooling: {
          temperature: 26.0,
          presetMode: 'quiet',
          temperatureThresholds: {
            indoorMin: 25.0,
            indoorMax: 27.0,
            outdoorMin: 15.0,
            outdoorMax: 40.0,
          },
        },
        activeHours: {
          start: 6,
          startWeekday: 8,
          end: 23,
        },
      },
    };

    const result = await Effect.runPromise(S.decode(SettingsSchema)(complexConfig));

    // Verify all complex nested values are preserved
    assertEquals(result.appOptions.useAi, true);
    assertEquals(result.appOptions.openaiApiKey, 'sk-test-key');
    assertEquals(result.hassOptions.maxRetries, 5);
    assertEquals(result.hvacOptions.systemMode, SystemMode.HEAT_ONLY);
    assertEquals(result.hvacOptions.hvacEntities.length, 2);
    assertEquals(result.hvacOptions.hvacEntities[0].defrost, true);
    assertEquals(result.hvacOptions.hvacEntities[1].enabled, false);
    assertEquals(result.hvacOptions.heating.defrost?.periodSeconds, 7200);
    assertEquals(result.hvacOptions.activeHours?.startWeekday, 8);
  });
});