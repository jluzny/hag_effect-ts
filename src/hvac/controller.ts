/**
 * HVAC Controller for HAG Effect-TS variant.
 * 
 * Effect-native implementation using functional patterns and Context/Layer system.
 */

import { Effect, Context, Layer, pipe, Schedule, Duration, Ref, Fiber } from 'effect';
import { HvacOptions, ApplicationOptions } from '../config/settings.ts';
import { HVACStateMachine, HVACEvent } from './state-machine.ts';
import { HomeAssistantClient } from '../home-assistant/client.ts';
import { HassEventImpl, HassServiceCallImpl } from '../home-assistant/models.ts';
import { HVACStatus, HVACMode, OperationResult } from '../types/common.ts';
import { StateError, HVACOperationError, ValidationError, ErrorUtils } from '../core/exceptions.ts';
import { LoggerService } from '../core/container.ts';

/**
 * HVAC Controller service definition
 */
export class HVACController extends Context.Tag('HVACController')<
  HVACController,
  {
    readonly start: () => Effect.Effect<void, StateError>;
    readonly stop: () => Effect.Effect<void, never>;
    readonly getStatus: () => Effect.Effect<HVACStatus, StateError>;
    readonly triggerEvaluation: () => Effect.Effect<OperationResult, StateError>;
    readonly manualOverride: (action: string, options?: Record<string, unknown>) => Effect.Effect<OperationResult, HVACOperationError>;
    readonly evaluateEfficiency: () => Effect.Effect<OperationResult, HVACOperationError>;
  }
>() {}

/**
 * Internal controller state
 */
interface ControllerState {
  running: boolean;
  monitoringFiber?: Fiber.Fiber<void, never>;
  abortController?: AbortController;
}

/**
 * HVAC Controller implementation
 */
class HVACControllerImpl {
  constructor(
    private hvacOptions: HvacOptions,
    private appOptions: ApplicationOptions,
    private stateMachine: HVACStateMachine,
    private haClient: HomeAssistantClient,
    private logger: LoggerService,
    private stateRef: Ref.Ref<ControllerState>,
    private hvacAgent?: any // Optional AI agent
  ) {}

  /**
   * Start the HVAC controller
   */
  start = (): Effect.Effect<void, StateError> =>
    pipe(
      this.stateRef,
      Ref.get,
      Effect.flatMap((state) => {
        if (state.running) {
          return pipe(
            this.logger.warning('HVAC controller already running'),
            Effect.asVoid
          );
        }

        return pipe(
          this.logger.info('Starting HVAC controller', {
            systemMode: this.hvacOptions.systemMode,
            aiEnabled: this.appOptions.useAi,
            entities: this.hvacOptions.hvacEntities.length,
          }),
          Effect.andThen(this.haClient.connect),
          Effect.andThen(this.startStateMachine()),
          Effect.andThen(this.setupEventSubscriptions()),
          Effect.andThen(this.startMonitoringLoop()),
          Effect.andThen(this.triggerInitialEvaluation()),
          Effect.andThen(
            pipe(
              this.stateRef,
              Ref.update((s) => ({ ...s, running: true }))
            )
          ),
          Effect.andThen(this.logger.info('✅ HVAC controller started successfully')),
          Effect.catchAll((error) =>
            pipe(
              this.logger.error('Failed to start HVAC controller', error),
              Effect.andThen(this.stop()),
              Effect.andThen(
                Effect.fail(
                  ErrorUtils.stateError('Failed to start HVAC controller')
                )
              )
            )
          )
        );
      })
    );

  /**
   * Stop the HVAC controller
   */
  stop = (): Effect.Effect<void, never> =>
    pipe(
      this.logger.info('Stopping HVAC controller'),
      Effect.andThen(
        pipe(
          this.stateRef,
          Ref.update((state) => ({ ...state, running: false }))
        )
      ),
      Effect.andThen(this.stopMonitoringLoop()),
      Effect.andThen(this.stopStateMachine()),
      Effect.andThen(this.haClient.disconnect),
      Effect.andThen(this.logger.info('✅ HVAC controller stopped')),
      Effect.catchAll((error) =>
        pipe(
          this.logger.warning('Error during controller stop', error),
          Effect.asVoid
        )
      )
    );

