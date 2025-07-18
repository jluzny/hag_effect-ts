/**
 * HVAC state machine implementation for HAG Effect-TS variant.
 * 
 * XState-powered state machine with Effect-native error handling and immutable patterns.
 */

import { Effect, pipe, Context, Layer } from 'effect';
import { createMachine, assign, interpret, ActorRefFrom } from 'xstate';
import { HvacOptions } from '../config/settings_simple.ts';
import { HvacOptionsService } from '../core/container.ts';
import { HVACContext, StateChangeData, SystemMode, HVACMode } from '../types/common.ts';
import { StateError, ErrorUtils } from '../core/exceptions.ts';

/**
 * HVAC events that can trigger state transitions
 */
export type HVACEvent =
  | { type: 'HEAT' }
  | { type: 'COOL' }
  | { type: 'OFF' }
  | { type: 'AUTO_EVALUATE' }
  | { type: 'DEFROST_NEEDED' }
  | { type: 'DEFROST_COMPLETE' }
  | { type: 'UPDATE_CONDITIONS'; data: Partial<HVACContext> }
  | { type: 'UPDATE_TEMPERATURES'; indoor: number; outdoor: number }
  | { type: 'MANUAL_OVERRIDE'; mode: HVACMode; temperature?: number };

/**
 * State machine type definitions
 */
export type HVACMachine = ReturnType<typeof createHVACMachine>;
export type HVACMachineActor = ActorRefFrom<HVACMachine>;

/**
 * HVAC strategies using Effect patterns
 */
export class HeatingStrategy {
  private lastDefrost?: Date;

  constructor(private hvacOptions: HvacOptions, private logger: Context.Tag.Service<LoggerService>) {}

  shouldHeat = (data: StateChangeData): Effect.Effect<boolean, never> =>
    pipe(
      this.logger.debug('🔥 Evaluating heating conditions', {
        currentTemp: data.currentTemp,
        weatherTemp: data.weatherTemp,
        hour: data.hour,
        isWeekday: data.isWeekday,
        thresholds: this.hvacOptions.heating.temperatureThresholds,
        targetTemperature: this.hvacOptions.heating.temperature
      }),
      Effect.map(() => {
        const { heating } = this.hvacOptions;
        const thresholds = heating.temperatureThresholds;

        // Check temperature conditions
        if (data.currentTemp >= thresholds.indoorMax) {
          Effect.runSync(this.logger.debug('❌ Heating rejected: indoor temp at/above max', {
            currentTemp: data.currentTemp,
            indoorMax: thresholds.indoorMax,
            reason: 'indoor_temp_too_high'
          }));
          return false;
        }

        // Check outdoor temperature range
        if (data.weatherTemp < thresholds.outdoorMin || data.weatherTemp > thresholds.outdoorMax) {
          Effect.runSync(this.logger.debug('❌ Heating rejected: outdoor temp out of range', {
            weatherTemp: data.weatherTemp,
            outdoorMin: thresholds.outdoorMin,
            outdoorMax: thresholds.outdoorMax,
            reason: data.weatherTemp < thresholds.outdoorMin ? 'outdoor_too_cold' : 'outdoor_too_hot'
          }));
          return false;
        }

        // Check active hours
        if (!this.isActiveHour(data.hour, data.isWeekday)) {
          Effect.runSync(this.logger.debug('❌ Heating rejected: outside active hours', {
            currentHour: data.hour,
            isWeekday: data.isWeekday,
            activeHours: this.hvacOptions.activeHours,
            reason: 'outside_active_hours'
          }));
          return false;
        }

        const shouldHeat = data.currentTemp < thresholds.indoorMin;
        
        Effect.runSync(this.logger.info(shouldHeat ? '✅ Heating approved' : '❌ Heating rejected: temp above min', {
          currentTemp: data.currentTemp,
          indoorMin: thresholds.indoorMin,
          shouldHeat,
          tempDifference: thresholds.indoorMin - data.currentTemp,
          reason: shouldHeat ? 'temp_below_minimum' : 'temp_above_minimum'
        }));
        
        return shouldHeat;
      })
    );

