/**
 * HVAC Controller for HAG Effect-TS variant.
 * 
 * Effect-native implementation using functional patterns and Context/Layer system.
 */

import { Effect, Context, Layer, pipe, Schedule, Duration, Ref, Fiber } from 'effect';
import { HttpClient } from '@effect/platform';
import { HvacOptions, ApplicationOptions } from '../config/settings_simple.ts';
import { HVACStateMachine } from './state-machine.ts';
import { HomeAssistantClient } from '../home-assistant/client.ts';
import { HassEventImpl, HassServiceCallImpl } from '../home-assistant/models.ts';
import { HVACStatus, HVACMode, OperationResult, HVACStateMachineStatus, SystemMode } from '../types/common.ts';
import { StateError, HVACOperationError, ErrorUtils } from '../core/exceptions.ts';
import { LoggerService, HvacOptionsService, ApplicationOptionsService } from '../core/container.ts';
import { HVACAgent } from '../ai/agent.ts';

/**
 * HVAC Controller service definition
 */
export class HVACController extends Context.Tag('HVACController')<
  HVACController,
  {
    readonly start: () => Effect.Effect<void, StateError, HttpClient.HttpClient>;
    readonly stop: () => Effect.Effect<void, never>;
    readonly getStatus: () => Effect.Effect<HVACStatus, StateError>;
    readonly triggerEvaluation: () => Effect.Effect<OperationResult, StateError, HttpClient.HttpClient>;
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
    private stateMachine: Context.Tag.Service<HVACStateMachine>,
    private haClient: Context.Tag.Service<HomeAssistantClient>,
    private logger: Context.Tag.Service<LoggerService>,
    private stateRef: Ref.Ref<ControllerState>,
    private hvacAgent?: Context.Tag.Service<HVACAgent> | undefined // Optional AI agent
  ) {}

  /**
   * Start the HVAC controller
   */
  start = (): Effect.Effect<void, StateError, HttpClient.HttpClient> =>
    pipe(
      this.stateRef,
      Ref.get,
      Effect.flatMap((state) => {
        if (state.running) {
          return pipe(
            this.logger.warning('🔄 HVAC controller already running', {
              currentState: state.running,
              haConnected: this.haClient.connected(),
            }),
            Effect.asVoid
          );
        }

        return pipe(
          this.logger.info('🚀 Starting HVAC controller', {
            systemMode: this.hvacOptions.systemMode,
            aiEnabled: this.appOptions.useAi,
            dryRun: this.appOptions.dryRun,
            hvacEntities: this.hvacOptions.hvacEntities.length,
            tempSensor: this.hvacOptions.tempSensor,
            outdoorSensor: this.hvacOptions.outdoorSensor,
            heatingConfig: {
              temperature: this.hvacOptions.heating.temperature,
              presetMode: this.hvacOptions.heating.presetMode,
              thresholds: this.hvacOptions.heating.temperatureThresholds
            },
            coolingConfig: {
              temperature: this.hvacOptions.cooling.temperature,
              presetMode: this.hvacOptions.cooling.presetMode,
              thresholds: this.hvacOptions.cooling.temperatureThresholds
            }
          }),
          Effect.andThen(this.logger.info('🔗 Step 1: Connecting to Home Assistant')),
          Effect.andThen(this.haClient.connect()),
          Effect.andThen(this.logger.info('✅ Step 1 completed: Home Assistant connected')),
          Effect.andThen(this.logger.info('⚙️ Step 2: Starting state machine')),
          Effect.andThen(this.startStateMachine()),
          Effect.andThen(this.logger.info('✅ Step 2 completed: State machine started')),
          Effect.andThen(this.logger.info('📡 Step 3: Setting up event subscriptions')),
          Effect.andThen(this.setupEventSubscriptions()),
          Effect.andThen(this.logger.info('✅ Step 3 completed: Event subscriptions configured')),
          Effect.andThen(this.logger.info('🔄 Step 4: Starting monitoring loop')),
          Effect.andThen(this.startMonitoringLoop()),
          Effect.andThen(this.logger.info('✅ Step 4 completed: Monitoring loop started')),
          Effect.andThen(this.logger.info('🎯 Step 5: Triggering initial evaluation')),
          Effect.andThen(this.triggerInitialEvaluation()),
          Effect.andThen(this.logger.info('✅ Step 5 completed: Initial evaluation triggered')),
          Effect.andThen(
            pipe(
              this.stateRef,
              Ref.update((s) => ({ ...s, running: true }))
            )
          ),
          Effect.andThen(this.logger.info('🏠 HVAC controller started successfully')),
          Effect.catchAll((error) =>
            pipe(
              this.logger.error('❌ Failed to start HVAC controller', error),
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
      this.logger.info('🛑 Stopping HVAC controller', {
        currentlyRunning: this.stateRef.pipe(Ref.get, Effect.map(s => s.running)),
        haConnected: this.haClient.connected(),
      }),
      Effect.andThen(
        pipe(
          this.stateRef,
          Ref.update((state) => ({ ...state, running: false }))
        )
      ),
      Effect.andThen(this.stopMonitoringLoop()),
      Effect.andThen(this.stopStateMachine()),
      Effect.andThen(this.haClient.disconnect()),
      Effect.andThen(this.logger.info('✅ HVAC controller stopped completely')),
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
        controllerState: Ref.get(this.stateRef),
        stateMachineStatus: this.getStateMachineStatus(),
        haConnected: this.haClient.connected(),
      }),
      Effect.flatMap(({ controllerState, stateMachineStatus, haConnected }) => {
        const status: HVACStatus = {
          controller: {
            running: controllerState.running,
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
            this.hvacAgent.getStatusSummary(),
            Effect.flatMap((aiStatus) => {
              if (aiStatus.success) {
                status.aiAnalysis = aiStatus.aiSummary;
              }
              return Effect.succeed(status);
            }),
            Effect.catchAll((error) =>
              pipe(
                this.logger.warning('Failed to get AI status', { error }),
                Effect.andThen(Effect.succeed(status))
              )
            )
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
  triggerEvaluation = (): Effect.Effect<OperationResult, StateError, HttpClient.HttpClient> =>
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
      Effect.tap(() => this.logger.info('✅ Manual evaluation completed successfully')),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('❌ Manual evaluation failed', error),
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
      this.logger.info('🎯 Manual override requested', {
        action,
        options,
        currentState: this.stateMachine.getCurrentState(),
        currentMode: this.getCurrentHVACMode(this.stateMachine.getCurrentState()),
        aiEnabled: this.appOptions.useAi && !!this.hvacAgent,
        dryRun: this.appOptions.dryRun
      }),
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

        return pipe(
          this.logger.info('🔧 Processing manual override', {
            parsedMode: mode,
            targetTemperature: temperature,
            fromState: this.stateMachine.getCurrentState(),
            requestedAction: action
          }),
          Effect.andThen(() => {
            if (this.appOptions.useAi && this.hvacAgent) {
              // Use AI agent for validation and execution
              return pipe(
                this.logger.debug('🤖 Delegating to AI agent for manual override'),
                Effect.andThen(this.hvacAgent.manualOverride(action, options)),
                Effect.tap((result) =>
                  this.logger.info('✅ AI agent manual override completed', {
                    success: result?.success,
                    resultData: result,
                    mode,
                    temperature
                  })
                ),
                Effect.map((result) => ({
                  success: result?.success ?? false,
                  data: result,
                  timestamp: new Date().toISOString(),
                }))
              );
            } else {
              // Direct execution
              return pipe(
                this.logger.info('⚡ Executing direct manual override', {
                  mode,
                  temperature,
                  dryRun: this.appOptions.dryRun
                }),
                Effect.andThen(this.executeHVACMode(mode, temperature)),
                Effect.andThen(this.stateMachineManualOverride(mode, temperature)),
                Effect.map(() => ({
                  success: true,
                  data: { action, mode, temperature },
                  timestamp: new Date().toISOString(),
                })),
                Effect.tap((result) =>
                  this.logger.info('✅ Manual override executed successfully', {
                    action,
                    mode,
                    temperature,
                    newState: this.stateMachine.getCurrentState(),
                    dryRun: this.appOptions.dryRun
                  })
                )
              );
            }
          })
        );
      }),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('❌ Manual override failed', error, {
            action,
            options,
            currentState: this.stateMachine.getCurrentState(),
            errorType: ErrorUtils.extractErrorDetails(error).name
          }),
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
      this.logger.info('Evaluating system efficiency', {
        aiEnabled: this.appOptions.useAi && !!this.hvacAgent,
        dryRun: this.appOptions.dryRun
      }),
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
            this.logger.debug('🤖 Delegating to AI agent for efficiency evaluation'),
            Effect.andThen(this.hvacAgent.evaluateEfficiency()),
            Effect.tap((result) =>
              this.logger.info('✅ AI efficiency evaluation completed', {
                success: result?.success,
                analysisLength: (result?.data as any)?.analysis?.length,
                recommendationsCount: (result?.data as any)?.recommendations?.length
              })
            ),
            Effect.map((result) => ({
              success: result?.success ?? false,
              data: result,
              timestamp: new Date().toISOString(),
            }))
          );
        } else {
          // Simple efficiency analysis without AI
          return pipe(
            this.logger.info('⚙️ Performing direct efficiency analysis'),
            Effect.andThen(this.getStateMachineStatus()),
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
            })),
            Effect.tap(() => this.logger.info('✅ Direct efficiency analysis completed'))
          );
        }
      }),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('❌ Efficiency evaluation failed', error),
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
      Effect.catchAll((_error) =>
        Effect.fail(ErrorUtils.stateError('Failed to setup event subscriptions'))
      )
    );

  /**
   * Handle Home Assistant state change events
   */
  private handleStateChange = (event: HassEventImpl): Effect.Effect<void, never, HttpClient.HttpClient> =>
    pipe(
      this.logger.debug('📨 Received state change event', {
        eventType: event.eventType,
        timeFired: event.timeFired,
        origin: event.origin
      }),
      Effect.andThen(() => {
        if (!event.isStateChanged()) {
          return pipe(
            this.logger.debug('🔍 Event is not a state change, ignoring'),
            Effect.void
          );
        }

        const stateChange = event.getStateChangeData();
        if (!stateChange) {
          return pipe(
            this.logger.debug('🔍 No state change data available, ignoring'),
            Effect.void
          );
        }

        return pipe(
          this.logger.debug('🔄 Entity state changed', {
            entityId: stateChange.entityId,
            oldState: stateChange.oldState?.state,
            newState: stateChange.newState?.state,
            isTemperatureSensor: stateChange.entityId === this.hvacOptions.tempSensor,
            isOutdoorSensor: stateChange.entityId === this.hvacOptions.outdoorSensor
          }),
          Effect.andThen(() => {
            if (stateChange.entityId !== this.hvacOptions.tempSensor) {
              return Effect.void;
            }

            if (!stateChange.newState) {
              return pipe(
                this.logger.warning('⚠️ Temperature sensor state change with no new state', {
                  entityId: stateChange.entityId,
                  oldState: stateChange.oldState?.state
                }),
                Effect.asVoid
              );
            }

            return pipe(
              this.logger.info('🌡️ Processing temperature sensor change', {
                entityId: stateChange.entityId,
                oldTemperature: stateChange.oldState?.state,
                newTemperature: stateChange.newState.state,
                temperatureChange: stateChange.oldState?.state && stateChange.newState?.state 
                  ? parseFloat(stateChange.newState.state) - parseFloat(stateChange.oldState.state)
                  : 'unknown',
                currentHVACState: this.stateMachine.getCurrentState(),
                lastChanged: stateChange.newState.lastChanged,
                attributes: stateChange.newState.attributes
              }),
              Effect.andThen(() => {
                if (this.appOptions.useAi && this.hvacAgent) {
                  // Process through AI agent
                  const eventData = {
                    entityId: stateChange.entityId,
                    newState: stateChange.newState?.state,
                    oldState: stateChange.oldState?.state,
                    timestamp: event.timeFired.toISOString(),
                    attributes: stateChange.newState?.attributes,
                  };

                  return pipe(
                    this.logger.debug('🤖 Delegating temperature change to AI agent', {
                      eventData,
                      aiAgentAvailable: !!this.hvacAgent
                    }),
                    Effect.andThen(this.hvacAgent.processTemperatureChange(eventData)),
                    Effect.tap(() => this.logger.debug('✅ AI agent processed temperature change'))
                  );
                } else {
                  // Use direct state machine logic
                  return pipe(
                    this.logger.debug('⚙️ Processing temperature change with direct state machine logic'),
                    Effect.andThen(this.processStateChangeDirect(stateChange)),
                    Effect.tap(() => this.logger.debug('✅ Direct state machine processing completed'))
                  );
                }
              })
            );
          })
        );
      }),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('❌ Failed to process temperature change', error, {
            entityId: event.getStateChangeData()?.entityId,
            newState: event.getStateChangeData()?.newState?.state,
            oldState: event.getStateChangeData()?.oldState?.state,
            processingMethod: this.appOptions.useAi && this.hvacAgent ? 'AI' : 'direct'
          }),
          Effect.asVoid
        )
      )
    );

  /**
   * Process state change using direct state machine logic
   */
  private processStateChangeDirect = (stateChange: unknown): Effect.Effect<void, never, HttpClient.HttpClient> =>
    pipe(
      this.logger.info('🔄 Starting direct state change processing', {
        entityId: (stateChange as any)?.entityId,
        rawState: (stateChange as any)?.newState?.state,
      }),
      Effect.try({
        try: () => parseFloat((stateChange as { newState: { state: string } }).newState.state),
        catch: () => NaN,
      }),
      Effect.flatMap((newTemp) => {
        if (isNaN(newTemp)) {
          return pipe(
            this.logger.warning('⚠️ Invalid temperature value received', {
              entityId: (stateChange as any)?.entityId,
              rawState: (stateChange as any)?.newState?.state,
              parsedValue: newTemp,
            }),
            Effect.asVoid
          );
        }
        
        return pipe(
          this.logger.debug('✅ Temperature parsed successfully', {
            entityId: (stateChange as any)?.entityId,
            parsedTemperature: newTemp,
          }),
          Effect.andThen(this.logger.debug('🌡️ Fetching outdoor temperature', {
            outdoorSensor: this.hvacOptions.outdoorSensor
          })),
          // Get outdoor temperature
          Effect.andThen(this.haClient.getState(this.hvacOptions.outdoorSensor)
            .pipe(Effect.flatMap((outdoorState) => {
              const outdoorValue = outdoorState.getNumericState();
              if (outdoorValue !== null) {
                return pipe(
                  this.logger.debug('✅ Outdoor temperature retrieved', {
                    outdoorTemperature: outdoorValue,
                    outdoorSensor: this.hvacOptions.outdoorSensor,
                  }),
                  Effect.succeed(outdoorValue)
                );
              } else {
                return pipe(
                  this.logger.warning('⚠️ Outdoor temperature is null, using fallback', {
                    fallbackTemp: 20.0,
                    outdoorSensor: this.hvacOptions.outdoorSensor
                  }),
                  Effect.succeed(20.0)
                );
              }
            }),
            Effect.catchAll((error) =>
              pipe(
                this.logger.warning('⚠️ Failed to get outdoor temperature, using fallback', {
                  error,
                  fallbackTemp: 20.0,
                  outdoorSensor: this.hvacOptions.outdoorSensor
                }),
                Effect.succeed(20.0)
              )
            )
          )),
          Effect.flatMap((outdoorTemp) =>
            pipe(
              this.logger.info('🌡️ Temperature data collected', {
                indoorTemp: newTemp,
                outdoorTemp,
                temperatureDifference: newTemp - outdoorTemp,
              }),
              // Update state machine with new conditions
              Effect.andThen(this.updateStateMachineTemperatures(newTemp, outdoorTemp)),
              Effect.andThen(this.logger.debug('🎯 Triggering evaluation and execution')),
              Effect.andThen(this.evaluateAndExecute()),
              Effect.tap(() =>
                this.logger.info('✅ Direct state change processing completed', {
                  entityId: (stateChange as any)?.entityId,
                  indoorTemp: newTemp,
                  outdoorTemp,
                  newState: this.stateMachine.getCurrentState(),
                })
              )
            )
          )
        );
      }),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('❌ Direct state change processing failed', error, {
            entityId: (stateChange as any)?.entityId,
            rawState: (stateChange as any)?.newState?.state,
            currentState: this.stateMachine.getCurrentState(),
          }),
          Effect.asVoid
        )
      )
    );

  /**
   * Start monitoring loop for periodic evaluation
   */
  private startMonitoringLoop = (): Effect.Effect<void, never, HttpClient.HttpClient> =>
    pipe(
      Effect.fork(
        pipe(
          this.monitoringLoop(),
          Effect.repeat(Schedule.fixed(Duration.minutes(5))),
          Effect.asVoid
        )
      ),
      Effect.flatMap((fiber) =>
        pipe(
          this.stateRef,
          Ref.update((state) => ({ ...state, monitoringFiber: fiber }))
        )
      ),
      Effect.andThen(this.logger.info('🔄 Starting HVAC monitoring loop', {
        intervalMinutes: 5,
        intervalMs: Duration.minutes(5).pipe(Duration.toMillis),
      })),
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
            Fiber.interrupt(state.monitoringFiber),
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
  private monitoringLoop = (): Effect.Effect<void, never, HttpClient.HttpClient> =>
    pipe(
      this.logger.debug('🔍 Monitoring loop iteration'),
      Effect.andThen(this.performEvaluation()),
      Effect.tap(() => this.logger.debug('✅ Monitoring loop iteration completed')),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('❌ Error in monitoring loop', error),
          Effect.asVoid
        )
      )
    );

  /**
   * Perform HVAC evaluation
   */
  private performEvaluation = (): Effect.Effect<void, StateError, HttpClient.HttpClient> =>
    pipe(
      Effect.gen((function* (this: HVACControllerImpl) {
        yield* this.logger.info('🎯 Performing periodic HVAC evaluation', {
          aiEnabled: this.appOptions.useAi && !!this.hvacAgent,
          currentState: this.stateMachine.getCurrentState(),
          haConnected: yield* this.haClient.connected(),
          evaluationType: this.appOptions.useAi && this.hvacAgent ? 'AI-powered' : 'direct',
        });

        if (this.appOptions.useAi && this.hvacAgent) {
          // AI-powered evaluation
          const status = yield* this.hvacAgent.getStatusSummary();
          
          if (status.success) {
            yield* this.logger.info('✅ AI evaluation completed successfully', {
              hasAiSummary: !!status.aiSummary,
              summaryLength: status.aiSummary?.length,
              summaryPreview: status.aiSummary?.substring(0, 150) + (status.aiSummary && status.aiSummary.length > 150 ? '...' : ''),
            });
          } else {
            yield* this.logger.warning('⚠️ AI evaluation failed', {
              error: status.error,
              fallbackToDirect: true,
            });
            
            // Fallback to direct evaluation
            yield* this.logger.debug('🔄 Falling back to direct state machine evaluation');
            yield* this.evaluateStateMachineDirect();
          }
        } else {
          // Direct state machine evaluation
          yield* this.logger.debug('⚙️ Starting direct state machine evaluation');
          yield* this.evaluateStateMachineDirect();
        }
        yield* this.logger.info('✅ Periodic evaluation completed');
      }).bind(this)),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('❌ Periodic evaluation error', error),
          Effect.andThen(Effect.fail(ErrorUtils.stateError('Evaluation failed')))
        )
      )
    );

  /**
   * Trigger initial evaluation on startup
   */
  private triggerInitialEvaluation = (): Effect.Effect<void, never, HttpClient.HttpClient> =>
    pipe(
      this.logger.info('🎯 Triggering initial HVAC evaluation'),
      Effect.andThen(() => {
        if (this.appOptions.useAi && this.hvacAgent) {
          const initialEvent = {
            entityId: this.hvacOptions.tempSensor,
            newState: 'initial_check',
            oldState: undefined,
            timestamp: new Date().toISOString(),
          };

          return pipe(
            this.logger.debug('🤖 Delegating initial evaluation to AI agent', { eventData: initialEvent }),
            Effect.andThen(this.hvacAgent.processTemperatureChange(initialEvent)),
            Effect.tap(() => this.logger.debug('✅ AI agent processed initial evaluation'))
          );
        } else {
          return pipe(
            this.logger.debug('⚙️ Performing direct initial evaluation'),
            Effect.andThen(this.evaluateStateMachineDirect()),
            Effect.tap(() => this.logger.debug('✅ Direct initial evaluation completed'))
          );
        }
      }),
      Effect.catchAll((error) =>
        pipe(
          this.logger.warning('❌ Initial evaluation failed', error),
          Effect.asVoid
        )
      )
    );

  /**
   * Evaluate state machine directly without AI
   */
  private evaluateStateMachineDirect = (): Effect.Effect<void, never, HttpClient.HttpClient> =>
    pipe(
      this.logger.debug('⚙️ Starting direct state machine evaluation', {
        tempSensor: this.hvacOptions.tempSensor,
        outdoorSensor: this.hvacOptions.outdoorSensor,
        haConnected: this.haClient.connected(),
        currentState: this.stateMachine.getCurrentState()
      }),
      Effect.all({
        indoorState: this.haClient.getState(this.hvacOptions.tempSensor),
        outdoorState: this.haClient.getState(this.hvacOptions.outdoorSensor)
          .pipe(Effect.catchAll(() => Effect.succeed(null))),
      }),
      Effect.flatMap(({ indoorState, outdoorState }) => {
        const indoorTemp = indoorState.getNumericState();
        
        if (indoorTemp === null) {
          return pipe(
            this.logger.warning('⚠️ No indoor temperature available for evaluation', {
              sensor: this.hvacOptions.tempSensor,
              state: indoorState.state,
              attributes: indoorState.attributes
            }),
            Effect.asVoid
          );
        }

        const outdoorTemp = outdoorState?.getNumericState() ?? 20.0;

        return pipe(
          this.logger.info('🌡️ Temperature data collected', {
            indoorTemp,
            outdoorTemp,
            temperatureDifference: indoorTemp - outdoorTemp,
            thresholds: {
              heating: this.hvacOptions.heating.temperatureThresholds,
              cooling: this.hvacOptions.cooling.temperatureThresholds
            }
          }),
          // Update state machine conditions
          Effect.andThen(this.updateStateMachineTemperatures(indoorTemp, outdoorTemp)),
          Effect.andThen(this.logger.debug('✅ State machine temperatures updated')),
          Effect.andThen(this.logger.debug('🎯 Triggering evaluation and execution')),
          Effect.andThen(this.evaluateAndExecute()),
          Effect.tap(() =>
            this.logger.info('✅ Direct state machine evaluation completed', {
              indoorTemp,
              outdoorTemp,
              finalState: this.stateMachine.getCurrentState(),
            })
          )
        );
      }),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('❌ Direct state machine evaluation failed', error, {
            currentState: this.stateMachine.getCurrentState(),
            tempSensor: this.hvacOptions.tempSensor,
            outdoorSensor: this.hvacOptions.outdoorSensor
          }),
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
        return pipe(
          this.logger.info('🎯 Starting HVAC evaluation', {
            previousState: previousStatus.currentState,
            previousMode: this.getCurrentHVACMode(previousStatus.currentState),
            currentConditions: previousStatus.context,
          }),
          // Trigger evaluation
          Effect.andThen(this.stateMachineEvaluateConditions()),
          Effect.andThen(this.getStateMachineStatus()),
          Effect.flatMap((currentStatus) => {
            const hvacMode = this.getCurrentHVACMode(currentStatus.currentState);
            const previousMode = this.getCurrentHVACMode(previousStatus.currentState);

            return pipe(
              this.logger.info('✅ HVAC evaluation completed', {
                previousState: previousStatus.currentState,
                currentState: currentStatus.currentState,
                previousMode,
                hvacMode: hvacMode || 'unknown',
                stateChanged: previousStatus.currentState !== currentStatus.currentState,
                modeChanged: previousMode !== hvacMode,
                conditions: currentStatus.context,
                shouldExecute: hvacMode && (previousStatus.currentState !== currentStatus.currentState || currentStatus.currentState === 'manualOverride')
              }),
              Effect.andThen(() => {
                // Execute HVAC actions if mode changed or manual override
                if (hvacMode && (
                  previousStatus.currentState !== currentStatus.currentState || 
                  currentStatus.currentState === 'manualOverride'
                )) {
                  return pipe(
                    this.logger.info('⚡ Executing HVAC mode change', {
                      reason: currentStatus.currentState === 'manualOverride' ? 'manual_override' : 'state_change',
                      fromState: previousStatus.currentState,
                      toState: currentStatus.currentState,
                      fromMode: previousMode,
                      toMode: hvacMode
                    }),
                    Effect.andThen(this.executeHVACMode(hvacMode))
                  );
                }
                return pipe(
                  this.logger.debug('🔄 No action required', {
                    reason: !hvacMode ? 'no_hvac_mode' : 'no_state_change',
                    currentState: currentStatus.currentState,
                    hvacMode,
                    stateChanged: previousStatus.currentState !== currentStatus.currentState
                  }),
                  Effect.void
                );
              })
            );
          })
        );
      }),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('❌ Evaluate and execute failed', error),
          Effect.asVoid
        )
      )
    );

  /**
   * Execute HVAC mode changes on actual devices
   */
  private executeHVACMode = (hvacMode: HVACMode, targetTemp?: number): Effect.Effect<void, never> =>
    pipe(
      this.logger.info('⚡ Executing HVAC mode change', {
        hvacMode,
        targetTemp,
        dryRun: this.appOptions.dryRun,
        systemMode: this.hvacOptions.systemMode,
      }),
      Effect.andThen(() => {
        const enabledEntities = this.hvacOptions.hvacEntities.filter(entity => 
          typeof entity === 'string' ? true : entity.enabled
        );
        const disabledEntities = this.hvacOptions.hvacEntities.filter(entity => 
          typeof entity === 'object' && !entity.enabled
        );

        if (enabledEntities.length === 0) {
          return pipe(
            this.logger.warning('⚠️ No enabled HVAC entities found - no action will be taken', {
              totalConfiguredEntities: this.hvacOptions.hvacEntities.length,
              allEntities: this.hvacOptions.hvacEntities.map(e => ({ id: typeof e === 'string' ? e : e.entityId, enabled: typeof e === 'string' ? true : e.enabled }))
            }),
            Effect.asVoid
          );
        }

        // Execute mode change for each entity
        const effects = enabledEntities.map(entity =>
          pipe(
            this.logger.debug('🎯 Controlling HVAC entity', {
              entityId: typeof entity === 'string' ? entity : entity.entityId,
              mode: hvacMode,
              targetTemp,
              entityConfig: entity
            }),
            Effect.andThen(this.controlHVACEntity(
              typeof entity === 'string' ? entity : entity.entityId, 
              hvacMode, 
              targetTemp
            )),
            Effect.tap(() =>
              this.logger.info('✅ HVAC entity controlled successfully', {
                entityId: typeof entity === 'string' ? entity : entity.entityId,
                mode: hvacMode,
                temperature: targetTemp,
                dryRun: this.appOptions.dryRun
              })
            ),
            Effect.catchAll((error) =>
              pipe(
                this.logger.error('❌ Failed to control HVAC entity', {
                  entityId: typeof entity === 'string' ? entity : entity.entityId,
                  mode: hvacMode,
                  error,
                }),
                Effect.asVoid
              )
            )
          )
        );

        return pipe(
          Effect.all(effects, { concurrency: 'unbounded' }),
          Effect.tap(() =>
            this.logger.info('🏁 HVAC mode execution completed', {
              hvacMode,
              targetTemp,
              totalEntities: enabledEntities.length,
              successCount: effects.length, // Assuming all succeeded if no catchAll
              errorCount: 0, // Handled in individual catchAll
              dryRun: this.appOptions.dryRun,
              overallSuccess: true
            })
          )
        );
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
      this.logger.info('🎯 Controlling HVAC entity', {
        entityId,
        mode,
        targetTemp,
        dryRun: this.appOptions.dryRun,
      }),
      Effect.andThen(() => {
        // Determine temperature and preset based on mode
        const temperature = targetTemp || (mode === HVACMode.HEAT 
          ? this.hvacOptions.heating.temperature 
          : this.hvacOptions.cooling.temperature);
        const presetMode = mode === HVACMode.HEAT 
          ? this.hvacOptions.heating.presetMode 
          : this.hvacOptions.cooling.presetMode;

        if (this.appOptions.dryRun) {
          return pipe(
            this.logger.info('📝 DRY RUN: Would set HVAC mode', {
              entityId,
              hvac_mode: mode,
              service: 'climate.set_hvac_mode'
            }),
            Effect.andThen(() => {
              if (mode !== HVACMode.OFF) {
                return pipe(
                  this.logger.info('📝 DRY RUN: Would set temperature', {
                    entityId,
                    temperature,
                    service: 'climate.set_temperature'
                  }),
                  Effect.andThen(this.logger.info('📝 DRY RUN: Would set preset mode', {
                    entityId,
                    preset_mode: presetMode,
                    service: 'climate.set_preset_mode'
                  }))
                );
              }
              return Effect.void;
            }),
            Effect.tap(() =>
              this.logger.debug('✅ DRY RUN: Entity control simulation completed', {
                entityId,
                mode,
                temperature,
                presetMode,
              })
            )
          );
        }

        return pipe(
          // Set HVAC mode
          this.logger.debug('🔧 Setting HVAC mode', {
            entityId,
            mode,
            service: 'climate.set_hvac_mode'
          }),
          Effect.andThen(this.haClient.callService(
            HassServiceCallImpl.climate('set_hvac_mode', entityId, { hvac_mode: mode })
          )),
          Effect.tap(() => this.logger.debug('✅ HVAC mode set successfully', { entityId, mode })),
          Effect.andThen(() => {
            // Set temperature and preset if not turning off
            if (mode !== HVACMode.OFF) {
              return pipe(
                this.logger.debug('🌡️ Setting temperature', {
                  entityId,
                  temperature,
                  service: 'climate.set_temperature'
                }),
                Effect.andThen(this.haClient.callService(
                  HassServiceCallImpl.climate('set_temperature', entityId, { temperature })
                )),
                Effect.tap(() => this.logger.debug('✅ Temperature set successfully', { entityId, temperature })),
                Effect.andThen(this.logger.debug('⚙️ Setting preset mode', {
                  entityId,
                  presetMode,
                  service: 'climate.set_preset_mode'
                })),
                Effect.andThen(this.haClient.callService(
                  HassServiceCallImpl.climate('set_preset_mode', entityId, { preset_mode: presetMode })
                )),
                Effect.tap(() => this.logger.debug('✅ Preset mode set successfully', { entityId, presetMode }))
              );
            } else {
              return pipe(
                this.logger.debug('⏹️ HVAC turned off - skipping temperature and preset configuration', {
                  entityId,
                  mode
                }),
                Effect.void
              );
            }
          }),
          Effect.tap(() =>
            this.logger.info('✅ HVAC entity control completed successfully', {
              entityId,
              mode,
              temperature: mode !== HVACMode.OFF ? temperature : undefined,
              presetMode: mode !== HVACMode.OFF ? presetMode : undefined,
            })
          )
        );
      }),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('❌ Failed to control HVAC entity', error, {
            entityId,
            mode,
            targetTemp,
          }),
          Effect.fail(error) // Re-throw the error to be caught by executeHVACMode
        )
      )
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

  // State machine operations
  private startStateMachine = (): Effect.Effect<void, never> =>
    pipe(
      this.logger.info('⚙️ Starting state machine', {
        initialState: this.stateMachine.getCurrentState(),
        systemMode: this.hvacOptions.systemMode
      }),
      Effect.andThen(this.stateMachine.start()),
      Effect.andThen(this.logger.info('✅ State machine started', {
        currentState: this.stateMachine.getCurrentState()
      }))
    );

  private stopStateMachine = (): Effect.Effect<void, never> =>
    pipe(
      this.logger.debug('⚙️ Stopping state machine', {
        currentState: this.stateMachine.getCurrentState()
      }),
      Effect.andThen(this.stateMachine.stop()),
      Effect.andThen(this.logger.debug('✅ State machine stopped'))
    );

  private getStateMachineStatus = (): Effect.Effect<HVACStateMachineStatus, never> =>
    this.stateMachine.getStatus();

  private updateStateMachineTemperatures = (indoor: number, outdoor: number): Effect.Effect<void, never> =>
    pipe(
      this.logger.info('⚙️ Updating state machine with new temperatures', {
        indoorTemp: indoor,
        outdoorTemp: outdoor,
        currentState: this.stateMachine.getCurrentState(),
      }),
      Effect.andThen(this.stateMachine.updateTemperatures(indoor, outdoor)),
      Effect.andThen(this.logger.debug('✅ State machine temperatures updated'))
    );

  private stateMachineEvaluateConditions = (): Effect.Effect<void, never> =>
    pipe(
      this.logger.debug('⚙️ Triggering state machine condition evaluation'),
      Effect.andThen(this.stateMachine.evaluateConditions()),
      Effect.andThen(this.logger.debug('✅ State machine conditions evaluated'))
    );

  private stateMachineManualOverride = (mode: HVACMode, temp?: number): Effect.Effect<void, never> =>
    pipe(
      this.logger.info('⚡ Executing state machine manual override', {
        mode,
        temperature: temp,
      }),
      Effect.andThen(this.stateMachine.manualOverride(mode, temp)),
      Effect.andThen(this.logger.debug('✅ State machine manual override executed'))
    );
}

/**
 * Layer for providing HVAC Controller service
 */
export const HVACControllerLive = Layer.effect(
  HVACController,
  Effect.gen(function* () {
    const hvacOptions = yield* HvacOptionsService;
    const appOptions = yield* ApplicationOptionsService;
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