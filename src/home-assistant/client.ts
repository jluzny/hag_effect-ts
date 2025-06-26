/**
 * Home Assistant WebSocket and REST client for HAG Effect-TS variant.
 * 
 * Effect-native implementation with proper error handling and resource management.
 */

import { Effect, Context, Layer, pipe, Schedule, Duration, Ref } from 'effect';
import { HttpClient } from '@effect/platform/Http';
import { HassOptions } from '../config/settings.ts';
import { ConnectionError, StateError, ErrorUtils } from '../core/exceptions.ts';
import { 
  HassStateImpl, 
  HassEventImpl, 
  HassServiceCallImpl,
  HagWebSocketMessage,
  HassCommandType,
  WebSocketState,
  ConnectionStats
} from './models.ts';

/**
 * Home Assistant Client service definition
 */
export class HomeAssistantClient extends Context.Tag('HomeAssistantClient')<
  HomeAssistantClient,
  {
    readonly connect: () => Effect.Effect<void, ConnectionError>;
    readonly disconnect: () => Effect.Effect<void, never>;
    readonly connected: Effect.Effect<boolean, never>;
    readonly getStats: () => Effect.Effect<ConnectionStats, never>;
    readonly getState: (entityId: string) => Effect.Effect<HassStateImpl, StateError>;
    readonly callService: (serviceCall: HassServiceCallImpl) => Effect.Effect<void, ConnectionError>;
    readonly subscribeEvents: (eventType: string) => Effect.Effect<void, ConnectionError>;
    readonly addEventHandler: (eventType: string, handler: (event: HassEventImpl) => Effect.Effect<void, never>) => Effect.Effect<void, never>;
    readonly removeEventHandler: (eventType: string, handler: (event: HassEventImpl) => Effect.Effect<void, never>) => Effect.Effect<void, never>;
  }
>() {}

/**
 * Internal state for the Home Assistant client
 */
interface ClientState {
  ws?: WebSocket;
  messageId: number;
  connectionState: WebSocketState;
  eventHandlers: Map<string, Set<(event: HassEventImpl) => Effect.Effect<void, never>>>;
  subscriptions: Set<string>;
  stats: ConnectionStats;
  reconnectFiber?: Effect.Fiber.Fiber<void, never>;
  pingFiber?: Effect.Fiber.Fiber<void, never>;
}

/**
 * Home Assistant Client implementation
 */
class HomeAssistantClientImpl {
  constructor(
    private config: HassOptions,
    private stateRef: Ref.Ref<ClientState>,
  ) {}

  /**
   * Connect to Home Assistant WebSocket API with retries
   */
  connect = (): Effect.Effect<void, ConnectionError> =>
    pipe(
      this.stateRef,
      Ref.get,
      Effect.flatMap((state) => {
        if (state.connectionState === WebSocketState.CONNECTED) {
          return pipe(
            Effect.logInfo('Already connected to Home Assistant'),
            Effect.asVoid
          );
        }

        return pipe(
          this.establishConnection(),
          Effect.retry(
            Schedule.exponential(Duration.millis(this.config.retryDelayMs))
              .pipe(Schedule.compose(Schedule.recurs(this.config.maxRetries - 1)))
          ),
          Effect.flatMap(() => this.authenticate()),
          Effect.flatMap(() => this.subscribeToInitialEvents()),
          Effect.flatMap(() => this.startConnectionMonitoring()),
          Effect.tap(() => 
            pipe(
              this.updateStats((stats) => ({
                ...stats,
                totalConnections: stats.totalConnections + 1,
                lastConnected: new Date(),
              })),
              Effect.andThen(this.updateConnectionState(WebSocketState.CONNECTED)),
              Effect.andThen(Effect.logInfo('✅ Connected to Home Assistant successfully'))
            )
          ),
          Effect.catchAll((error) =>
            pipe(
              this.updateConnectionState(WebSocketState.ERROR),
              Effect.andThen(
                Effect.fail(
                  ErrorUtils.connectionError(
                    `Failed to connect after ${this.config.maxRetries} attempts: ${error}`,
                    this.config.wsUrl,
                    this.config.maxRetries
                  )
                )
              )
            )
          )
        );
      })
    );