  /**
   * Get current system status
   */
  getStatus = (): Effect.Effect<HVACStatus, StateError> =>
    pipe(
      Effect.all({
        state: Ref.get(this.stateRef),
        stateMachineStatus: this.getStateMachineStatus(),
        haConnected: this.haClient.connected,
      }),
      Effect.flatMap(({ state, stateMachineStatus, haConnected }) => {
        const status: HVACStatus = {
          controller: {
            running: state.running,
            haConnected,
            tempSensor: this.hvacOptions.tempSensor,
            systemMode: this.hvacOptions.systemMode,
            aiEnabled: this.appOptions.useAi && !!this.hvacAgent,
          },
          stateMachine: {
            currentState: stateMachineStatus.currentState,
            hvacMode: this.getCurrentHVACMode(stateMachineStatus.currentState),
            conditions: stateMachineStatus.context,
          },
          timestamp: new Date().toISOString(),
        };

        // Add AI analysis if available
        if (this.appOptions.useAi && this.hvacAgent) {
          return pipe(
            Effect.tryPromise({
              try: () => this.hvacAgent.getStatusSummary(),
              catch: (error) => error,
            }),
            Effect.flatMap((aiStatus) => {
              if (aiStatus.success) {
                status.aiAnalysis = aiStatus.aiSummary;
              }
              return Effect.succeed(status);
            }),
            Effect.catchAll(() => Effect.succeed(status))
          );
        }

        return Effect.succeed(status);
      }),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('Failed to get status', error),
          Effect.andThen(
            Effect.succeed({
              controller: {
                running: false,
                haConnected: false,
                tempSensor: this.hvacOptions.tempSensor,
                systemMode: this.hvacOptions.systemMode,
                aiEnabled: false,
              },
              stateMachine: {
                currentState: 'error',
              },
              timestamp: new Date().toISOString(),
            })
          )
        )
      )
    );

  /**
   * Trigger manual evaluation
   */
  triggerEvaluation = (): Effect.Effect<OperationResult, StateError> =>
    pipe(
      this.logger.info('Manual evaluation triggered', {
        aiEnabled: this.appOptions.useAi,
      }),
      Effect.andThen(
        pipe(
          this.stateRef,
          Ref.get,
          Effect.flatMap((state) => {
            if (!state.running) {
              return Effect.fail(
                ErrorUtils.stateError('HVAC controller is not running')
              );
            }
            return Effect.void;
          })
        )
      ),
      Effect.andThen(this.performEvaluation()),
      Effect.map(() => ({
        success: true,
        timestamp: new Date().toISOString(),
      })),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('Manual evaluation failed', error),
          Effect.andThen(
            Effect.succeed({
              success: false,
              error: error instanceof Error ? error.message : String(error),
              timestamp: new Date().toISOString(),
            })
          )
        )
      )
    );

  /**
   * Manual HVAC override
   */
  manualOverride = (
    action: string,
    options: Record<string, unknown> = {}
  ): Effect.Effect<OperationResult, HVACOperationError> =>
    pipe(
      this.logger.info('Manual override requested', { action, options }),
      Effect.andThen(
        pipe(
          this.stateRef,
          Ref.get,
          Effect.flatMap((state) => {
            if (!state.running) {
              return Effect.fail(
                ErrorUtils.hvacOperationError(
                  'HVAC controller is not running',
                  action
                )
              );
            }
            return Effect.void;
          })
        )
      ),
      Effect.flatMap(() => {
        const mode = this.parseHVACMode(action);
        const temperature = options.temperature as number | undefined;

        if (this.appOptions.useAi && this.hvacAgent) {
          // Use AI agent for validation and execution
          return pipe(
            Effect.tryPromise({
              try: () => this.hvacAgent.manualOverride(action, options),
              catch: (error) => ErrorUtils.hvacOperationError(
                `AI agent override failed: ${error}`,
                action
              ),
            }),
            Effect.map((result) => ({
              success: result.success,
              data: result,
              timestamp: new Date().toISOString(),
            }))
          );
        } else {
          // Direct execution
          return pipe(
            this.executeHVACMode(mode, temperature),
            Effect.andThen(this.stateMachineManualOverride(mode, temperature)),
            Effect.map(() => ({
              success: true,
              data: { action, mode, temperature },
              timestamp: new Date().toISOString(),
            }))
          );
        }
      }),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('Manual override failed', error),
          Effect.andThen(
            Effect.fail(
              ErrorUtils.hvacOperationError(
                `Manual override failed: ${error instanceof Error ? error.message : String(error)}`,
                action
              )
            )
          )
        )
      )
    );

  /**
   * Evaluate system efficiency
   */
  evaluateEfficiency = (): Effect.Effect<OperationResult, HVACOperationError> =>
    pipe(
      this.stateRef,
      Ref.get,
      Effect.flatMap((state) => {
        if (!state.running) {
          return Effect.fail(
            ErrorUtils.hvacOperationError('HVAC controller is not running')
          );
        }

        if (this.appOptions.useAi && this.hvacAgent) {
          return pipe(
            Effect.tryPromise({
              try: () => this.hvacAgent.evaluateEfficiency(),
              catch: (error) => ErrorUtils.hvacOperationError(
                `AI efficiency evaluation failed: ${error}`
              ),
            }),
            Effect.map((result) => ({
              success: result.success,
              data: result,
              timestamp: new Date().toISOString(),
            }))
          );
        } else {
          // Simple efficiency analysis without AI
          return pipe(
            this.getStateMachineStatus(),
            Effect.map((status) => ({
              success: true,
              data: {
                analysis: `State machine mode: ${status.currentState}`,
                recommendations: [
                  'Monitor temperature trends',
                  'Check for optimal scheduling',
                ],
              },
              timestamp: new Date().toISOString(),
            }))
          );
        }
      }),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('Efficiency evaluation failed', error),
          Effect.andThen(
            Effect.fail(ErrorUtils.hvacOperationError('Efficiency evaluation failed'))
          )
        )
      )
    );

  /**
   * Setup Home Assistant event subscriptions
   */
  private setupEventSubscriptions = (): Effect.Effect<void, StateError> =>
    pipe(
      this.haClient.subscribeEvents('state_changed'),
      Effect.andThen(
        this.haClient.addEventHandler('state_changed', this.handleStateChange)
      ),
      Effect.andThen(
        this.logger.debug('Event subscriptions configured', {
          tempSensor: this.hvacOptions.tempSensor,
        })
      ),
      Effect.catchAll((error) =>
        Effect.fail(ErrorUtils.stateError('Failed to setup event subscriptions'))
      )
    );

  /**
   * Handle Home Assistant state change events
   */
  private handleStateChange = (event: HassEventImpl): Effect.Effect<void, never> =>
    pipe(
      this.logger.debug('Received state change event', {
        eventType: event.eventType,
      }),
      Effect.andThen(() => {
        if (!event.isStateChanged()) {
          return Effect.void;
        }

        const stateChange = event.getStateChangeData();
        if (!stateChange || stateChange.entityId !== this.hvacOptions.tempSensor) {
          return Effect.void;
        }

        if (!stateChange.newState) {
          return pipe(
            this.logger.warning('Temperature sensor state change with no new state', {
              entityId: stateChange.entityId,
            }),
            Effect.asVoid
          );
        }

        return pipe(
          this.logger.debug('Processing temperature sensor change', {
            entityId: stateChange.entityId,
            oldState: stateChange.oldState?.state,
            newState: stateChange.newState.state,
          }),
          Effect.andThen(() => {
            if (this.appOptions.useAi && this.hvacAgent) {
              // Process through AI agent
              const eventData = {
                entityId: stateChange.entityId,
                newState: stateChange.newState.state,
                oldState: stateChange.oldState?.state,
                timestamp: event.timeFired.toISOString(),
                attributes: stateChange.newState.attributes,
              };

              return Effect.tryPromise({
                try: () => this.hvacAgent.processTemperatureChange(eventData),
                catch: () => undefined,
              });
            } else {
              // Use direct state machine logic
              return this.processStateChangeDirect(stateChange);
            }
          })
        );
      }),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('Failed to process temperature change', error),
          Effect.asVoid
        )
      )
    );

  /**
   * Process state change using direct state machine logic
   */
  private processStateChangeDirect = (stateChange: any): Effect.Effect<void, never> =>
    pipe(
      Effect.try({
        try: () => parseFloat(stateChange.newState.state),
        catch: () => NaN,
      }),
      Effect.flatMap((newTemp) => {
        if (isNaN(newTemp)) {
          return pipe(
            this.logger.warning('Invalid temperature value', {
              entityId: stateChange.entityId,
              state: stateChange.newState.state,
            }),
            Effect.asVoid
          );
        }

        // Get outdoor temperature
        return pipe(
          this.haClient.getState(this.hvacOptions.outdoorSensor),
          Effect.flatMap((outdoorState) => {
            const outdoorTemp = outdoorState.getNumericState() ?? 20.0;
            
            // Update state machine with new conditions
            return pipe(
              this.updateStateMachineTemperatures(newTemp, outdoorTemp),
              Effect.andThen(this.evaluateAndExecute())
            );
          }),
          Effect.catchAll((error) =>
            pipe(
              this.logger.warning('Failed to get outdoor temperature', error),
              Effect.andThen(
                pipe(
                  this.updateStateMachineTemperatures(newTemp, 20.0),
                  Effect.andThen(this.evaluateAndExecute())
                )
              )
            )
          )
        );
      }),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('Direct state change processing failed', error),
          Effect.asVoid
        )
      )
    );

  /**
   * Start monitoring loop for periodic evaluation
   */
  private startMonitoringLoop = (): Effect.Effect<void, never> =>
    pipe(
      Effect.fork(
        pipe(
          this.monitoringLoop(),
          Effect.repeat(Schedule.fixed(Duration.minutes(5)))
        )
      ),
      Effect.flatMap((fiber) =>
        pipe(
          this.stateRef,
          Ref.update((state) => ({ ...state, monitoringFiber: fiber }))
        )
      ),
      Effect.andThen(this.logger.info('Started HVAC monitoring loop')),
      Effect.asVoid
    );

  /**
   * Stop monitoring loop
   */
  private stopMonitoringLoop = (): Effect.Effect<void, never> =>
    pipe(
      this.stateRef,
      Ref.get,
      Effect.flatMap((state) => {
        if (state.monitoringFiber) {
          return pipe(
            state.monitoringFiber.interrupt(),
            Effect.fork,
            Effect.asVoid
          );
        }
        return Effect.void;
      })
    );

  /**
   * Monitoring loop implementation
   */
  private monitoringLoop = (): Effect.Effect<void, never> =>
    pipe(
      this.logger.debug('Performing periodic HVAC evaluation', {
        aiEnabled: this.appOptions.useAi,
      }),
      Effect.andThen(this.performEvaluation()),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('Periodic evaluation error', error),
          Effect.asVoid
        )
      )
    );

  /**
   * Perform HVAC evaluation
   */
  private performEvaluation = (): Effect.Effect<void, StateError> =>
    pipe(
      Effect.gen(function* () {
        if (this.appOptions.useAi && this.hvacAgent) {
          // AI-powered evaluation
          const status = yield* Effect.tryPromise({
            try: () => this.hvacAgent.getStatusSummary(),
            catch: (error) => error,
          });
          
          if (status.success) {
            yield* this.logger.debug('AI evaluation completed', {
              summary: status.aiSummary?.substring(0, 100),
            });
          } else {
            yield* this.logger.warning('AI evaluation failed', { 
              error: status.error 
            });
          }
        } else {
          // Direct state machine evaluation
          yield* this.evaluateStateMachineDirect();
        }
      }).bind(this)(),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('Evaluation failed', error),
          Effect.andThen(Effect.fail(ErrorUtils.stateError('Evaluation failed')))
        )
      )
    );

  /**
   * Trigger initial evaluation on startup
   */
  private triggerInitialEvaluation = (): Effect.Effect<void, never> =>
    pipe(
      this.logger.info('Triggering initial HVAC evaluation'),
      Effect.andThen(() => {
        if (this.appOptions.useAi && this.hvacAgent) {
          const initialEvent = {
            entityId: this.hvacOptions.tempSensor,
            newState: 'initial_check',
            oldState: null,
            timestamp: new Date().toISOString(),
          };

          return Effect.tryPromise({
            try: () => this.hvacAgent.processTemperatureChange(initialEvent),
            catch: () => undefined,
          });
        } else {
          return this.evaluateStateMachineDirect();
        }
      }),
      Effect.catchAll((error) =>
        pipe(
          this.logger.warning('Initial evaluation failed', error),
          Effect.asVoid
        )
      )
    );

  /**
   * Evaluate state machine directly without AI
   */
  private evaluateStateMachineDirect = (): Effect.Effect<void, never> =>
    pipe(
      Effect.all({
        indoorState: this.haClient.getState(this.hvacOptions.tempSensor),
        outdoorState: this.haClient.getState(this.hvacOptions.outdoorSensor)
          .pipe(Effect.catchAll(() => Effect.succeed(null))),
      }),
      Effect.flatMap(({ indoorState, outdoorState }) => {
        const indoorTemp = indoorState.getNumericState();
        
        if (indoorTemp === null) {
          return pipe(
            this.logger.warning('No indoor temperature available for evaluation'),
            Effect.asVoid
          );
        }

        const outdoorTemp = outdoorState?.getNumericState() ?? 20.0;

        // Update state machine conditions
        return pipe(
          this.updateStateMachineTemperatures(indoorTemp, outdoorTemp),
          Effect.andThen(this.evaluateAndExecute())
        );
      }),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('Direct state machine evaluation failed', error),
          Effect.asVoid
        )
      )
    );

  /**
   * Evaluate state machine and execute HVAC actions
   */
  private evaluateAndExecute = (): Effect.Effect<void, never> =>
    pipe(
      this.getStateMachineStatus(),
      Effect.flatMap((previousStatus) => {
        // Trigger evaluation
        return pipe(
          this.stateMachineEvaluateConditions(),
          Effect.andThen(this.getStateMachineStatus()),
          Effect.flatMap((currentStatus) => {
            const hvacMode = this.getCurrentHVACMode(currentStatus.currentState);

            return pipe(
              this.logger.info('State machine evaluation completed', {
                previousState: previousStatus.currentState,
                currentState: currentStatus.currentState,
                hvacMode,
                stateChanged: previousStatus.currentState !== currentStatus.currentState,
              }),
              Effect.andThen(() => {
                // Execute HVAC actions if mode changed or manual override
                if (hvacMode && (
                  previousStatus.currentState !== currentStatus.currentState || 
                  currentStatus.currentState === 'manualOverride'
                )) {
                  return this.executeHVACMode(hvacMode);
                }
                return Effect.void;
              })
            );
          })
        );
      }),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('Evaluate and execute failed', error),
          Effect.asVoid
        )
      )
    );

  /**
   * Execute HVAC mode changes on actual devices
   */
  private executeHVACMode = (hvacMode: HVACMode, targetTemp?: number): Effect.Effect<void, never> =>
    pipe(
      this.logger.info('Executing HVAC mode change', { hvacMode, targetTemp }),
      Effect.andThen(() => {
        const enabledEntities = this.hvacOptions.hvacEntities.filter(entity => entity.enabled);

        if (enabledEntities.length === 0) {
          return pipe(
            this.logger.warning('No enabled HVAC entities found'),
            Effect.asVoid
          );
        }

        // Execute mode change for each entity
        const effects = enabledEntities.map(entity =>
          pipe(
            this.controlHVACEntity(entity.entityId, hvacMode, targetTemp),
            Effect.tap(() =>
              this.logger.info('HVAC entity controlled successfully', {
                entityId: entity.entityId,
                mode: hvacMode,
                temperature: targetTemp,
              })
            ),
            Effect.catchAll((error) =>
              pipe(
                this.logger.error('Failed to control HVAC entity', {
                  entityId: entity.entityId,
                  mode: hvacMode,
                  error,
                }),
                Effect.asVoid
              )
            )
          )
        );

        return Effect.all(effects, { concurrency: 'unbounded' });
      }),
      Effect.asVoid
    );

  /**
   * Control individual HVAC entity
   */
  private controlHVACEntity = (
    entityId: string,
    mode: HVACMode,
    targetTemp?: number
  ): Effect.Effect<void, never> =>
    pipe(
      // Set HVAC mode
      this.haClient.callService(
        HassServiceCallImpl.climate('set_hvac_mode', entityId, { hvac_mode: mode })
      ),
      Effect.andThen(() => {
        // Set temperature and preset if not turning off
        if (mode !== HVACMode.OFF) {
          const temperature = targetTemp || (mode === HVACMode.HEAT
            ? this.hvacOptions.heating.temperature
            : this.hvacOptions.cooling.temperature);

          return pipe(
            this.haClient.callService(
              HassServiceCallImpl.climate('set_temperature', entityId, { temperature })
            ),
            Effect.andThen(() => {
              const presetMode = mode === HVACMode.HEAT
                ? this.hvacOptions.heating.presetMode
                : this.hvacOptions.cooling.presetMode;

              return this.haClient.callService(
                HassServiceCallImpl.climate('set_preset_mode', entityId, { preset_mode: presetMode })
              );
            })
          );
        }
        return Effect.void;
      }),
      Effect.catchAll(() => Effect.void)
    );

  /**
   * Get current HVAC mode from state machine
   */
  private getCurrentHVACMode = (currentState: string): HVACMode | undefined => {
    switch (currentState) {
      case 'heating':
      case 'defrosting':
        return HVACMode.HEAT;
      case 'cooling':
        return HVACMode.COOL;
      case 'idle':
        return HVACMode.OFF;
      default:
        return undefined;
    }
  };

  /**
   * Parse HVAC mode from string
   */
  private parseHVACMode = (action: string): HVACMode => {
    switch (action.toLowerCase()) {
      case 'heat':
        return HVACMode.HEAT;
      case 'cool':
        return HVACMode.COOL;
      case 'off':
        return HVACMode.OFF;
      default:
        throw ErrorUtils.validationError(`Invalid HVAC action: ${action}`, 'action', 'HVACMode', action);
    }
  };

  // Placeholder methods for state machine operations
  private startStateMachine = (): Effect.Effect<void, never> => Effect.void;
  private stopStateMachine = (): Effect.Effect<void, never> => Effect.void;
  private getStateMachineStatus = (): Effect.Effect<any, never> => 
    Effect.succeed({ currentState: 'idle', context: {} });
  private updateStateMachineTemperatures = (indoor: number, outdoor: number): Effect.Effect<void, never> => Effect.void;
  private stateMachineEvaluateConditions = (): Effect.Effect<void, never> => Effect.void;
  private stateMachineManualOverride = (mode: HVACMode, temp?: number): Effect.Effect<void, never> => Effect.void;
}

/**
 * Layer for providing HVAC Controller service
 */
export const HVACControllerLive = Layer.effect(
  HVACController,
  Effect.gen(function* () {
    const hvacOptions = yield* Context.Tag<HvacOptions>('HvacOptions');
    const appOptions = yield* Context.Tag<ApplicationOptions>('ApplicationOptions');
    const stateMachine = yield* HVACStateMachine;
    const haClient = yield* HomeAssistantClient;
    const logger = yield* LoggerService;
    
    const initialState: ControllerState = {
      running: false,
    };
    
    const stateRef = yield* Ref.make(initialState);
    
    // Optional AI agent - would be injected if available
    const hvacAgent = undefined; // yield* HVACAgent.pipe(Effect.optional);
    
    const impl = new HVACControllerImpl(
      hvacOptions,
      appOptions,
      stateMachine,
      haClient,
      logger,
      stateRef,
      hvacAgent
    );
    
    return HVACController.of({
      start: impl.start,
      stop: impl.stop,
      getStatus: impl.getStatus,
      triggerEvaluation: impl.triggerEvaluation,
      manualOverride: impl.manualOverride,
      evaluateEfficiency: impl.evaluateEfficiency,
    });
  })
);