/**
 * Unit tests for common types in HAG Effect-TS variant.
 */

import { assertEquals, assertInstanceOf } from '@std/assert';
import { 
  HVACMode, 
  SystemMode, 
  LogLevel, 
  WebSocketState,
  type HVACStatus,
  type OperationResult,
  type ConnectionStats,
} from '../../../src/types/common.ts';

Deno.test('HVACMode enum', async (t) => {
  await t.step('should have correct HVAC mode values', () => {
    assertEquals(HVACMode.HEAT, 'heat');
    assertEquals(HVACMode.COOL, 'cool');
    assertEquals(HVACMode.OFF, 'off');
    assertEquals(HVACMode.AUTO, 'auto');
  });

  await t.step('should have all expected modes', () => {
    const modes = Object.values(HVACMode);
    assertEquals(modes.length, 4);
    assertEquals(modes.includes('heat'), true);
    assertEquals(modes.includes('cool'), true);
    assertEquals(modes.includes('off'), true);
    assertEquals(modes.includes('auto'), true);
  });

  await t.step('should be usable in type guards', () => {
    const testMode: string = 'heat';
    const isValidMode = Object.values(HVACMode).includes(testMode as HVACMode);
    assertEquals(isValidMode, true);
    
    const invalidMode: string = 'invalid';
    const isInvalidMode = Object.values(HVACMode).includes(invalidMode as HVACMode);
    assertEquals(isInvalidMode, false);
  });
});

Deno.test('SystemMode enum', async (t) => {
  await t.step('should have correct system mode values', () => {
    assertEquals(SystemMode.AUTO, 'auto');
    assertEquals(SystemMode.HEAT_ONLY, 'heat_only');
    assertEquals(SystemMode.COOL_ONLY, 'cool_only');
    assertEquals(SystemMode.OFF, 'off');
  });

  await t.step('should have all expected system modes', () => {
    const modes = Object.values(SystemMode);
    assertEquals(modes.length, 4);
    assertEquals(modes.includes('auto'), true);
    assertEquals(modes.includes('heat_only'), true);
    assertEquals(modes.includes('cool_only'), true);
    assertEquals(modes.includes('off'), true);
  });

  await t.step('should distinguish between system and HVAC modes', () => {
    // Both have 'auto' and 'off', but different semantics
    assertEquals(SystemMode.AUTO, HVACMode.AUTO);
    assertEquals(SystemMode.OFF, HVACMode.OFF);
    
    // System mode has heat_only/cool_only, HVAC mode has heat/cool
    assertEquals(SystemMode.HEAT_ONLY !== HVACMode.HEAT, true);
    assertEquals(SystemMode.COOL_ONLY !== HVACMode.COOL, true);
  });
});

Deno.test('LogLevel enum', async (t) => {
  await t.step('should have correct log level values', () => {
    assertEquals(LogLevel.DEBUG, 'debug');
    assertEquals(LogLevel.INFO, 'info');
    assertEquals(LogLevel.WARNING, 'warning');
    assertEquals(LogLevel.ERROR, 'error');
  });

  await t.step('should have hierarchical ordering', () => {
    const levels = Object.values(LogLevel);
    assertEquals(levels.length, 4);
    
    // Should be in order of verbosity (most to least verbose)
    assertEquals(levels[0], 'debug');
    assertEquals(levels[1], 'info');
    assertEquals(levels[2], 'warning');
    assertEquals(levels[3], 'error');
  });

  await t.step('should support log level comparison logic', () => {
    const levelOrder = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARNING, LogLevel.ERROR];
    
    // Function to check if a level should be logged
    const shouldLog = (currentLevel: LogLevel, messageLevel: LogLevel): boolean => {
      return levelOrder.indexOf(messageLevel) >= levelOrder.indexOf(currentLevel);
    };

    // Test log level filtering
    assertEquals(shouldLog(LogLevel.INFO, LogLevel.DEBUG), false);
    assertEquals(shouldLog(LogLevel.INFO, LogLevel.INFO), true);
    assertEquals(shouldLog(LogLevel.INFO, LogLevel.WARNING), true);
    assertEquals(shouldLog(LogLevel.INFO, LogLevel.ERROR), true);
    
    assertEquals(shouldLog(LogLevel.ERROR, LogLevel.DEBUG), false);
    assertEquals(shouldLog(LogLevel.ERROR, LogLevel.INFO), false);
    assertEquals(shouldLog(LogLevel.ERROR, LogLevel.WARNING), false);
    assertEquals(shouldLog(LogLevel.ERROR, LogLevel.ERROR), true);
  });
});

