/**
 * Comprehensive test fixtures for HAG Effect-TS testing
 *
 * Provides reusable test data, mocks, and helper functions
 * equivalent to Python's conftest.py functionality
 */

import { Context, Duration, Effect, Layer, pipe, Ref } from 'effect';
import {
  ApplicationOptions,
  HassOptions,
  HvacOptions,
} from '../../src/config/settings_simple.ts';
import { HVACStateMachine } from '../../src/hvac/state-machine.ts';
import { HomeAssistantClient } from '../../src/home-assistant/client.ts';
import {
  HassEventImpl,
  HassStateImpl,
} from '../../src/home-assistant/models.ts';
import { HVACContext, HVACMode, SystemMode } from '../../src/types/common.ts';

/**
 * Mock Home Assistant Options
 */
export const mockHassOptions: HassOptions = {
  wsUrl: 'ws://localhost:8123/api/websocket',
  restUrl: 'http://localhost:8123',
  token: 'test-token-12345',
  maxRetries: 3,
  retryDelayMs: 1000,
  stateCheckInterval: 30000,
};

/**
 * Mock HVAC Options - Comprehensive configuration
 */
export const mockHvacOptions: HvacOptions = {
  systemMode: 'auto',
  tempSensor: 'sensor.indoor_temperature',
  outdoorSensor: 'sensor.outdoor_temperature',
  heating: {
    temperature: 21.0,
    temperatureThresholds: {
      indoorMin: 20.0,
      indoorMax: 22.0,
      outdoorMin: -10.0,
      outdoorMax: 15.0,
    },
    defrost: {
      temperatureThreshold: -5.0,
      periodSeconds: 3600,
      durationSeconds: 300,
    },
    presetMode: 'comfort',
  },
  cooling: {
    temperature: 24.0,
    temperatureThresholds: {
      indoorMin: 23.0,
      indoorMax: 25.0,
      outdoorMin: 20.0,
      outdoorMax: 40.0,
    },
    presetMode: 'windFree',
  },
  entities: {
    fan: 'switch.hvac_fan',
    auxHeat: 'switch.aux_heat',
    compressor: 'switch.compressor',
  },
  hvacEntities: [
    'climate.living_room_ac',
    'climate.bedroom_ac',
  ],
  activeHours: {
    start: 6,
    end: 22,
    startWeekday: 7,
  },
};

/**
 * Mock Application Options
 */
export const mockApplicationOptions: ApplicationOptions = {
  logLevel: 'info',
  useAi: false,
  openaiApiKey: 'test-key',
};

/**
 * Sample temperature data for various scenarios
 */
export const sampleTemperatureData = {
  heating: {
    coldDay: { indoor: 19.0, outdoor: -2.0 },
    moderateDay: { indoor: 20.5, outdoor: 5.0 },
    tooWarm: { indoor: 23.0, outdoor: 10.0 },
    defrostNeeded: { indoor: 19.0, outdoor: -8.0 },
  },
  cooling: {
    hotDay: { indoor: 26.0, outdoor: 35.0 },
    moderateDay: { indoor: 24.5, outdoor: 25.0 },
    tooCool: { indoor: 22.0, outdoor: 18.0 },
    extremeHeat: { indoor: 28.0, outdoor: 42.0 },
  },
  boundary: {
    heatingMin: { indoor: 20.0, outdoor: 5.0 },
    heatingMax: { indoor: 22.0, outdoor: 15.0 },
    coolingMin: { indoor: 23.0, outdoor: 20.0 },
    coolingMax: { indoor: 25.0, outdoor: 40.0 },
  },
};

/**
 * Time scenarios for testing active hours
 */
export const timeScenarios = {
  activeWeekday: { hour: 10, isWeekday: true },
  inactiveWeekday: { hour: 2, isWeekday: true },
  activeWeekend: { hour: 10, isWeekday: false },
  inactiveWeekend: { hour: 5, isWeekday: false },
  earlyWeekday: { hour: 7, isWeekday: true },
  lateEvening: { hour: 23, isWeekday: true },
  boundaryStart: { hour: 6, isWeekday: false },
  boundaryEnd: { hour: 22, isWeekday: false },
};