  needsDefrost = (data: StateChangeData): Effect.Effect<boolean, never> =>
    pipe(
      this.logger.debug('❄️ Evaluating defrost need', {
        weatherTemp: data.weatherTemp,
        defrostEnabled: !!this.hvacOptions.heating.defrost,
        lastDefrost: this.lastDefrost?.toISOString(),
        defrostConfig: this.hvacOptions.heating.defrost
      }),
      Effect.map(() => {
        const defrost = this.hvacOptions.heating.defrost;
        if (!defrost) {
          Effect.runSync(this.logger.debug('❌ Defrost disabled in configuration'));
          return false;
        }

        // Check temperature threshold
        if (data.weatherTemp > defrost.temperatureThreshold) {
          Effect.runSync(this.logger.debug('❌ Defrost not needed: outdoor temp too warm', {
            weatherTemp: data.weatherTemp,
            temperatureThreshold: defrost.temperatureThreshold,
            tempDifference: data.weatherTemp - defrost.temperatureThreshold
          }));
          return false;
        }

        // Check time since last defrost
        if (this.lastDefrost) {
          const timeSinceDefrost = Date.now() - this.lastDefrost.getTime();
          const periodMs = defrost.periodSeconds * 1000;
          
          if (timeSinceDefrost < periodMs) {
            Effect.runSync(this.logger.debug('❌ Defrost not needed: too soon since last defrost', {
              lastDefrost: this.lastDefrost.toISOString(),
              timeSinceDefrostMs: timeSinceDefrost,
              timeSinceDefrostMinutes: Math.round(timeSinceDefrost / 60000),
              periodSeconds: defrost.periodSeconds,
              remainingTimeMs: periodMs - timeSinceDefrost,
              remainingTimeMinutes: Math.round((periodMs - timeSinceDefrost) / 60000)
            }));
            return false;
          }
        }

        Effect.runSync(this.logger.info('✅ Defrost needed', {
          weatherTemp: data.weatherTemp,
          temperatureThreshold: defrost.temperatureThreshold,
          lastDefrost: this.lastDefrost?.toISOString() || 'never',
          timeSinceLastDefrost: this.lastDefrost 
            ? Math.round((Date.now() - this.lastDefrost.getTime()) / 60000) + ' minutes'
            : 'never',
          periodSeconds: defrost.periodSeconds,
          durationSeconds: defrost.durationSeconds
        }));
        
        return true;
      })
    );

  startDefrost = (): Effect.Effect<void, never> =>
    pipe(
      Effect.sync(() => {
        this.lastDefrost = new Date();
      }),
      Effect.andThen(this.logger.info('❄️ Defrost cycle started', {
        startTime: this.lastDefrost?.toISOString(),
        durationSeconds: this.hvacOptions.heating.defrost?.durationSeconds || 300,
        expectedEndTime: new Date((this.lastDefrost?.getTime() || 0) + (this.hvacOptions.heating.defrost?.durationSeconds || 300) * 1000).toISOString()
      }))
    );

  private isActiveHour(hour: number, isWeekday: boolean): boolean {
    const activeHours = this.hvacOptions.activeHours;
    if (!activeHours) return true;

    const start = isWeekday ? activeHours.startWeekday : activeHours.start;
    return hour >= start && hour <= activeHours.end;
  }
}

export class CoolingStrategy {
  constructor(private hvacOptions: HvacOptions, private logger: Context.Tag.Service<LoggerService>) {}

  shouldCool = (data: StateChangeData): Effect.Effect<boolean, never> =>
    pipe(
      this.logger.debug('❄️ Evaluating cooling conditions', {
        currentTemp: data.currentTemp,
        weatherTemp: data.weatherTemp,
        hour: data.hour,
        isWeekday: data.isWeekday,
        thresholds: this.hvacOptions.cooling.temperatureThresholds,
        targetTemperature: this.hvacOptions.cooling.temperature
      }),
      Effect.map(() => {
        const { cooling } = this.hvacOptions;
        const thresholds = cooling.temperatureThresholds;

        // Check temperature conditions
        if (data.currentTemp <= thresholds.indoorMin) {
          Effect.runSync(this.logger.debug('❌ Cooling rejected: indoor temp at/below min', {
            currentTemp: data.currentTemp,
            indoorMin: thresholds.indoorMin,
            reason: 'indoor_temp_too_low'
          }));
          return false;
        }

        // Check outdoor temperature range
        if (data.weatherTemp < thresholds.outdoorMin || data.weatherTemp > thresholds.outdoorMax) {
          Effect.runSync(this.logger.debug('❌ Cooling rejected: outdoor temp out of range', {
            weatherTemp: data.weatherTemp,
            outdoorMin: thresholds.outdoorMin,
            outdoorMax: thresholds.outdoorMax,
            reason: data.weatherTemp < thresholds.outdoorMin ? 'outdoor_too_cold' : 'outdoor_too_hot'
          }));
          return false;
        }

        // Check active hours
        if (!this.isActiveHour(data.hour, data.isWeekday)) {
          Effect.runSync(this.logger.debug('❌ Cooling rejected: outside active hours', {
            currentHour: data.hour,
            isWeekday: data.isWeekday,
            activeHours: this.hvacOptions.activeHours,
            reason: 'outside_active_hours'
          }));
          return false;
        }

        const shouldCool = data.currentTemp > thresholds.indoorMax;
        
        Effect.runSync(this.logger.info(shouldCool ? '✅ Cooling approved' : '❌ Cooling rejected: temp below max', {
          currentTemp: data.currentTemp,
          indoorMax: thresholds.indoorMax,
          shouldCool,
          tempDifference: data.currentTemp - thresholds.indoorMax,
          reason: shouldCool ? 'temp_above_maximum' : 'temp_below_maximum'
        }));
        
        return shouldCool;
      })
    );

