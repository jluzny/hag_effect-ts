
import { createMachine, assign, interpret, ActorRefFrom } from 'xstate';
import { HvacOptions } from '../config/settings_simple.ts';
import { HVACContext, StateChangeData, SystemMode, HVACMode } from '../types/common.ts';
import { StateError, ErrorUtils } from '../core/exceptions.ts';
import { Effect, pipe, Context } from 'effect';
import { LoggerService } from '../core/container.ts';

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
}

/**
 * Create HVAC state machine with XState and Effect integration
 */
export const createHVACMachine = (hvacOptions: HvacOptions, logger: Context.Tag.Service<LoggerService>) => {
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
        const eventType = (event as unknown as { type?: string })?.type;
        let message = '🔄 [HVAC] State transition';
        if (eventType) {
          message += ` triggered by: ${eventType}`;
        }
        Effect.runFork(logger.info(message, {
          toState: event.type,
          event, // Log the entire event object for debugging
          indoorTemp: context.indoorTemp,
          outdoorTemp: context.outdoorTemp,
          systemMode: context.systemMode,
          currentHour: context.currentHour,
          isWeekday: context.isWeekday,
          timestamp: new Date().toISOString()
        }));
      },
      logHeatingStart: ({ context }) => {
        Effect.runFork(logger.info(`🔥 [HVAC] Starting heating mode`, {
          targetTemp: hvacOptions.heating.temperature,
          indoorTemp: context.indoorTemp,
          outdoorTemp: context.outdoorTemp,
          presetMode: hvacOptions.heating.presetMode,
          thresholds: hvacOptions.heating.temperatureThresholds,
          timestamp: new Date().toISOString()
        }));
      },
      logCoolingStart: ({ context }) => {
        Effect.runFork(logger.info(`❄️ [HVAC] Starting cooling mode`, {
          targetTemp: hvacOptions.cooling.temperature,
          indoorTemp: context.indoorTemp,
          outdoorTemp: context.outdoorTemp,
          presetMode: hvacOptions.cooling.presetMode,
          thresholds: hvacOptions.cooling.temperatureThresholds,
          timestamp: new Date().toISOString()
        }));
      },
      logManualOverride: (_, event) => {
        Effect.runFork(logger.info(`🎯 [HVAC] Manual override activated`, {
          event,
          timestamp: new Date().toISOString()
        }));
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
        Effect.runFork(heatingStrategy.startDefrost());
        Effect.runFork(logger.info(`❄️ [HVAC] Defrost cycle started`, {
          durationSeconds: hvacOptions.heating.defrost?.durationSeconds || 300,
          timestamp: new Date().toISOString()
        }));
      },
      completeDefrost: () => {
        Effect.runFork(logger.info(`✅ [HVAC] Defrost cycle completed`, {
          timestamp: new Date().toISOString(),
          nextState: 'heating'
        }));
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
};