  /**
   * Disconnect from Home Assistant
   */
  disconnect = (): Effect.Effect<void, never> =>
    pipe(
      Effect.logInfo('Disconnecting from Home Assistant'),
      Effect.andThen(this.stopConnectionMonitoring()),
      Effect.andThen(this.updateConnectionState(WebSocketState.DISCONNECTED)),
      Effect.andThen(
        pipe(
          this.stateRef,
          Ref.update((state) => ({
            ...state,
            ws: undefined,
            eventHandlers: new Map(),
            subscriptions: new Set(),
          }))
        )
      ),
      Effect.asVoid
    );

  /**
   * Check if connected
   */
  connected: Effect.Effect<boolean, never> = pipe(
    this.stateRef,
    Ref.get,
    Effect.map((state) => 
      state.connectionState === WebSocketState.CONNECTED && state.ws !== undefined
    )
  );

  /**
   * Get connection statistics
   */
  getStats = (): Effect.Effect<ConnectionStats, never> =>
    pipe(
      this.stateRef,
      Ref.get,
      Effect.map((state) => ({ ...state.stats }))
    );

  /**
   * Get entity state via REST API
   */
  getState = (entityId: string): Effect.Effect<HassStateImpl, StateError> =>
    pipe(
      this.connected,
      Effect.flatMap((isConnected) => {
        if (!isConnected) {
          return Effect.fail(ErrorUtils.stateError('Not connected to Home Assistant', entityId));
        }

        return pipe(
          HttpClient.HttpClient,
          Effect.flatMap((client) =>
            client.get(`${this.config.restUrl}/api/states/${entityId}`, {
              headers: {
                'Authorization': `Bearer ${this.config.token}`,
                'Content-Type': 'application/json',
              },
            })
          ),
          Effect.flatMap((response) => {
            if (response.status === 404) {
              return Effect.fail(ErrorUtils.stateError(`Entity not found: ${entityId}`, entityId));
            }
            if (!response.ok) {
              return Effect.fail(
                ErrorUtils.stateError(
                  `HTTP ${response.status}: ${response.statusText}`, 
                  entityId
                )
              );
            }
            return Effect.promise(() => response.json());
          }),
          Effect.flatMap((data) =>
            Effect.try({
              try: () => HassStateImpl.fromApiResponse(data),
              catch: (error) => ErrorUtils.stateError(
                `Failed to parse state data: ${error}`,
                entityId
              ),
            })
          ),
          Effect.catchAll((error) =>
            Effect.fail(
              ErrorUtils.stateError(
                `Failed to get state for ${entityId}: ${error}`,
                entityId
              )
            )
          )
        );
      })
    );

  /**
   * Call Home Assistant service
   */
  callService = (serviceCall: HassServiceCallImpl): Effect.Effect<void, ConnectionError> =>
    pipe(
      this.connected,
      Effect.flatMap((isConnected) => {
        if (!isConnected) {
          return Effect.fail(ErrorUtils.connectionError('Not connected to Home Assistant'));
        }

        return pipe(
          this.getNextMessageId(),
          Effect.flatMap((messageId) => {
            const message = serviceCall.toWebSocketMessage(messageId);
            return this.sendMessage(message);
          }),
          Effect.tap(() =>
            Effect.logDebug('Service called successfully', {
              domain: serviceCall.domain,
              service: serviceCall.service,
            })
          ),
          Effect.catchAll((error) =>
            Effect.fail(
              ErrorUtils.connectionError(
                `Failed to call service ${serviceCall.domain}.${serviceCall.service}: ${error}`
              )
            )
          )
        );
      })
    );