Deno.test('WebSocketState enum', async (t) => {
  await t.step('should have correct WebSocket state values', () => {
    assertEquals(WebSocketState.CONNECTING, 'connecting');
    assertEquals(WebSocketState.CONNECTED, 'connected');
    assertEquals(WebSocketState.DISCONNECTED, 'disconnected');
    assertEquals(WebSocketState.RECONNECTING, 'reconnecting');
    assertEquals(WebSocketState.AUTHENTICATING, 'authenticating');
    assertEquals(WebSocketState.ERROR, 'error');
  });

  await t.step('should have all connection states', () => {
    const states = Object.values(WebSocketState);
    assertEquals(states.length, 6);
    assertEquals(states.includes('connecting'), true);
    assertEquals(states.includes('connected'), true);
    assertEquals(states.includes('disconnected'), true);
    assertEquals(states.includes('reconnecting'), true);
    assertEquals(states.includes('authenticating'), true);
    assertEquals(states.includes('error'), true);
  });

  await t.step('should support state transition validation', () => {
    // Valid state transitions
    const validTransitions = new Map([
      [WebSocketState.DISCONNECTED, [WebSocketState.CONNECTING]],
      [WebSocketState.CONNECTING, [WebSocketState.AUTHENTICATING, WebSocketState.ERROR, WebSocketState.DISCONNECTED]],
      [WebSocketState.AUTHENTICATING, [WebSocketState.CONNECTED, WebSocketState.ERROR, WebSocketState.DISCONNECTED]],
      [WebSocketState.CONNECTED, [WebSocketState.DISCONNECTED, WebSocketState.RECONNECTING, WebSocketState.ERROR]],
      [WebSocketState.RECONNECTING, [WebSocketState.CONNECTING, WebSocketState.ERROR, WebSocketState.DISCONNECTED]],
      [WebSocketState.ERROR, [WebSocketState.DISCONNECTED, WebSocketState.RECONNECTING]],
    ]);

    const isValidTransition = (from: WebSocketState, to: WebSocketState): boolean => {
      const allowedStates = validTransitions.get(from) || [];
      return allowedStates.includes(to);
    };

    // Test some valid transitions
    assertEquals(isValidTransition(WebSocketState.DISCONNECTED, WebSocketState.CONNECTING), true);
    assertEquals(isValidTransition(WebSocketState.CONNECTING, WebSocketState.AUTHENTICATING), true);
    assertEquals(isValidTransition(WebSocketState.AUTHENTICATING, WebSocketState.CONNECTED), true);
    assertEquals(isValidTransition(WebSocketState.CONNECTED, WebSocketState.DISCONNECTED), true);

    // Test some invalid transitions
    assertEquals(isValidTransition(WebSocketState.DISCONNECTED, WebSocketState.CONNECTED), false);
    assertEquals(isValidTransition(WebSocketState.CONNECTING, WebSocketState.CONNECTED), false);
  });
});

Deno.test('HVACStatus type structure', async (t) => {
  await t.step('should accept valid HVAC status object', () => {
    const status: HVACStatus = {
      controller: {
        running: true,
        haConnected: true,
        tempSensor: 'sensor.indoor_temperature',
        systemMode: SystemMode.AUTO,
        aiEnabled: false,
      },
      stateMachine: {
        currentState: 'idle',
        hvacMode: HVACMode.OFF,
        conditions: {
          indoorTemp: 22.5,
          outdoorTemp: 15.0,
        },
      },
      timestamp: new Date().toISOString(),
    };

    // Verify the structure is valid TypeScript
    assertEquals(status.controller.running, true);
    assertEquals(status.controller.haConnected, true);
    assertEquals(status.controller.systemMode, SystemMode.AUTO);
    assertEquals(status.stateMachine.currentState, 'idle');
    assertEquals(status.stateMachine.hvacMode, HVACMode.OFF);
    assertEquals(typeof status.timestamp, 'string');
  });

  await t.step('should accept optional AI analysis', () => {
    const statusWithAI: HVACStatus = {
      controller: {
        running: true,
        haConnected: true,
        tempSensor: 'sensor.temp',
        systemMode: SystemMode.AUTO,
        aiEnabled: true,
      },
      stateMachine: {
        currentState: 'heating',
      },
      timestamp: new Date().toISOString(),
      aiAnalysis: 'System is efficiently maintaining target temperature with AI optimization.',
    };

    assertEquals(statusWithAI.aiAnalysis, 'System is efficiently maintaining target temperature with AI optimization.');
    assertEquals(statusWithAI.controller.aiEnabled, true);
  });

  await t.step('should support partial state machine info', () => {
    const minimalStatus: HVACStatus = {
      controller: {
        running: false,
        haConnected: false,
        tempSensor: 'sensor.temp',
        systemMode: SystemMode.OFF,
        aiEnabled: false,
      },
      stateMachine: {
        currentState: 'error',
        // hvacMode and conditions are optional
      },
      timestamp: new Date().toISOString(),
    };

    assertEquals(minimalStatus.stateMachine.hvacMode, undefined);
    assertEquals(minimalStatus.stateMachine.conditions, undefined);
    assertEquals(minimalStatus.stateMachine.currentState, 'error');
  });
});

