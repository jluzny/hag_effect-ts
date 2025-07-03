/**
 * Common types for HAG JavaScript variant.
 * 
 * Shared type definitions used throughout the application.
 */

/**
 * System operation modes
 */
export enum SystemMode {
  AUTO = 'auto',
  HEAT_ONLY = 'heat_only', 
  COOL_ONLY = 'cool_only',
  OFF = 'off',
}

/**
 * HVAC operational modes
 */
export enum HVACMode {
  HEAT = 'heat',
  COOL = 'cool',
  OFF = 'off',
  AUTO = 'auto',
}

/**
 * Log levels for application logging
 */
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info', 
  WARNING = 'warning',
  ERROR = 'error',
}

/**
 * Temperature thresholds for heating/cooling operations
 */
export interface TemperatureThresholds {
  indoorMin: number;
  indoorMax: number;
  outdoorMin: number;
  outdoorMax: number;
}

/**
 * Defrost cycle configuration
 */
export interface DefrostOptions {
  temperatureThreshold: number;
  periodSeconds: number;
  durationSeconds: number;
}

/**
 * Active hours configuration for HVAC operation
 */
export interface ActiveHours {
  start: number;
  startWeekday: number;
  end: number;
}

/**
 * HVAC entity configuration
 */
export interface HvacEntity {
  entityId: string;
  enabled: boolean;
  defrost: boolean;
}

/**
 * Home Assistant entity state
 */
export interface HassState {
  entityId: string;
  state: string;
  attributes: Record<string, unknown>;
  lastChanged: Date;
  lastUpdated: Date;
}

/**
 * Home Assistant event data
 */
export interface HassEvent {
  eventType: string;
  data: Record<string, unknown>;
  origin: string;
  timeFired: Date;
}

/**
 * State change data from Home Assistant
 */
export interface HassStateChangeData {
  entityId: string;
  newState: HassState | null;
  oldState: HassState | null;
}

/**
 * Service call data for Home Assistant
 */
export interface HassServiceCall {
  domain: string;
  service: string;
  serviceData: Record<string, unknown>;
  target?: {
    entityId?: string | string[];
    deviceId?: string | string[];
    areaId?: string | string[];
  };
}

/**
 * WebSocket message structure
 */
export interface WebSocketMessage {
  id?: number;
  type: string;
  [key: string]: unknown;
}

/**
 * HVAC state machine context
 */
export interface HVACContext {
  indoorTemp?: number;
  outdoorTemp?: number;
  currentHour: number;
  isWeekday: boolean;
  lastDefrost?: Date;
  systemMode: SystemMode;
}

/**
 * State change data for HVAC strategies
 */
export interface StateChangeData {
  currentTemp: number;
  weatherTemp: number;
  hour: number;
  isWeekday: boolean;
}

/**
 * HVAC system status
 */
export interface HVACStatus {
  controller: {
    running: boolean;
    haConnected: boolean;
    tempSensor: string;
    systemMode: string;
    aiEnabled: boolean;
  };
  stateMachine: {
    currentState: string;
    hvacMode?: string;
    conditions?: HVACContext;
  };
  timestamp: string;
  aiAnalysis?: string;
}

/**
 * WebSocket connection states
 */
export enum WebSocketState {
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  RECONNECTING = 'reconnecting',
  AUTHENTICATING = 'authenticating',
  ERROR = 'error',
}

/**
 * Connection statistics
 */
export interface ConnectionStats {
  totalConnections: number;
  totalReconnections: number;
  totalMessages: number;
  totalErrors: number;
  lastConnected?: Date;
  lastError?: Date;
}

/**
 * Generic result type for operations
 */
export interface OperationResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

/**
 * Type guards for runtime type checking
 */
export const TypeGuards = {
  isSystemMode: (value: unknown): value is SystemMode =>
    typeof value === 'string' && Object.values(SystemMode).includes(value as SystemMode),
    
  isHVACMode: (value: unknown): value is HVACMode =>
    typeof value === 'string' && Object.values(HVACMode).includes(value as HVACMode),
    
  isLogLevel: (value: unknown): value is LogLevel =>
    typeof value === 'string' && Object.values(LogLevel).includes(value as LogLevel),
    
  isNumber: (value: unknown): value is number =>
    typeof value === 'number' && !isNaN(value),
    
  isString: (value: unknown): value is string =>
    typeof value === 'string',
    
  isObject: (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value),
} as const;