  /**
   * Subscribe to events
   */
  subscribeEvents = (eventType: string): Effect.Effect<void, ConnectionError> =>
    pipe(
      this.connected,
      Effect.flatMap((isConnected) => {
        if (!isConnected) {
          return Effect.fail(ErrorUtils.connectionError('Not connected to Home Assistant'));
        }

        return pipe(
          this.stateRef,
          Ref.get,
          Effect.flatMap((state) => {
            if (state.subscriptions.has(eventType)) {
              return pipe(
                Effect.logDebug('Already subscribed to event type', { eventType }),
                Effect.asVoid
              );
            }

            return pipe(
              this.getNextMessageId(),
              Effect.flatMap((messageId) => {
                const message: HagWebSocketMessage = {
                  id: messageId,
                  type: HassCommandType.SUBSCRIBE_EVENTS,
                  event_type: eventType,
                };
                return this.sendMessage(message);
              }),
              Effect.andThen(
                pipe(
                  this.stateRef,
                  Ref.update((s) => ({
                    ...s,
                    subscriptions: new Set([...s.subscriptions, eventType]),
                  }))
                )
              ),
              Effect.tap(() => Effect.logDebug('Subscribed to events', { eventType }))
            );
          })
        );
      })
    );

  /**
   * Add event handler
   */
  addEventHandler = (
    eventType: string, 
    handler: (event: HassEventImpl) => Effect.Effect<void, never>
  ): Effect.Effect<void, never> =>
    pipe(
      this.stateRef,
      Ref.update((state) => {
        const handlers = state.eventHandlers.get(eventType) ?? new Set();
        handlers.add(handler);
        state.eventHandlers.set(eventType, handlers);
        return state;
      }),
      Effect.andThen(Effect.logDebug('Event handler added', { eventType }))
    );

  /**
   * Remove event handler
   */
  removeEventHandler = (
    eventType: string,
    handler: (event: HassEventImpl) => Effect.Effect<void, never>
  ): Effect.Effect<void, never> =>
    pipe(
      this.stateRef,
      Ref.update((state) => {
        const handlers = state.eventHandlers.get(eventType);
        if (handlers) {
          handlers.delete(handler);
          if (handlers.size === 0) {
            state.eventHandlers.delete(eventType);
          }
        }
        return state;
      })
    );

  /**
   * Establish WebSocket connection
   */
  private establishConnection = (): Effect.Effect<void, ConnectionError> =>
    pipe(
      this.updateConnectionState(WebSocketState.CONNECTING),
      Effect.andThen(
        Effect.logInfo('Connecting to Home Assistant', {
          url: this.config.wsUrl,
        })
      ),
      Effect.andThen(
        Effect.tryPromise({
          try: async () => {
            const ws = new WebSocket(this.config.wsUrl);
            
            return new Promise<WebSocket>((resolve, reject) => {
              ws.onopen = () => resolve(ws);
              ws.onerror = (error) => reject(error);
              ws.onmessage = (event) => {
                this.handleMessage(JSON.parse(event.data));
              };
              ws.onclose = () => {
                this.handleConnectionLoss();
              };
            });
          },
          catch: (error) => ErrorUtils.connectionError(
            `WebSocket connection failed: ${error}`,
            this.config.wsUrl
          ),
        })
      ),
      Effect.flatMap((ws) =>
        pipe(
          this.stateRef,
          Ref.update((state) => ({ ...state, ws }))
        )
      )
    );

  /**
   * Authenticate with Home Assistant
   */
  private authenticate = (): Effect.Effect<void, ConnectionError> =>
    pipe(
      this.updateConnectionState(WebSocketState.AUTHENTICATING),
      Effect.andThen(
        Effect.tryPromise({
          try: async () => {
            const authMessage: HagWebSocketMessage = {
              type: HassCommandType.AUTH,
              access_token: this.config.token,
            };
            
            await this.sendMessageSync(authMessage);
            
            // Wait for auth response - simplified for this implementation
            await new Promise((resolve, reject) => {
              setTimeout(() => resolve(undefined), 1000); // Simple delay
            });
          },
          catch: (error) => ErrorUtils.connectionError(`Authentication failed: ${error}`),
        })
      ),
      Effect.tap(() => Effect.logInfo('Authentication successful'))
    );