Deno.test('OperationResult type structure', async (t) => {
  await t.step('should accept successful operation result', () => {
    const successResult: OperationResult = {
      success: true,
      timestamp: new Date().toISOString(),
      data: {
        action: 'heat',
        temperature: 21.0,
        entitiesControlled: ['climate.living_room', 'climate.bedroom'],
      },
    };

    assertEquals(successResult.success, true);
    assertEquals(typeof successResult.timestamp, 'string');
    assertEquals(successResult.data?.action, 'heat');
    assertEquals(successResult.error, undefined);
  });

  await t.step('should accept failed operation result', () => {
    const failureResult: OperationResult = {
      success: false,
      timestamp: new Date().toISOString(),
      error: 'HVAC system not responding to commands',
    };

    assertEquals(failureResult.success, false);
    assertEquals(failureResult.error, 'HVAC system not responding to commands');
    assertEquals(failureResult.data, undefined);
  });

  await t.step('should accept result with both data and error (partial success)', () => {
    const partialResult: OperationResult = {
      success: false,
      timestamp: new Date().toISOString(),
      error: 'Partial failure - some entities did not respond',
      data: {
        attemptedAction: 'cool',
        entitiesProcessed: 3,
        entitiesFailed: 1,
        failedEntities: ['climate.garage'],
        successfulEntities: ['climate.living_room', 'climate.bedroom'],
      },
    };

    assertEquals(partialResult.success, false);
    assertEquals(partialResult.error?.includes('Partial failure'), true);
    assertEquals(partialResult.data?.entitiesProcessed, 3);
    assertEquals(partialResult.data?.entitiesFailed, 1);
  });

  await t.step('should support AI-related operation results', () => {
    const aiResult: OperationResult = {
      success: true,
      timestamp: new Date().toISOString(),
      data: {
        aiAnalysis: 'Temperature differential suggests optimal heating strategy',
        aiConfidence: 0.85,
        aiRecommendations: ['Reduce target temperature by 0.5°C', 'Enable energy-saving mode'],
        executedAction: 'heat',
      },
    };

    assertEquals(aiResult.success, true);
    assertEquals(aiResult.data?.aiConfidence, 0.85);
    assertEquals(Array.isArray(aiResult.data?.aiRecommendations), true);
    assertEquals(aiResult.data?.aiRecommendations?.length, 2);
  });
});

Deno.test('ConnectionStats type structure', async (t) => {
  await t.step('should accept valid connection statistics', () => {
    const stats: ConnectionStats = {
      totalConnections: 5,
      totalReconnections: 2,
      totalMessages: 1250,
      totalErrors: 3,
      lastConnected: new Date(),
      lastError: new Date(),
    };

    assertEquals(stats.totalConnections, 5);
    assertEquals(stats.totalReconnections, 2);
    assertEquals(stats.totalMessages, 1250);
    assertEquals(stats.totalErrors, 3);
    assertInstanceOf(stats.lastConnected, Date);
    assertInstanceOf(stats.lastError, Date);
  });

  await t.step('should accept minimal connection statistics', () => {
    const minimalStats: ConnectionStats = {
      totalConnections: 1,
      totalReconnections: 0,
      totalMessages: 50,
      totalErrors: 0,
    };

    assertEquals(minimalStats.totalConnections, 1);
    assertEquals(minimalStats.totalReconnections, 0);
    assertEquals(minimalStats.totalMessages, 50);
    assertEquals(minimalStats.totalErrors, 0);
    assertEquals(minimalStats.lastConnected, undefined);
    assertEquals(minimalStats.lastError, undefined);
  });

  await t.step('should support calculated metrics', () => {
    const stats: ConnectionStats = {
      totalConnections: 10,
      totalReconnections: 3,
      totalMessages: 5000,
      totalErrors: 15,
      lastConnected: new Date(Date.now() - 3600000), // 1 hour ago
      lastError: new Date(Date.now() - 1800000), // 30 minutes ago
    };

    // Calculate derived metrics
    const errorRate = stats.totalErrors / stats.totalMessages;
    const reconnectionRate = stats.totalReconnections / stats.totalConnections;
    const uptime = stats.lastConnected ? Date.now() - stats.lastConnected.getTime() : 0;

    assertEquals(errorRate, 0.003); // 0.3% error rate
    assertEquals(reconnectionRate, 0.3); // 30% reconnection rate
    assertEquals(uptime, 3600000); // 1 hour uptime
  });
});