/**
 * Mock Home Assistant Client with realistic responses
 */
export class MockHomeAssistantClient {
  private temperatureData: Map<string, number> = new Map();
  private connected = true;

  constructor() {
    // Initialize with default temperatures
    this.temperatureData.set('sensor.indoor_temperature', 22.0);
    this.temperatureData.set('sensor.outdoor_temperature', 20.0);
  }

  setTemperature(entityId: string, temperature: number): void {
    this.temperatureData.set(entityId, temperature);
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
  }

  getState = (entityId: string): Effect.Effect<HassStateImpl, never> =>
    Effect.succeed(
      HassStateImpl.fromApiResponse({
        entity_id: entityId,
        state: this.temperatureData.get(entityId)?.toString() || '20.0',
        attributes: {
          unit_of_measurement: '°C',
          friendly_name: `Temperature ${entityId}`,
        },
        last_changed: new Date().toISOString(),
        last_updated: new Date().toISOString(),
      }),
    );

  callService = (): Effect.Effect<void, never> => Effect.void;

  connect = (): Effect.Effect<void, never> => Effect.void;

  disconnect = (): Effect.Effect<void, never> => Effect.void;

  connected_ = (): Effect.Effect<boolean, never> =>
    Effect.succeed(this.connected);

  subscribeEvents = (): Effect.Effect<void, never> => Effect.void;

  addEventHandler = (): Effect.Effect<void, never> => Effect.void;

  removeEventHandler = (): Effect.Effect<void, never> => Effect.void;

  getStats = (): Effect.Effect<void, never> =>
    Effect.succeed({
      totalConnections: 1,
      totalReconnections: 0,
      totalMessages: 0,
      totalErrors: 0,
    });
}

/**
 * Mock Home Assistant Client Layer
 */
export const MockHomeAssistantClientLive = Layer.succeed(
  HomeAssistantClient,
  HomeAssistantClient.of({
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    connected: () => Effect.succeed(true),
    getStats: () =>
      Effect.succeed({
        totalConnections: 1,
        totalReconnections: 0,
        totalMessages: 0,
        totalErrors: 0,
      }),
    getState: (entityId: string) =>
      Effect.succeed(
        HassStateImpl.fromApiResponse({
          entity_id: entityId,
          state: '22.0',
          attributes: {
            unit_of_measurement: '°C',
            friendly_name: `Temperature ${entityId}`,
          },
          last_changed: new Date().toISOString(),
          last_updated: new Date().toISOString(),
        }),
      ),
    callService: () => Effect.void,
    subscribeEvents: () => Effect.void,
    addEventHandler: () => Effect.void,
    removeEventHandler: () => Effect.void,
  }),
);

/**
 * Mock HVAC Context for state machine testing
 */
export const mockHVACContext: HVACContext = {
  indoorTemp: 22.0,
  outdoorTemp: 20.0,
  currentHour: 10,
  isWeekday: true,
  systemMode: SystemMode.AUTO,
};

/**
 * Create test state machine with custom options
 */
export const createTestStateMachine = (options: Partial<HvacOptions> = {}) => {
  const testOptions = { ...mockHvacOptions, ...options };
  return testOptions;
};

/**
 * Helper function to create temperature change events
 */
export const createTemperatureChangeEvent = (
  entityId: string,
  newTemp: number,
  oldTemp?: number,
): HassEventImpl => {
  return HassEventImpl.fromWebSocketEvent({
    type: 'event',
    event: {
      event_type: 'state_changed',
      data: {
        entity_id: entityId,
        new_state: {
          entity_id: entityId,
          state: newTemp.toString(),
          attributes: {
            unit_of_measurement: '°C',
            friendly_name: `Temperature ${entityId}`,
          },
          last_changed: new Date().toISOString(),
          last_updated: new Date().toISOString(),
        },
        old_state: oldTemp
          ? {
            entity_id: entityId,
            state: oldTemp.toString(),
            attributes: {
              unit_of_measurement: '°C',
              friendly_name: `Temperature ${entityId}`,
            },
            last_changed: new Date().toISOString(),
            last_updated: new Date().toISOString(),
          }
          : null,
      },
      time_fired: new Date(),
    },
  });
};