  private isActiveHour(hour: number, isWeekday: boolean): boolean {
    const activeHours = this.hvacOptions.activeHours;
    if (!activeHours) return true;

    const start = isWeekday ? activeHours.startWeekday : activeHours.start;
    return hour >= start && hour <= activeHours.end;
  }

/**
 * Create HVAC state machine with XState and Effect integration
 */
const createHVACMachine = (hvacOptions: HvacOptions, logger: Context.Tag.Service<LoggerService>) => {
  const heatingStrategy = new HeatingStrategy(hvacOptions, logger);
  const coolingStrategy = new CoolingStrategy(hvacOptions, logger);

  return createMachine({
    id: 'hvac',
    initial: 'idle',
    context: {
      indoorTemp: undefined,
      outdoorTemp: undefined,
      currentHour: new Date().getHours(),
      isWeekday: new Date().getDay() >= 1 && new Date().getDay() <= 5,
      lastDefrost: undefined,
      systemMode: hvacOptions.systemMode as SystemMode,
    } satisfies HVACContext,
    states: {
      idle: {
        entry: 'logStateEntry',
        on: {
          HEAT: {
            target: 'heating',
            guard: 'canHeat',
          },
          COOL: {
            target: 'cooling',
            guard: 'canCool',
          },
          AUTO_EVALUATE: {
            target: 'evaluating',
          },
          UPDATE_CONDITIONS: {
            actions: 'updateConditions',
          },
          UPDATE_TEMPERATURES: {
            actions: 'updateTemperatures',
          },
          MANUAL_OVERRIDE: {
            target: 'manualOverride',
          },
        },
      },
      evaluating: {
        entry: 'logStateEntry',
        always: [
          {
            target: 'heating',
            guard: 'shouldAutoHeat',
          },
          {
            target: 'cooling',
            guard: 'shouldAutoCool',
          },
          {
            target: 'idle',
          },
        ],
      },
      heating: {
        entry: ['logStateEntry', 'logHeatingStart'],
        on: {
          OFF: 'idle',
          COOL: {
            target: 'cooling',
            guard: 'canCool',
          },
          DEFROST_NEEDED: {
            target: 'defrosting',
            guard: 'canDefrost',
          },
          UPDATE_CONDITIONS: {
            actions: 'updateConditions',
          },
          UPDATE_TEMPERATURES: {
            actions: 'updateTemperatures',
          },
          AUTO_EVALUATE: {
            target: 'evaluating',
          },
          MANUAL_OVERRIDE: {
            target: 'manualOverride',
          },
        },
        after: {
          // Re-evaluate every 5 minutes during heating
          300000: 'evaluating',
        },
      },
      cooling: {
        entry: ['logStateEntry', 'logCoolingStart'],
        on: {
          OFF: 'idle',
          HEAT: {
            target: 'heating',
            guard: 'canHeat',
          },
          UPDATE_CONDITIONS: {
            actions: 'updateConditions',
          },
          UPDATE_TEMPERATURES: {
            actions: 'updateTemperatures',
          },
          AUTO_EVALUATE: {
            target: 'evaluating',
          },
          MANUAL_OVERRIDE: {
            target: 'manualOverride',
          },
        },
        after: {
          // Re-evaluate every 5 minutes during cooling
          300000: 'evaluating',
        },
      },
      defrosting: {
        entry: ['logStateEntry', 'startDefrost'],
        on: {
          OFF: 'idle',
          DEFROST_COMPLETE: 'heating',
          MANUAL_OVERRIDE: {
            target: 'manualOverride',
          },
        },
        after: {
          // Defrost duration from configuration
          [`${hvacOptions.heating.defrost?.durationSeconds ?? 300}000`]: {
            target: 'heating',
            actions: 'completeDefrost',
          },
        },
      },
      manualOverride: {
        entry: ['logStateEntry', 'logManualOverride'],
        on: {
          AUTO_EVALUATE: 'evaluating',
          UPDATE_CONDITIONS: {
            actions: 'updateConditions',
          },
          UPDATE_TEMPERATURES: {
            actions: 'updateTemperatures',
          },
        },
        after: {
          // Return to auto mode after 30 minutes
          1800000: 'evaluating',
        },
      },
    },
  }, {
    actions: {
      logStateEntry: ({ context }, event) => {
        // Effect logging will be handled in the service layer
        console.log(`[HVAC] Entering state: ${(event as { type?: string })?.type ?? 'unknown'}`, {
          indoorTemp: context.indoorTemp,
          outdoorTemp: context.outdoorTemp,
          systemMode: context.systemMode,
        });
      },
      logHeatingStart: ({ context }) => {
        console.log(`[HVAC] Starting heating`, {
          targetTemp: hvacOptions.heating.temperature,
          indoorTemp: context.indoorTemp,
        });
      },
      logCoolingStart: ({ context }) => {
        console.log(`[HVAC] Starting cooling`, {
          targetTemp: hvacOptions.cooling.temperature,
          indoorTemp: context.indoorTemp,
        });
      },
      logManualOverride: (_, event) => {
        console.log(`[HVAC] Manual override activated`, (event as { type?: string })?.type ?? 'unknown');
      },
      updateConditions: assign(({ context, event }) => {
        if (event.type !== 'UPDATE_CONDITIONS') return context;
        return { ...context, ...event.data };
      }),
      updateTemperatures: assign(({ context, event }) => {
        if (event.type !== 'UPDATE_TEMPERATURES') return context;
        return {
          ...context,
          indoorTemp: event.indoor,
          outdoorTemp: event.outdoor,
          currentHour: new Date().getHours(),
          isWeekday: new Date().getDay() >= 1 && new Date().getDay() <= 5,
        };
      }),
      startDefrost: () => {
        // Effect will be handled in the service layer
        heatingStrategy.startDefrost();
      },
      completeDefrost: () => {
        console.log(`[HVAC] Defrost cycle completed`);
      },
    },
    guards: {
      canHeat: ({ context }) => {
        if (context.systemMode === SystemMode.COOL_ONLY || context.systemMode === SystemMode.OFF) {
          return false;
        }
        
        if (!context.indoorTemp || !context.outdoorTemp) {
          return false;
        }

        // For XState guards, we need to run Effect synchronously
        // This is a limitation - real Effect logic would be in the service layer
        const result = Effect.runSync(heatingStrategy.shouldHeat({
          currentTemp: context.indoorTemp,
          weatherTemp: context.outdoorTemp,
          hour: context.currentHour,
          isWeekday: context.isWeekday,
        }));
        
        return result;
      },
      canCool: ({ context }) => {
        if (context.systemMode === SystemMode.HEAT_ONLY || context.systemMode === SystemMode.OFF) {
          return false;
        }
        
        if (!context.indoorTemp || !context.outdoorTemp) {
          return false;
        }

        const result = Effect.runSync(coolingStrategy.shouldCool({
          currentTemp: context.indoorTemp,
          weatherTemp: context.outdoorTemp,
          hour: context.currentHour,
          isWeekday: context.isWeekday,
        }));
        
        return result;
      },
      shouldAutoHeat: ({ context }) => {
        if (context.systemMode !== SystemMode.AUTO) return false;
        
        if (!context.indoorTemp || !context.outdoorTemp) {
          return false;
        }

        const result = Effect.runSync(heatingStrategy.shouldHeat({
          currentTemp: context.indoorTemp,
          weatherTemp: context.outdoorTemp,
          hour: context.currentHour,
          isWeekday: context.isWeekday,
        }));
        
        return result;
      },
      shouldAutoCool: ({ context }) => {
        if (context.systemMode !== SystemMode.AUTO) return false;
        
        if (!context.indoorTemp || !context.outdoorTemp) {
          return false;
        }

        const result = Effect.runSync(coolingStrategy.shouldCool({
          currentTemp: context.indoorTemp,
          weatherTemp: context.outdoorTemp,
          hour: context.currentHour,
          isWeekday: context.isWeekday,
        }));
        
        return result;
      },
      canDefrost: ({ context }) => {
        if (!context.indoorTemp || !context.outdoorTemp) {
          return false;
        }

        const result = Effect.runSync(heatingStrategy.needsDefrost({
          currentTemp: context.indoorTemp,
          weatherTemp: context.outdoorTemp,
          hour: context.currentHour,
          isWeekday: context.isWeekday,
        }));
        
        return result;
      },
    },
  });
}

/**
 * HVAC state machine service using Effect Context pattern
 */
export class HVACStateMachine extends Context.Tag('HVACStateMachine')<
  HVACStateMachine,
  {
    readonly start: () => Effect.Effect<void, StateError>;
    readonly stop: () => Effect.Effect<void, never>;
    readonly send: (event: HVACEvent) => Effect.Effect<void, StateError>;
    readonly getCurrentState: () => Effect.Effect<string, never>;
    readonly getContext: () => Effect.Effect<HVACContext, StateError>;
    readonly updateTemperatures: (indoor: number, outdoor: number) => Effect.Effect<void, StateError>;
    readonly evaluateConditions: () => Effect.Effect<void, StateError>;
    readonly manualOverride: (mode: HVACMode, temperature?: number) => Effect.Effect<void, StateError>;
    readonly getStatus: () => Effect.Effect<{
      readonly currentState: string;
      readonly context: HVACContext;
      readonly canHeat: boolean;
      readonly canCool: boolean;
      readonly systemMode: SystemMode;
    }, StateError>;
  }
>() {}

/**
 * Implementation of the HVAC state machine service
 */
class HVACStateMachineImpl {
  private machine: HVACMachine;
  private actor?: HVACMachineActor;