Deno.test('Type compatibility and relationships', async (t) => {
  await t.step('should allow HVACMode values in status', () => {
    const status: HVACStatus = {
      controller: {
        running: true,
        haConnected: true,
        tempSensor: 'sensor.temp',
        systemMode: SystemMode.HEAT_ONLY,
        aiEnabled: false,
      },
      stateMachine: {
        currentState: 'heating',
        hvacMode: HVACMode.HEAT, // Should accept HVACMode enum
      },
      timestamp: new Date().toISOString(),
    };

    assertEquals(status.stateMachine.hvacMode, HVACMode.HEAT);
    assertEquals(status.controller.systemMode, SystemMode.HEAT_ONLY);
  });

  await t.step('should allow WebSocketState values in connection tracking', () => {
    // Simulate connection state tracking
    let currentState = WebSocketState.DISCONNECTED;
    
    currentState = WebSocketState.CONNECTING;
    assertEquals(currentState, 'connecting');
    
    currentState = WebSocketState.CONNECTED;
    assertEquals(currentState, 'connected');
    
    currentState = WebSocketState.ERROR;
    assertEquals(currentState, 'error');
  });

  await t.step('should support enum value comparisons', () => {
    // Test that enum values work correctly in comparisons
    const mode1: HVACMode = HVACMode.HEAT;
    const mode2: HVACMode = HVACMode.HEAT;
    const mode3: HVACMode = HVACMode.COOL;

    assertEquals(mode1 === mode2, true);
    assertEquals(mode1 === mode3, false);
    assertEquals(mode1 !== mode3, true);
  });
});

Deno.test('Type guards and utility functions', async (t) => {
  await t.step('should validate operation result structure', () => {
    const isValidOperationResult = (obj: unknown): obj is OperationResult => {
      if (typeof obj !== 'object' || obj === null) return false;
      const result = obj as Record<string, unknown>;
      return (
        typeof result.success === 'boolean' &&
        typeof result.timestamp === 'string' &&
        (result.data === undefined || typeof result.data === 'object') &&
        (result.error === undefined || typeof result.error === 'string')
      );
    };

    const validResult = {
      success: true,
      timestamp: new Date().toISOString(),
      data: { action: 'heat' },
    };

    const invalidResult = {
      success: 'true', // Should be boolean
      timestamp: new Date().toISOString(),
    };

    assertEquals(isValidOperationResult(validResult), true);
    assertEquals(isValidOperationResult(invalidResult), false);
  });

  await t.step('should validate HVAC status structure', () => {
    const isValidHVACStatus = (obj: unknown): obj is HVACStatus => {
      if (typeof obj !== 'object' || obj === null) return false;
      const status = obj as Record<string, unknown>;
      
      return (
        typeof status.controller === 'object' &&
        status.controller !== null &&
        typeof status.stateMachine === 'object' &&
        status.stateMachine !== null &&
        typeof status.timestamp === 'string'
      );
    };

    const validStatus = {
      controller: {
        running: true,
        haConnected: false,
        tempSensor: 'sensor.temp',
        systemMode: 'auto',
        aiEnabled: false,
      },
      stateMachine: {
        currentState: 'idle',
      },
      timestamp: new Date().toISOString(),
    };

    const invalidStatus = {
      controller: 'invalid', // Should be object
      stateMachine: {
        currentState: 'idle',
      },
      timestamp: new Date().toISOString(),
    };

    assertEquals(isValidHVACStatus(validStatus), true);
    assertEquals(isValidHVACStatus(invalidStatus), false);
  });

  await t.step('should create helper functions for enum validation', () => {
    const isValidHVACMode = (value: string): value is HVACMode => {
      return Object.values(HVACMode).includes(value as HVACMode);
    };

    const isValidSystemMode = (value: string): value is SystemMode => {
      return Object.values(SystemMode).includes(value as SystemMode);
    };

    const isValidLogLevel = (value: string): value is LogLevel => {
      return Object.values(LogLevel).includes(value as LogLevel);
    };

    // Test HVAC mode validation
    assertEquals(isValidHVACMode('heat'), true);
    assertEquals(isValidHVACMode('cool'), true);
    assertEquals(isValidHVACMode('invalid'), false);

    // Test system mode validation
    assertEquals(isValidSystemMode('auto'), true);
    assertEquals(isValidSystemMode('heat_only'), true);
    assertEquals(isValidSystemMode('invalid'), false);

    // Test log level validation
    assertEquals(isValidLogLevel('debug'), true);
    assertEquals(isValidLogLevel('info'), true);
    assertEquals(isValidLogLevel('invalid'), false);
  });
});