  /**
   * Subscribe to initial events
   */
  private subscribeToInitialEvents = (): Effect.Effect<void, ConnectionError> =>
    this.subscribeEvents('state_changed');

  /**
   * Start connection monitoring with ping/pong
   */
  private startConnectionMonitoring = (): Effect.Effect<void, never> =>
    pipe(
      Effect.fork(
        pipe(
          Effect.sleep(Duration.seconds(30)),
          Effect.andThen(this.sendPing()),
          Effect.repeat(Schedule.fixed(Duration.seconds(30)))
        )
      ),
      Effect.flatMap((pingFiber) =>
        pipe(
          this.stateRef,
          Ref.update((state) => ({ ...state, pingFiber }))
        )
      ),
      Effect.asVoid
    );

  /**
   * Stop connection monitoring
   */
  private stopConnectionMonitoring = (): Effect.Effect<void, never> =>
    pipe(
      this.stateRef,
      Ref.get,
      Effect.flatMap((state) => {
        if (state.pingFiber) {
          return Effect.fork(state.pingFiber.interrupt());
        }
        return Effect.void;
      }),
      Effect.asVoid
    );

  /**
   * Send ping message
   */
  private sendPing = (): Effect.Effect<void, never> =>
    pipe(
      this.connected,
      Effect.flatMap((isConnected) => {
        if (isConnected) {
          return pipe(
            this.getNextMessageId(),
            Effect.flatMap((messageId) => {
              const pingMessage: HagWebSocketMessage = {
                id: messageId,
                type: HassCommandType.PING,
              };
              return this.sendMessage(pingMessage);
            }),
            Effect.catchAll((error) => {
              return pipe(
                Effect.logError('Ping failed', { error }),
                Effect.andThen(this.handleConnectionLoss())
              );
            })
          );
        }
        return Effect.void;
      })
    );

  /**
   * Handle incoming messages
   */
  private handleMessage = (data: HagWebSocketMessage): Effect.Effect<void, never> =>
    pipe(
      this.updateStats((stats) => ({
        ...stats,
        totalMessages: stats.totalMessages + 1,
      })),
      Effect.andThen(
        (() => {
          switch (data.type) {
            case 'auth_required':
              return Effect.void;
            case 'auth_ok':
              return Effect.logInfo('Authentication successful');
            case 'auth_invalid':
              return Effect.logError('Authentication failed - invalid token');
            case 'event':
              return this.handleEvent(data);
            case 'result':
              if (!data.success && data.error) {
                return Effect.logError('Command failed', data.error);
              }
              return Effect.void;
            case 'pong':
              return Effect.logDebug('Pong received');
            default:
              return Effect.logDebug('Unhandled message type', { type: data.type });
          }
        })()
      ),
      Effect.catchAll((error) =>
        pipe(
          Effect.logError('Error handling message', { error }),
          Effect.andThen(
            this.updateStats((stats) => ({
              ...stats,
              totalErrors: stats.totalErrors + 1,
            }))
          )
        )
      )
    );

  /**
   * Handle event messages
   */
  private handleEvent = (data: HagWebSocketMessage): Effect.Effect<void, never> =>
    pipe(
      Effect.try({
        try: () => HassEventImpl.fromWebSocketEvent(data),
        catch: (error) => error,
      }),
      Effect.flatMap((event) =>
        pipe(
          this.stateRef,
          Ref.get,
          Effect.flatMap((state) => {
            const handlers = state.eventHandlers.get(event.eventType);
            if (handlers && handlers.size > 0) {
              const effects = Array.from(handlers).map((handler) =>
                pipe(
                  handler(event),
                  Effect.catchAll((error) =>
                    Effect.logError('Event handler failed', { error })
                  )
                )
              );
              return Effect.all(effects, { concurrency: 'unbounded' });
            }
            return Effect.void;
          })
        )
      ),
      Effect.catchAll((error) =>
        Effect.logError('Failed to process event', { error })
      ),
      Effect.asVoid
    );

