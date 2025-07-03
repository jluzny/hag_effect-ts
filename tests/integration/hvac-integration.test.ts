/**
 * Integration tests for HVAC system in HAG Effect-TS variant.
 * 
 * Tests the integration between Effect layers, HVAC controller, state machine, 
 * and Home Assistant client using Effect-native patterns.
 */

import { assertEquals, assertExists, assertInstanceOf } from '@std/assert';
import { Effect, Context as _Context, Layer, Ref, Exit, pipe } from 'effect';
import { 
  createContainer as _createContainer, 
  ApplicationContainer,
  SettingsService,
  HvacOptionsService,
  HassOptionsService,
  ApplicationOptionsService 
} from '../../src/core/container.ts';
import { HVACController } from '../../src/hvac/controller.ts';
import { HVACStateMachine } from '../../src/hvac/state-machine.ts';
import { HomeAssistantClient } from '../../src/home-assistant/client.ts';
import { HVACMode, SystemMode, LogLevel } from '../../src/types/common.ts';
import { Settings } from '../../src/config/settings_simple.ts';
import { ErrorUtils } from '../../src/core/exceptions.ts';

// Mock configuration for testing
const mockSettings: Settings = {
  appOptions: {
    logLevel: LogLevel.ERROR, // Reduce log noise in tests
    useAi: false,
    aiModel: 'gpt-4o-mini',
    aiTemperature: 0.1,
    openaiApiKey: 'test_key', // Added missing property
  },
  hassOptions: {
    wsUrl: 'ws://localhost:8123/api/websocket',
    restUrl: 'http://localhost:8123',
    token: 'test_token',
    maxRetries: 1,
    retryDelayMs: 100,
    stateCheckInterval: 5000, // Added missing property
  },
  hvacOptions: {
    tempSensor: 'sensor.indoor_temperature',
    outdoorSensor: 'sensor.outdoor_temperature',
    systemMode: SystemMode.AUTO,
    hvacEntities: [
      {
        entityId: 'climate.test_ac',
        enabled: true,
      },
    ],
    heating: {
      temperature: 21.0,
      presetMode: 'comfort',
      temperatureThresholds: {
        indoorMin: 19.7,
        indoorMax: 20.2,
        outdoorMin: -10.0,
        outdoorMax: 15.0,
      },
    },
    cooling: {
      temperature: 24.0,
      presetMode: 'windFree',
      temperatureThresholds: {
        indoorMin: 23.5,
        indoorMax: 25.0,
        outdoorMin: 10.0,
        outdoorMax: 45.0,
      },
    },
  },
};

// Mock Home Assistant client state
interface MockClientState {
  connected: boolean;
  mockStates: Map<string, { state: string; attributes: Record<string, unknown> }>;
}

// Mock Home Assistant client service
const MockHomeAssistantClient = Layer.effect(
  HomeAssistantClient,
  Effect.gen(function* () {
    const initialState: MockClientState = {
      connected: false,
      mockStates: new Map([
        ['sensor.indoor_temperature', { 
          state: '22.5', 
          attributes: { unit_of_measurement: '°C' } 
        }],
        ['sensor.outdoor_temperature', { 
          state: '15.0', 
          attributes: { unit_of_measurement: '°C' } 
        }],
      ]),
    };

    const stateRef = yield* Ref.make(initialState);

    const connect = (): Effect.Effect<void, never> =>
      pipe(
        stateRef,
        Ref.update((state) => ({ ...state, connected: true })),
        Effect.asVoid
      );

    const disconnect = (): Effect.Effect<void, never> =>
      pipe(
        stateRef,
        Ref.update((state) => ({ ...state, connected: false })),
        Effect.asVoid
      );

    const connected: Effect.Effect<boolean, never> = pipe(
      stateRef,
      Ref.get,
      Effect.map((state) => state.connected)
    );

    const getState = (entityId: string) =>
      pipe(
        stateRef,
        Ref.get,
        Effect.flatMap((state) => {
          const mockState = state.mockStates.get(entityId);
          if (!mockState) {
            return Effect.fail(ErrorUtils.stateError(`Entity ${entityId} not found`, entityId));
          }
          
          return Effect.succeed({
            entityId,
            state: mockState.state,
            attributes: mockState.attributes,
            getNumericState: () => parseFloat(mockState.state),
          });
        })
      );

    const callService = () => Effect.void;
    const subscribeEvents = () => Effect.void;
    const addEventHandler = () => Effect.void;
    const removeEventHandler = () => Effect.void;

    const getStats = () =>
      Effect.succeed({
        totalConnections: 1,
        totalReconnections: 0,
        totalMessages: 0,
        totalErrors: 0,
      });

    // Helper to update mock states
    const updateMockState = (entityId: string, newState: string) =>
      pipe(
        stateRef,
        Ref.update((state) => {
          const existing = state.mockStates.get(entityId);
          if (existing) {
            state.mockStates.set(entityId, { ...existing, state: newState });
          }
          return state;
        })
      );

    return HomeAssistantClient.of({
      connect,
      disconnect,
      connected,
      getStats,
      getState,
      callService,
      subscribeEvents,
      addEventHandler,
      removeEventHandler,
      // Add update method for testing
      updateMockState,
    });
  })
);