  constructor(private hvacOptions: HvacOptions, private logger: Context.Tag.Service<LoggerService>) {
    this.machine = createHVACMachine(hvacOptions, logger);
  }

  start = (): Effect.Effect<void, StateError> =>
    Effect.gen((function* (this: HVACStateMachineImpl) {
      yield* Effect.logInfo('🚀 Starting HVAC state machine', {
        machineId: this.machine.id,
        initialState: 'idle',
        alreadyRunning: !!this.actor
      });

      if (this.actor) {
        yield* Effect.fail(ErrorUtils.stateError('State machine is already running'));
      }

      this.actor = interpret(this.machine);
      
      // Add state transition logging
      this.actor.subscribe((snapshot) => {
        Effect.runFork(Effect.logInfo('🔄 State machine transition', {
          toState: snapshot.value,
          context: snapshot.context,
          status: snapshot.status,
          timestamp: new Date().toISOString()
        }));
      });
      
      this.actor.start();
      
      const initialSnapshot = this.actor.getSnapshot();
      
      yield* Effect.logInfo('✅ HVAC state machine started', {
        initialState: initialSnapshot.value,
        initialContext: initialSnapshot.context,
        machineStatus: initialSnapshot.status,
        timestamp: new Date().toISOString()
      });
    }).bind(this));