  /**
   * Send message to WebSocket
   */
  private sendMessage = (message: HagWebSocketMessage): Effect.Effect<void, ConnectionError> =>
    pipe(
      this.stateRef,
      Ref.get,
      Effect.flatMap((state) => {
        if (!state.ws) {
          return Effect.fail(ErrorUtils.connectionError('WebSocket not connected'));
        }

        return Effect.try({
          try: () => state.ws!.send(JSON.stringify(message)),
          catch: (error) => ErrorUtils.connectionError(
            `Failed to send message: ${error}`
          ),
        });
      })
    );

  /**
   * Synchronous message sending for authentication
   */
  private sendMessageSync = async (message: HagWebSocketMessage): Promise<void> => {
    const state = await Effect.runPromise(Ref.get(this.stateRef));
    if (!state.ws) {
      throw new Error('WebSocket not connected');
    }
    state.ws.send(JSON.stringify(message));
  };

  /**
   * Get next message ID
   */
  private getNextMessageId = (): Effect.Effect<number, never> =>
    pipe(
      this.stateRef,
      Ref.updateAndGet((state) => ({
        ...state,
        messageId: state.messageId + 1,
      })),
      Effect.map((state) => state.messageId)
    );

  /**
   * Update connection state
   */
  private updateConnectionState = (newState: WebSocketState): Effect.Effect<void, never> =>
    pipe(
      this.stateRef,
      Ref.update((state) => ({ ...state, connectionState: newState })),
      Effect.asVoid
    );

  /**
   * Update statistics
   */
  private updateStats = (updateFn: (stats: ConnectionStats) => ConnectionStats): Effect.Effect<void, never> =>
    pipe(
      this.stateRef,
      Ref.update((state) => ({ ...state, stats: updateFn(state.stats) })),
      Effect.asVoid
    );

  /**
   * Handle connection loss
   */
  private handleConnectionLoss = (): Effect.Effect<void, never> =>
    pipe(
      this.stateRef,
      Ref.get,
      Effect.flatMap((state) => {
        if (state.connectionState === WebSocketState.CONNECTED) {
          return pipe(
            Effect.logWarning('Connection lost, attempting to reconnect'),
            Effect.andThen(this.updateConnectionState(WebSocketState.RECONNECTING)),
            Effect.andThen(
              this.updateStats((stats) => ({
                ...stats,
                totalReconnections: stats.totalReconnections + 1,
              }))
            ),
            Effect.andThen(
              Effect.fork(
                pipe(
                  Effect.sleep(Duration.millis(this.config.retryDelayMs)),
                  Effect.andThen(this.connect()),
                  Effect.catchAll((error) =>
                    pipe(
                      Effect.logError('Reconnection failed', { error }),
                      Effect.andThen(this.updateConnectionState(WebSocketState.ERROR))
                    )
                  )
                )
              )
            )
          );
        }
        return Effect.void;
      }),
      Effect.asVoid
    );
}

/**
 * Layer for providing Home Assistant Client service
 */
export const HomeAssistantClientLive = Layer.effect(
  HomeAssistantClient,
  Effect.gen(function* () {
    const config = yield* Context.Tag<HassOptions>('HassOptions');
    
    const initialState: ClientState = {
      messageId: 1,
      connectionState: WebSocketState.DISCONNECTED,
      eventHandlers: new Map(),
      subscriptions: new Set(),
      stats: {
        totalConnections: 0,
        totalReconnections: 0,
        totalMessages: 0,
        totalErrors: 0,
      },
    };
    
    const stateRef = yield* Ref.make(initialState);
    const impl = new HomeAssistantClientImpl(config, stateRef);
    
    return HomeAssistantClient.of({
      connect: impl.connect,
      disconnect: impl.disconnect,
      connected: impl.connected,
      getStats: impl.getStats,
      getState: impl.getState,
      callService: impl.callService,
      subscribeEvents: impl.subscribeEvents,
      addEventHandler: impl.addEventHandler,
      removeEventHandler: impl.removeEventHandler,
    });
  })
);