// Mock HVAC State Machine
const MockHVACStateMachine = Layer.succeed(
  HVACStateMachine,
  HVACStateMachine.of({
    start: () => Effect.void,
    stop: () => Effect.void,
    getStatus: () =>
      Effect.succeed({
        currentState: 'idle',
        context: {
          indoorTemp: 22.5,
          outdoorTemp: 15.0,
        },
      }),
    updateTemperatures: () => Effect.void,
    evaluateConditions: () => Effect.void,
    manualOverride: () => Effect.void,
    clearOverride: () => Effect.void,
  })
);

// Test layer that provides all mocked services
const TestLayer = Layer.mergeAll(
  Layer.succeed(SettingsService, mockSettings),
  Layer.succeed(HvacOptionsService, mockSettings.hvacOptions),
  Layer.succeed(HassOptionsService, mockSettings.hassOptions),
  Layer.succeed(ApplicationOptionsService, mockSettings.appOptions),
  MockHomeAssistantClient,
  MockHVACStateMachine
);

Deno.test('Effect-TS HVAC Integration Tests', async (t) => {
  await t.step('should create and run container with Effect layers', async () => {
    const effect = Effect.gen(function* () {
      const container = yield* ApplicationContainer.initialize();
      assertInstanceOf(container, ApplicationContainer);
      return container;
    });

    const result = await Effect.runPromiseExit(effect);
    assertEquals(Exit.isSuccess(result), true);
  });

  await t.step('should access services through Context tags', async () => {
    const effect = Effect.gen(function* () {
      const settings = yield* SettingsService;
      const hvacOptions = yield* HvacOptionsService;
      const hassOptions = yield* HassOptionsService;
      const appOptions = yield* ApplicationOptionsService;

      assertEquals(settings.hvacOptions.systemMode, SystemMode.AUTO);
      assertEquals(hvacOptions.systemMode, SystemMode.AUTO);
      assertEquals(hassOptions.maxRetries, 1);
      assertEquals(appOptions.useAi, false);

      return { settings, hvacOptions, hassOptions, appOptions };
    });

    const result = await Effect.runPromise(
      Effect.provide(effect, TestLayer)
    );

    assertExists(result.settings);
    assertExists(result.hvacOptions);
    assertExists(result.hassOptions);
    assertExists(result.appOptions);
  });

  await t.step('should integrate HVAC controller with services', async () => {
    const effect = Effect.gen(function* () {
      const controller = yield* HVACController;
      const haClient = yield* HomeAssistantClient;

      // Test controller-client integration
      yield* controller.start();
      const connected = yield* haClient.connected;
      assertEquals(connected, true);

      const status = yield* controller.getStatus();
      assertEquals(status.controller.running, true);
      assertEquals(status.controller.haConnected, true);

      yield* controller.stop();
      const disconnected = yield* haClient.connected;
      assertEquals(disconnected, false);

      return status;
    });

    const status = await Effect.runPromise(
      Effect.provide(effect, TestLayer)
    );

    assertEquals(status.controller.systemMode, SystemMode.AUTO);
    assertEquals(status.controller.tempSensor, 'sensor.indoor_temperature');
  });

  await t.step('should handle manual override operations', async () => {
    const effect = Effect.gen(function* () {
      const controller = yield* HVACController;

      yield* controller.start();

      // Test heating override
      const heatingResult = yield* controller.manualOverride('heat', { temperature: 22.0 });
      assertEquals(heatingResult.success, true);
      assertEquals(heatingResult.data?.action, 'heat');

      // Test cooling override
      const coolingResult = yield* controller.manualOverride('cool', { temperature: 23.0 });
      assertEquals(coolingResult.success, true);
      assertEquals(coolingResult.data?.action, 'cool');

      // Test off override
      const offResult = yield* controller.manualOverride('off');
      assertEquals(offResult.success, true);
      assertEquals(offResult.data?.action, 'off');

      yield* controller.stop();
      return { heatingResult, coolingResult, offResult };
    });

    const results = await Effect.runPromise(
      Effect.provide(effect, TestLayer)
    );

    assertEquals(results.heatingResult.success, true);
    assertEquals(results.coolingResult.success, true);
    assertEquals(results.offResult.success, true);
  });

  await t.step('should handle evaluation operations', async () => {
    const effect = Effect.gen(function* () {
      const controller = yield* HVACController;

      yield* controller.start();

      // Test manual evaluation
      const evalResult = yield* controller.triggerEvaluation();
      assertEquals(evalResult.success, true);
      assertExists(evalResult.timestamp);

      // Test efficiency evaluation
      const efficiencyResult = yield* controller.evaluateEfficiency();
      assertEquals(efficiencyResult.success, true);
      assertExists(efficiencyResult.data);

      yield* controller.stop();
      return { evalResult, efficiencyResult };
    });

    const results = await Effect.runPromise(
      Effect.provide(effect, TestLayer)
    );

    assertEquals(results.evalResult.success, true);
    assertEquals(results.efficiencyResult.success, true);
  });

  await t.step('should read temperature data through Home Assistant client', async () => {
    const effect = Effect.gen(function* () {
      const haClient = yield* HomeAssistantClient;

      yield* haClient.connect();

      const indoorState = yield* haClient.getState('sensor.indoor_temperature');
      const outdoorState = yield* haClient.getState('sensor.outdoor_temperature');

      assertEquals(indoorState.entityId, 'sensor.indoor_temperature');
      assertEquals(indoorState.state, '22.5');
      assertEquals(indoorState.getNumericState(), 22.5);

      assertEquals(outdoorState.entityId, 'sensor.outdoor_temperature');
      assertEquals(outdoorState.state, '15.0');
      assertEquals(outdoorState.getNumericState(), 15.0);

      const stats = yield* haClient.getStats();
      assertEquals(stats.totalConnections, 1);

      yield* haClient.disconnect();
      return { indoorState, outdoorState, stats };
    });

    const result = await Effect.runPromise(
      Effect.provide(effect, TestLayer)
    );

    assertExists(result.indoorState);
    assertExists(result.outdoorState);
    assertExists(result.stats);
  });

  await t.step('should handle state machine integration', async () => {
    const effect = Effect.gen(function* () {
      const stateMachine = yield* HVACStateMachine;

      yield* stateMachine.start();

      const status = yield* stateMachine.getStatus();
      assertEquals(status.currentState, 'idle');
      assertEquals(status.context.indoorTemp, 22.5);
      assertEquals(status.context.outdoorTemp, 15.0);

      // Test state machine operations
      yield* stateMachine.updateTemperatures(18.0, 5.0);
      yield* stateMachine.evaluateConditions();
      yield* stateMachine.manualOverride(HVACMode.HEAT, 22.0);
      yield* stateMachine.clearOverride();

      yield* stateMachine.stop();
      return status;
    });

    const status = await Effect.runPromise(
      Effect.provide(effect, TestLayer)
    );

    assertEquals(status.currentState, 'idle');
    assertExists(status.context);
  });

  await t.step('should handle error conditions with Effect error handling', async () => {
    const effect = Effect.gen(function* () {
      const haClient = yield* HomeAssistantClient;

      yield* haClient.connect();

      // Try to get a non-existent entity
      const result = yield* Effect.either(
        haClient.getState('sensor.nonexistent')
      );

      if (result._tag === 'Left') {
        assertEquals(result.left._tag, 'StateError');
        assertEquals(result.left.entityId, 'sensor.nonexistent');
      } else {
        throw new Error('Expected StateError for non-existent entity');
      }

      yield* haClient.disconnect();
      return result;
    });

    const result = await Effect.runPromise(
      Effect.provide(effect, TestLayer)
    );

    assertEquals(result._tag, 'Left');
    if (result._tag === 'Left') {
      assertEquals(result.left._tag, 'StateError');
    }
  });

  await t.step('should support configuration validation through Effect Schema', async () => {
    const effect = Effect.gen(function* () {
      const settings = yield* SettingsService;
      const hvacOptions = yield* HvacOptionsService;

      // Verify configuration is properly validated and typed
      assertEquals(settings.hvacOptions.systemMode, SystemMode.AUTO);
      assertEquals(hvacOptions.hvacEntities.length, 1);
      assertEquals(hvacOptions.hvacEntities[0].entityId, 'climate.test_ac');
      assertEquals(hvacOptions.heating.temperature, 21.0);
      assertEquals(hvacOptions.cooling.temperature, 24.0);

      // Verify nested configuration
      assertEquals(hvacOptions.heating.temperatureThresholds.indoorMin, 19.7);
      assertEquals(hvacOptions.cooling.temperatureThresholds.indoorMax, 25.0);

      return { settings, hvacOptions };
    });

    const result = await Effect.runPromise(
      Effect.provide(effect, TestLayer)
    );

    assertExists(result.settings);
    assertExists(result.hvacOptions);
  });

  await t.step('should demonstrate Effect composition and error recovery', async () => {
    const effect = Effect.gen(function* () {
      const controller = yield* HVACController;
      const haClient = yield* HomeAssistantClient;

      // Demonstrate Effect retry on connection
      const connectionResult = yield* Effect.retry(
        haClient.connect(),
        { times: 3 }
      );

      // Demonstrate Effect fallback on controller start
      const startResult = yield* Effect.catchAll(
        controller.start(),
        (error) => Effect.succeed(`Fallback: ${error._tag}`)
      );

      // Demonstrate Effect timeout
      const statusResult = yield* Effect.timeout(
        controller.getStatus(),
        '5 seconds'
      );

      yield* controller.stop();
      yield* haClient.disconnect();

      return { connectionResult, startResult, statusResult };
    });

    const result = await Effect.runPromise(
      Effect.provide(effect, TestLayer)
    );

    assertExists(result.connectionResult);
    assertExists(result.startResult);
    assertExists(result.statusResult);
  });

  await t.step('should support concurrent operations with Effect.all', async () => {
    const effect = Effect.gen(function* () {
      const controller = yield* HVACController;
      const haClient = yield* HomeAssistantClient;
      const stateMachine = yield* HVACStateMachine;

      // Start all services concurrently
      yield* Effect.all([
        haClient.connect(),
        stateMachine.start(),
        controller.start(),
      ], { concurrency: 'unbounded' });

      // Get multiple status reports concurrently
      const results = yield* Effect.all([
        controller.getStatus(),
        haClient.getStats(),
        stateMachine.getStatus(),
      ], { concurrency: 'unbounded' });

      // Stop all services concurrently
      yield* Effect.all([
        controller.stop(),
        stateMachine.stop(),
        haClient.disconnect(),
      ], { concurrency: 'unbounded' });

      return results;
    });

    const [controllerStatus, haStats, stateMachineStatus] = await Effect.runPromise(
      Effect.provide(effect, TestLayer)
    );

    assertExists(controllerStatus);
    assertExists(haStats);
    assertExists(stateMachineStatus);
    assertEquals(controllerStatus.controller.running, true);
    assertEquals(haStats.totalConnections, 1);
    assertEquals(stateMachineStatus.currentState, 'idle');
  });
});

