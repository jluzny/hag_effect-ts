/**
 * Home Assistant data models for HAG Effect-TS variant.
 * 
 * Effect-native models with immutable data structures and proper error handling.
 */

import { Data } from 'effect';
import { HassState, HassEvent, HassStateChangeData, HassServiceCall, WebSocketMessage } from '../types/common.ts';
import { ValidationError as _ValidationError, ErrorUtils } from '../core/exceptions.ts';

/**
 * Home Assistant authentication response
 */
export interface HassAuthResponse {
  readonly type: 'auth_ok' | 'auth_invalid' | 'auth_required';
  readonly message?: string;
  readonly haVersion?: string;
}

/**
 * Home Assistant WebSocket command types
 */
export const HassCommandType = {
  AUTH: 'auth',
  SUBSCRIBE_EVENTS: 'subscribe_events',
  UNSUBSCRIBE_EVENTS: 'unsubscribe_events',
  GET_STATES: 'get_states',
  GET_STATE: 'get_state',
  CALL_SERVICE: 'call_service',
  PING: 'ping',
  PONG: 'pong',
} as const;

export type HassCommandType = typeof HassCommandType[keyof typeof HassCommandType];

/**
 * Enhanced WebSocket message with HAG-specific properties
 */
export interface HagWebSocketMessage extends WebSocketMessage {
  success?: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
  target?: {
    entity_id?: string | readonly string[];
    device_id?: string | readonly string[];
    area_id?: string | readonly string[];
  };
}

/**
 * Home Assistant state implementation using Effect Data
 */
export class HassStateImpl extends Data.Class<{
  readonly entityId: string;
  readonly state: string;
  readonly attributes: Record<string, unknown>;
  readonly lastChanged: Date;
  readonly lastUpdated: Date;
}> implements HassState {
  /**
   * Get numeric state value if possible
   */
  getNumericState(): number | null {
    const numericValue = parseFloat(this.state);
    return isNaN(numericValue) ? null : numericValue;
  }

  /**
   * Check if state represents a valid numeric temperature
   */
  isValidTemperature(): boolean {
    const temp = this.getNumericState();
    return temp !== null && temp >= -50 && temp <= 60;
  }

  /**
   * Get unit of measurement from attributes
   */
  getUnit(): string | null {
    return this.attributes.unit_of_measurement as string || null;
  }

  /**
   * Create from Home Assistant API response with validation
   */
  static fromApiResponse(data: Record<string, unknown>): HassStateImpl {
    if (!data.entity_id || typeof data.entity_id !== 'string') {
      throw ErrorUtils.validationError(
        'Invalid entity_id in state data',
        'entity_id',
        'string',
        data.entity_id
      );
    }

    if (data.state === undefined || data.state === null) {
      throw ErrorUtils.validationError(
        'Invalid state in state data',
        'state',
        'string',
        data.state
      );
    }

    const lastChanged = data.last_changed ? new Date(data.last_changed as string) : new Date();
    const lastUpdated = data.last_updated ? new Date(data.last_updated as string) : new Date();
    const attributes = data.attributes as Record<string, unknown> ?? {};

    return new HassStateImpl({
      entityId: data.entity_id,
      state: String(data.state),
      attributes,
      lastChanged,
      lastUpdated,
    });
  }
}

/**
 * Home Assistant event implementation using Effect Data
 */
export class HassEventImpl extends Data.Class<{
  readonly eventType: string;
  readonly data: Record<string, unknown>;
  readonly origin: string;
  readonly timeFired: Date;
}> implements HassEvent {
  /**
   * Check if this is a state change event
   */
  isStateChanged(): boolean {
    return this.eventType === 'state_changed';
  }

  /**
   * Get state change data if this is a state change event
   */
  getStateChangeData(): HassStateChangeData | null {
    if (!this.isStateChanged()) {
      return null;
    }

    const entityId = this.data.entity_id as string;
    if (!entityId) {
      return null;
    }

    const newState = this.data.new_state
      ? HassStateImpl.fromApiResponse(this.data.new_state as Record<string, unknown>)
      : null;

    const oldState = this.data.old_state
      ? HassStateImpl.fromApiResponse(this.data.old_state as Record<string, unknown>)
      : null;

    return {
      entityId,
      newState,
      oldState,
    } as const;
  }

  /**
   * Create from Home Assistant WebSocket event with validation
   */
  static fromWebSocketEvent(data: Record<string, unknown>): HassEventImpl {
    const event = data.event as Record<string, unknown>;
    if (!event) {
      throw ErrorUtils.validationError('Invalid event data', 'event', 'object', data);
    }

    const eventType = event.event_type as string;
    if (!eventType) {
      throw ErrorUtils.validationError(
        'Invalid event_type',
        'event_type',
        'string',
        event.event_type
      );
    }

    const eventData = event.data as Record<string, unknown> ?? {};
    const origin = event.origin as string ?? 'LOCAL';
    const timeFired = event.time_fired ? new Date(event.time_fired as string) : new Date();

    return new HassEventImpl({
      eventType,
      data: eventData,
      origin,
      timeFired,
    });
  }
}