  stop = (): Effect.Effect<void, never> =>
    Effect.gen((function* (this: HVACStateMachineImpl) {
      yield* Effect.logInfo('🛑 Stopping HVAC state machine', {
        currentState: this.actor?.getSnapshot().value || 'not_running',
        isRunning: !!this.actor
      });

      if (this.actor) {
        const finalSnapshot = this.actor.getSnapshot();
        
        yield* Effect.logDebug('📋 Final state machine status', {
          finalState: finalSnapshot.value,
          finalContext: finalSnapshot.context,
          machineStatus: finalSnapshot.status
        });
        
        this.actor.stop();
        this.actor = undefined;
        
        yield* Effect.logInfo('✅ HVAC state machine stopped');
      } else {
        yield* Effect.logDebug('🔄 State machine was not running');
      }
    }).bind(this));

  send = (event: HVACEvent): Effect.Effect<void, StateError> =>
    Effect.gen((function* (this: HVACStateMachineImpl) {
      if (!this.actor) {
        yield* Effect.fail(ErrorUtils.stateError('State machine is not running'));
      }
      
      const beforeSnapshot = this.actor.getSnapshot();
      
      yield* Effect.logDebug('📤 Sending event to state machine', {
        event,
        eventType: event.type,
        currentState: beforeSnapshot.value,
        context: beforeSnapshot.context,
      });
      
      this.actor!.send(event);
      
      const afterSnapshot = this.actor.getSnapshot();
      
      if (beforeSnapshot.value !== afterSnapshot.value) {
        yield* Effect.logInfo('⚙️ Event triggered state transition', {
          event,
          fromState: beforeSnapshot.value,
          toState: afterSnapshot.value,
          contextChanged: JSON.stringify(beforeSnapshot.context) !== JSON.stringify(afterSnapshot.context)
        });
      } else {
        yield* Effect.logDebug('🔄 Event processed without state change', {
          event,
          currentState: afterSnapshot.value,
          contextChanged: JSON.stringify(beforeSnapshot.context) !== JSON.stringify(afterSnapshot.context)
        });
      }
    }).bind(this));

