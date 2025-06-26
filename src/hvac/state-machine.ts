/**
 * HVAC state machine implementation for HAG Effect-TS variant.
 * 
 * XState-powered state machine with Effect-native error handling and immutable patterns.
 */

import { Effect, pipe, Context, Layer } from 'effect';
import { createMachine, assign, ActorRefFrom } from 'xstate';
import { HvacOptions } from '../config/settings.ts';
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

  constructor(private hvacOptions: HvacOptions) {}

  shouldHeat = (data: StateChangeData): Effect.Effect<boolean, never> =>
    Effect.sync(() => {
      const { heating } = this.hvacOptions;
      const thresholds = heating.temperatureThresholds;

      // Check temperature conditions
      if (data.currentTemp >= thresholds.indoorMax) {
        return false;
      }

      // Check outdoor temperature range
      if (data.weatherTemp < thresholds.outdoorMin || data.weatherTemp > thresholds.outdoorMax) {
        return false;
      }

      // Check active hours
      if (!this.isActiveHour(data.hour, data.isWeekday)) {
        return false;
      }

      return data.currentTemp < thresholds.indoorMin;
    });

  needsDefrost = (data: StateChangeData): Effect.Effect<boolean, never> =>
    Effect.sync(() => {
      const defrost = this.hvacOptions.heating.defrost;
      if (!defrost) return false;

      // Check temperature threshold
      if (data.weatherTemp > defrost.temperatureThreshold) {
        return false;
      }

      // Check time since last defrost
      if (this.lastDefrost) {
        const timeSinceDefrost = Date.now() - this.lastDefrost.getTime();
        if (timeSinceDefrost < defrost.periodSeconds * 1000) {
          return false;
        }
      }

      return true;
    });

  startDefrost = (): Effect.Effect<void, never> =>
    pipe(
      Effect.sync(() => {
        this.lastDefrost = new Date();
      }),
      Effect.tap(() => Effect.logInfo('Defrost cycle started'))
    );

  private isActiveHour(hour: number, isWeekday: boolean): boolean {
    const activeHours = this.hvacOptions.activeHours;
    if (!activeHours) return true;

    const start = isWeekday ? activeHours.startWeekday : activeHours.start;
    return hour >= start && hour <= activeHours.end;
  }
}

export class CoolingStrategy {
  constructor(private hvacOptions: HvacOptions) {}

  shouldCool = (data: StateChangeData): Effect.Effect<boolean, never> =>
    Effect.sync(() => {
      const { cooling } = this.hvacOptions;
      const thresholds = cooling.temperatureThresholds;

      // Check temperature conditions
      if (data.currentTemp <= thresholds.indoorMin) {
        return false;
      }

      // Check outdoor temperature range
      if (data.weatherTemp < thresholds.outdoorMin || data.weatherTemp > thresholds.outdoorMax) {
        return false;
      }

      // Check active hours
      if (!this.isActiveHour(data.hour, data.isWeekday)) {
        return false;
      }

      return data.currentTemp > thresholds.indoorMax;
    });

  private isActiveHour(hour: number, isWeekday: boolean): boolean {
    const activeHours = this.hvacOptions.activeHours;
    if (!activeHours) return true;

    const start = isWeekday ? activeHours.startWeekday : activeHours.start;
    return hour >= start && hour <= activeHours.end;
  }
}

/**
 * Create HVAC state machine with XState and Effect integration
 */
export function createHVACMachine(hvacOptions: HvacOptions) {
  const heatingStrategy = new HeatingStrategy(hvacOptions);
  const coolingStrategy = new CoolingStrategy(hvacOptions);

  return createMachine({
    id: 'hvac',
    initial: 'idle',
    context: {
      indoorTemp: undefined,
      outdoorTemp: undefined,
      currentHour: new Date().getHours(),
      isWeekday: new Date().getDay() >= 1 && new Date().getDay() <= 5,
      lastDefrost: undefined,
      systemMode: hvacOptions.systemMode,
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
      logStateEntry: ({ context }, { type }) => {
        // Effect logging will be handled in the service layer
        console.log(`[HVAC] Entering state: ${type}`, {
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
      logManualOverride: (_, { type, ...event }) => {
        console.log(`[HVAC] Manual override activated`, event);
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

  constructor(private hvacOptions: HvacOptions) {
    this.machine = createHVACMachine(hvacOptions);
  }

  start = (): Effect.Effect<void, StateError> =>
    Effect.gen(function* () {
      if (this.actor) {
        yield* Effect.fail(ErrorUtils.stateError('State machine is already running'));
      }

      this.actor = this.machine.createActor();
      this.actor.start();
      
      yield* Effect.logInfo('HVAC state machine started');
    }.bind(this));

  stop = (): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      if (this.actor) {
        this.actor.stop();
        this.actor = undefined;
      }
      
      yield* Effect.logInfo('HVAC state machine stopped');
    }.bind(this));

  send = (event: HVACEvent): Effect.Effect<void, StateError> =>
    Effect.gen(function* () {
      if (!this.actor) {
        yield* Effect.fail(ErrorUtils.stateError('State machine is not running'));
      }
      
      this.actor.send(event);
      yield* Effect.logDebug('Event sent to state machine', { event: event.type });
    }.bind(this));

  getCurrentState = (): Effect.Effect<string, never> =>
    Effect.sync(() => {
      if (!this.actor) {
        return 'stopped';
      }
      return this.actor.getSnapshot().value as string;
    });

  getContext = (): Effect.Effect<HVACContext, StateError> =>
    Effect.gen(function* () {
      if (!this.actor) {
        yield* Effect.fail(ErrorUtils.stateError('State machine is not running'));
      }
      
      return this.actor.getSnapshot().context;
    }.bind(this));

  updateTemperatures = (indoor: number, outdoor: number): Effect.Effect<void, StateError> =>
    this.send({
      type: 'UPDATE_TEMPERATURES',
      indoor,
      outdoor,
    });

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
    Effect.gen(function* () {
      const currentState = yield* this.getCurrentState();
      const context = yield* this.getContext();
      
      return {
        currentState,
        context,
        canHeat: context.systemMode !== SystemMode.COOL_ONLY && context.systemMode !== SystemMode.OFF,
        canCool: context.systemMode !== SystemMode.HEAT_ONLY && context.systemMode !== SystemMode.OFF,
        systemMode: context.systemMode,
      } as const;
    }.bind(this));
}

/**
 * Layer for providing HVAC state machine service
 */
export const HVACStateMachineLive = Layer.effect(
  HVACStateMachine,
  Effect.gen(function* () {
    // Get HVAC options from config - this would be injected
    const hvacOptions = yield* Effect.service(Context.Tag<HvacOptions>('HvacOptions'));
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