/**
 * Home Assistant service call implementation using Effect Data
 */
export class HassServiceCallImpl extends Data.Class<{
  readonly domain: string;
  readonly service: string;
  readonly serviceData: Record<string, unknown>;
  readonly target?: {
    readonly entityId?: string | readonly string[];
    readonly deviceId?: string | readonly string[];
    readonly areaId?: string | readonly string[];
  };
}> implements HassServiceCall {
  /**
   * Convert to WebSocket message format
   */
  toWebSocketMessage(id: number): HagWebSocketMessage {
    const message: HagWebSocketMessage = {
      id,
      type: HassCommandType.CALL_SERVICE,
      domain: this.domain,
      service: this.service,
      service_data: this.serviceData,
    };

    if (this.target) {
      message.target = {
        entity_id: this.target.entityId,
        device_id: this.target.deviceId,
        area_id: this.target.areaId,
      };
    }

    return message;
  }

  /**
   * Create climate service call
   */
  static climate(
    service: 'set_hvac_mode' | 'set_temperature' | 'set_preset_mode',
    entityId: string,
    data: Record<string, unknown>,
  ): HassServiceCallImpl {
    return new HassServiceCallImpl({
      domain: 'climate',
      service,
      serviceData: { entity_id: entityId, ...data },
    });
  }

  /**
   * Create homeassistant service call
   */
  static homeassistant(
    service: 'update_entity' | 'reload_config_entry',
    entityId?: string,
  ): HassServiceCallImpl {
    const serviceData = entityId ? { entity_id: entityId } : {};
    return new HassServiceCallImpl({
      domain: 'homeassistant',
      service,
      serviceData,
    });
  }
}

/**
 * WebSocket connection state using const assertions for type safety
 */
export const WebSocketState = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  AUTHENTICATING: 'authenticating',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
} as const;

export type WebSocketState = typeof WebSocketState[keyof typeof WebSocketState];

/**
 * Connection statistics using immutable data structure
 */
export interface ConnectionStats {
  readonly totalConnections: number;
  readonly totalReconnections: number;
  readonly totalMessages: number;
  readonly totalErrors: number;
  readonly lastConnected?: Date;
  readonly lastError?: Date;
  readonly averageLatency?: number;
}

/**
 * Utility functions for Home Assistant data using functional patterns
 */
export const HassUtils = {
  /**
   * Check if entity ID is valid format
   */
  isValidEntityId: (entityId: string): entityId is string => {
    const parts = entityId.split('.');
    return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
  },

  /**
   * Extract domain from entity ID
   */
  getDomain: (entityId: string): string => {
    return entityId.split('.')[0] ?? '';
  },

  /**
   * Extract entity name from entity ID
   */
  getEntityName: (entityId: string): string => {
    return entityId.split('.')[1] ?? '';
  },

  /**
   * Check if entity is a sensor
   */
  isSensor: (entityId: string): boolean => {
    return HassUtils.getDomain(entityId) === 'sensor';
  },

  /**
   * Check if entity is a climate device
   */
  isClimate: (entityId: string): boolean => {
    return HassUtils.getDomain(entityId) === 'climate';
  },

  /**
   * Parse Home Assistant timestamp
   */
  parseTimestamp: (timestamp: string | Date): Date => {
    if (timestamp instanceof Date) {
      return timestamp;
    }
    return new Date(timestamp);
  },

  /**
   * Create a safe state update preserving immutability
   */
  updateState: (
    current: HassStateImpl,
    updates: Partial<{
      state: string;
      attributes: Record<string, unknown>;
    }>
  ): HassStateImpl => {
    return new HassStateImpl({
      ...current,
      ...updates,
      lastUpdated: new Date(),
    });
  },
} as const;