  getCurrentState = (): Effect.Effect<string, never> =>
    Effect.sync(() => {
      if (!this.actor) {
        return 'stopped';
      }
      return this.actor.getSnapshot().value as string;
    });

  getContext = (): Effect.Effect<HVACContext, StateError> =>
    Effect.gen((function* (this: HVACStateMachineImpl) {
      if (!this.actor) {
        yield* Effect.fail(ErrorUtils.stateError('State machine is not running'));
      }
      
      return this.actor!.getSnapshot().context;
    }).bind(this));

  updateTemperatures = (indoor: number, outdoor: number): Effect.Effect<void, StateError> =>
    pipe(
      this.getContext(),
      Effect.flatMap((context) => {
        const tempChange = {
          indoorChange: context.indoorTemp ? indoor - context.indoorTemp : undefined,
          outdoorChange: context.outdoorTemp ? outdoor - context.outdoorTemp : undefined
        };
        
        return pipe(
          Effect.logInfo('🌡️ Updating temperature conditions', {
            indoor,
            outdoor,
            previousIndoor: context.indoorTemp,
            previousOutdoor: context.outdoorTemp,
            indoorChange: tempChange.indoorChange,
            outdoorChange: tempChange.outdoorChange,
            significantChange: Math.abs(tempChange.indoorChange || 0) > 0.5 || Math.abs(tempChange.outdoorChange || 0) > 2,
          }),
          Effect.andThen(this.send({
            type: 'UPDATE_TEMPERATURES',
            indoor,
            outdoor,
          }))
        );
      })
    );

  evaluateConditions = (): Effect.Effect<void, StateError> =>
    this.send({ type: 'AUTO_EVALUATE' });

  manualOverride = (mode: HVACMode, temperature?: number): Effect.Effect<void, StateError> =>
    this.send({
      type: 'MANUAL_OVERRIDE',
      mode,
      temperature,
    });

  getStatus = (): Effect.Effect<{
    readonly currentState: string;
    readonly context: HVACContext;
    readonly canHeat: boolean;
    readonly canCool: boolean;
    readonly systemMode: SystemMode;
  }, StateError> =>
    Effect.gen((function* (this: HVACStateMachineImpl) {
      const currentState = yield* this.getCurrentState();
      const context = yield* this.getContext();
      
      return {
        currentState,
        context,
        canHeat: context.systemMode !== SystemMode.COOL_ONLY && context.systemMode !== SystemMode.OFF,
        canCool: context.systemMode !== SystemMode.HEAT_ONLY && context.systemMode !== SystemMode.OFF,
        systemMode: context.systemMode,
      } as const;
    }).bind(this));
}

/**
 * Layer for providing HVAC state machine service
 */
export const HVACStateMachineLive = Layer.effect(
  HVACStateMachine,
  Effect.gen(function* () {
    // Get HVAC options from config - this would be injected
    const hvacOptions = yield* HvacOptionsService;
    const impl = new HVACStateMachineImpl(hvacOptions);
    
    return HVACStateMachine.of({
      start: impl.start,
      stop: impl.stop,
      send: impl.send,
      getCurrentState: impl.getCurrentState,
      getContext: impl.getContext,
      updateTemperatures: impl.updateTemperatures,
      evaluateConditions: impl.evaluateConditions,
      manualOverride: impl.manualOverride,
      getStatus: impl.getStatus,
    });
  })
);