/**
 * Test scenario generators
 */
export const testScenarios = {
  /**
   * Generate heating scenarios
   */
  heating: {
    shouldHeat: () => [
      {
        name: 'Cold winter day',
        ...sampleTemperatureData.heating.coldDay,
        ...timeScenarios.activeWeekday,
      },
      {
        name: 'Moderate day',
        ...sampleTemperatureData.heating.moderateDay,
        ...timeScenarios.activeWeekend,
      },
    ],
    shouldNotHeat: () => [
      {
        name: 'Too warm',
        ...sampleTemperatureData.heating.tooWarm,
        ...timeScenarios.activeWeekday,
      },
      {
        name: 'Inactive hours',
        ...sampleTemperatureData.heating.coldDay,
        ...timeScenarios.inactiveWeekday,
      },
    ],
    defrostNeeded: () => [
      {
        name: 'Defrost conditions',
        ...sampleTemperatureData.heating.defrostNeeded,
        ...timeScenarios.activeWeekday,
      },
    ],
  },

  /**
   * Generate cooling scenarios
   */
  cooling: {
    shouldCool: () => [
      {
        name: 'Hot summer day',
        ...sampleTemperatureData.cooling.hotDay,
        ...timeScenarios.activeWeekday,
      },
      {
        name: 'Moderate warm day',
        ...sampleTemperatureData.cooling.moderateDay,
        ...timeScenarios.activeWeekend,
      },
    ],
    shouldNotCool: () => [
      {
        name: 'Too cool',
        ...sampleTemperatureData.cooling.tooCool,
        ...timeScenarios.activeWeekday,
      },
      {
        name: 'Inactive hours',
        ...sampleTemperatureData.cooling.hotDay,
        ...timeScenarios.inactiveWeekday,
      },
    ],
    extremeConditions: () => [
      {
        name: 'Extreme heat',
        ...sampleTemperatureData.cooling.extremeHeat,
        ...timeScenarios.activeWeekday,
      },
    ],
  },
};

/**
 * Mock services layer for testing
 */
export const TestServicesLayer = Layer.mergeAll(
  MockHomeAssistantClientLive,
  Layer.succeed(
    Context.Tag('HvacOptionsService')<any, HvacOptions>(),
    mockHvacOptions,
  ),
  Layer.succeed(
    Context.Tag('HassOptionsService')<any, HassOptions>(),
    mockHassOptions,
  ),
  Layer.succeed(
    Context.Tag('ApplicationOptionsService')<any, ApplicationOptions>(),
    mockApplicationOptions,
  ),
);

/**
 * Test utilities for assertions and validations
 */
export const testUtils = {
  /**
   * Assert temperature is within expected range
   */
  assertTemperatureInRange: (
    temp: number,
    min: number,
    max: number,
  ): boolean => {
    return temp >= min && temp <= max;
  },

  /**
   * Assert time is within active hours
   */
  assertActiveHours: (
    hour: number,
    isWeekday: boolean,
    options: HvacOptions,
  ): boolean => {
    const start = isWeekday
      ? options.activeHours?.startWeekday || 0
      : options.activeHours?.start || 0;
    const end = options.activeHours?.end || 24;
    return hour >= start && hour <= end;
  },

  /**
   * Create delay for async testing
   */
  delay: (ms: number): Effect.Effect<void, never> =>
    Effect.sleep(Duration.millis(ms)),

  /**
   * Generate test ID
   */
  generateTestId: (): string =>
    `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
};

