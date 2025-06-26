/**
 * Common types for HAG Effect-TS variant.
 * 
 * Shared type definitions used throughout the application with Effect-TS patterns.
 */

/**
 * System operation modes
 */
export const SystemMode = {
  AUTO: 'auto',
  HEAT_ONLY: 'heat_only',
  COOL_ONLY: 'cool_only', 
  OFF: 'off',
} as const;

export type SystemMode = typeof SystemMode[keyof typeof SystemMode];

/**
 * HVAC operational modes
 */
export const HVACMode = {
  HEAT: 'heat',
  COOL: 'cool',
  OFF: 'off',
} as const;

export type HVACMode = typeof HVACMode[keyof typeof HVACMode];

/**
 * Log levels for application logging
 */
export const LogLevel = {
  DEBUG: 'debug',
  INFO: 'info',
  WARNING: 'warning', 
  ERROR: 'error',
} as const;

export type LogLevel = typeof LogLevel[keyof typeof LogLevel];

/**
 * Temperature thresholds for heating/cooling operations
 */
export interface TemperatureThresholds {
  readonly indoorMin: number;
  readonly indoorMax: number;
  readonly outdoorMin: number;
  readonly outdoorMax: number;
}

/**
 * Defrost cycle configuration
 */
export interface DefrostOptions {
  readonly temperatureThreshold: number;
  readonly periodSeconds: number;
  readonly durationSeconds: number;
}

/**
 * Active hours configuration for HVAC operation
 */
export interface ActiveHours {
  readonly start: number;
  readonly startWeekday: number;
  readonly end: number;
}

/**
 * HVAC entity configuration
 */
export interface HvacEntity {
  readonly entityId: string;
  readonly enabled: boolean;
  readonly defrost: boolean;
}

/**
 * Home Assistant entity state
 */
export interface HassState {
  readonly entityId: string;
  readonly state: string;
  readonly attributes: Record<string, unknown>;
  readonly lastChanged: Date;
  readonly lastUpdated: Date;
}

/**
 * Home Assistant event data
 */
export interface HassEvent {
  readonly eventType: string;
  readonly data: Record<string, unknown>;
  readonly origin: string;
  readonly timeFired: Date;
}

/**
 * State change data from Home Assistant
 */
export interface HassStateChangeData {
  readonly entityId: string;
  readonly newState: HassState | null;
  readonly oldState: HassState | null;
}

/**
 * Service call data for Home Assistant
 */
export interface HassServiceCall {
  readonly domain: string;
  readonly service: string;
  readonly serviceData: Record<string, unknown>;
  readonly target?: {
    readonly entityId?: string | readonly string[];
    readonly deviceId?: string | readonly string[];
    readonly areaId?: string | readonly string[];
  };
}

/**
 * WebSocket message structure
 */
export interface WebSocketMessage {
  readonly id?: number;
  readonly type: string;
  readonly [key: string]: unknown;
}

/**
 * HVAC state machine context
 */
export interface HVACContext {
  readonly indoorTemp?: number;
  readonly outdoorTemp?: number;
  readonly currentHour: number;
  readonly isWeekday: boolean;
  readonly lastDefrost?: Date;
  readonly systemMode: SystemMode;
}

/**
 * State change data for HVAC strategies
 */
export interface StateChangeData {
  readonly currentTemp: number;
  readonly weatherTemp: number;
  readonly hour: number;
  readonly isWeekday: boolean;
}

/**
 * HVAC system status
 */
export interface HVACStatus {
  readonly controller: {
    readonly running: boolean;
    readonly haConnected: boolean;
    readonly tempSensor: string;
    readonly systemMode: string;
    readonly aiEnabled: boolean;
  };
  readonly stateMachine: {
    readonly currentState: string;
    readonly hvacMode?: string;
    readonly conditions?: HVACContext;
  };
  readonly timestamp: string;
  readonly aiAnalysis?: string;
}

/**
 * Generic result type for operations with Effect-style success/failure
 */
export interface OperationResult<T = unknown> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: string;
  readonly timestamp: string;
}

/**
 * Type predicates for runtime type checking
 */
export const TypePredicates = {
  isSystemMode: (value: unknown): value is SystemMode =>
    typeof value === 'string' && 
    Object.values(SystemMode).includes(value as SystemMode),
    
  isHVACMode: (value: unknown): value is HVACMode =>
    typeof value === 'string' && 
    Object.values(HVACMode).includes(value as HVACMode),
    
  isLogLevel: (value: unknown): value is LogLevel =>
    typeof value === 'string' && 
    Object.values(LogLevel).includes(value as LogLevel),
    
  isNumber: (value: unknown): value is number =>
    typeof value === 'number' && !isNaN(value),
    
  isString: (value: unknown): value is string =>
    typeof value === 'string',
    
  isObject: (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value),
} as const;