Deno.test('Effect Layer Composition and Dependency Injection', async (t) => {
  await t.step('should compose layers correctly', async () => {
    const effect = Effect.gen(function* () {
      // Test that all required services are available
      const settings = yield* SettingsService;
      const hvacOptions = yield* HvacOptionsService;
      const hassOptions = yield* HassOptionsService;
      const appOptions = yield* ApplicationOptionsService;
      const haClient = yield* HomeAssistantClient;
      const stateMachine = yield* HVACStateMachine;

      return {
        settings: !!settings,
        hvacOptions: !!hvacOptions,
        hassOptions: !!hassOptions,
        appOptions: !!appOptions,
        haClient: !!haClient,
        stateMachine: !!stateMachine,
      };
    });

    const result = await Effect.runPromise(
      Effect.provide(effect, TestLayer)
    );

    // All services should be available
    assertEquals(result.settings, true);
    assertEquals(result.hvacOptions, true);
    assertEquals(result.hassOptions, true);
    assertEquals(result.appOptions, true);
    assertEquals(result.haClient, true);
    assertEquals(result.stateMachine, true);
  });

  await t.step('should handle layer dependencies correctly', async () => {
    // Test that dependent services can access their dependencies
    const effect = Effect.gen(function* () {
      const hvacOptions = yield* HvacOptionsService;
      const settings = yield* SettingsService;

      // HvacOptions should match the hvacOptions from Settings
      assertEquals(hvacOptions.systemMode, settings.hvacOptions.systemMode);
      assertEquals(hvacOptions.tempSensor, settings.hvacOptions.tempSensor);

      return { hvacOptions, settings };
    });

    const result = await Effect.runPromise(
      Effect.provide(effect, TestLayer)
    );

    assertEquals(result.hvacOptions.systemMode, result.settings.hvacOptions.systemMode);
  });

  await t.step('should support layer scoping and isolation', async () => {
    // Create a scoped layer with different settings
    const scopedSettings: Settings = {
      ...mockSettings,
      hvacOptions: {
        ...mockSettings.hvacOptions,
        systemMode: SystemMode.HEAT_ONLY,
        tempSensor: 'sensor.scoped_temperature',
      },
    };

    const ScopedLayer = Layer.succeed(SettingsService, scopedSettings);

    const effect = Effect.gen(function* () {
      const settings = yield* SettingsService;
      return settings.hvacOptions.systemMode;
    });

    // Test with original layer
    const originalResult = await Effect.runPromise(
      Effect.provide(effect, TestLayer)
    );

    // Test with scoped layer
    const scopedResult = await Effect.runPromise(
      Effect.provide(effect, ScopedLayer)
    );

    assertEquals(originalResult, SystemMode.AUTO);
    assertEquals(scopedResult, SystemMode.HEAT_ONLY);
  });
});