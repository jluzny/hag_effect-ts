/**
 * Comprehensive Heating Strategy Tests
 * 
 * Tests heating decision logic, defrost cycle logic, preset mode behaviors,
 * entity-specific defrost behavior, and state transitions.
 * 
 * Equivalent to Python test_heating_logic.py (470+ lines)
 */

import { describe, it, beforeEach, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { Effect, pipe, Ref } from 'effect';
import { HeatingStrategy, createHVACMachine } from '../../../src/hvac/state-machine.ts';
import { SystemMode, HVACMode, StateChangeData } from '../../../src/types/common.ts';
import { 
  mockHvacOptions,
  sampleTemperatureData,
  timeScenarios,
  testScenarios,
  createTestStateMachine,
  testUtils
} from '../../fixtures/test-fixtures.ts';

describe('Heating Strategy Tests', () => {
  let heatingStrategy: HeatingStrategy;
  let testOptions: typeof mockHvacOptions;

  beforeEach(() => {
    testOptions = createTestStateMachine();
    heatingStrategy = new HeatingStrategy(testOptions);
  });

  describe('Basic Heating Decision Logic', () => {
    it('should decide to heat on cold day within active hours', async () => {
      const scenario = sampleTemperatureData.heating.coldDay;
      const time = timeScenarios.activeWeekday;
      
      const shouldHeat = await Effect.runPromise(
        heatingStrategy.shouldHeat({
          currentTemp: scenario.indoor,
          weatherTemp: scenario.outdoor,
          hour: time.hour,
          isWeekday: time.isWeekday,
        })
      );

      expect(shouldHeat).toBe(true);
    });

    it('should not heat when indoor temperature is above maximum', async () => {
      const scenario = sampleTemperatureData.heating.tooWarm;
      const time = timeScenarios.activeWeekday;
      
      const shouldHeat = await Effect.runPromise(
        heatingStrategy.shouldHeat({
          currentTemp: scenario.indoor,
          weatherTemp: scenario.outdoor,
          hour: time.hour,
          isWeekday: time.isWeekday,
        })
      );

      expect(shouldHeat).toBe(false);
    });

    it('should not heat outside active hours even when cold', async () => {
      const scenario = sampleTemperatureData.heating.coldDay;
      const time = timeScenarios.inactiveWeekday;
      
      const shouldHeat = await Effect.runPromise(
        heatingStrategy.shouldHeat({
          currentTemp: scenario.indoor,
          weatherTemp: scenario.outdoor,
          hour: time.hour,
          isWeekday: time.isWeekday,
        })
      );

      expect(shouldHeat).toBe(false);
    });

    it('should not heat when outdoor temperature is below minimum threshold', async () => {
      const time = timeScenarios.activeWeekday;
      
      const shouldHeat = await Effect.runPromise(
        heatingStrategy.shouldHeat({
          currentTemp: 19.0, // Cold indoor
          weatherTemp: -15.0, // Below outdoor minimum (-10.0)
          hour: time.hour,
          isWeekday: time.isWeekday,
        })
      );

      expect(shouldHeat).toBe(false);
    });

    it('should not heat when outdoor temperature exceeds maximum threshold', async () => {
      const time = timeScenarios.activeWeekday;
      
      const shouldHeat = await Effect.runPromise(
        heatingStrategy.shouldHeat({
          currentTemp: 19.0, // Cold indoor
          weatherTemp: 20.0, // Above outdoor maximum (15.0)
          hour: time.hour,
          isWeekday: time.isWeekday,
        })
      );

      expect(shouldHeat).toBe(false);
    });
  });

  describe('Defrost Cycle Logic', () => {
    it('should identify when defrost is needed', async () => {
      const defrostConditions = sampleTemperatureData.heating.defrostNeeded;
      
      const needsDefrost = await Effect.runPromise(
        heatingStrategy.needsDefrost({
          currentTemp: defrostConditions.indoor,
          weatherTemp: defrostConditions.outdoor,
          hour: 10,
          isWeekday: true,
        })
      );

      expect(needsDefrost).toBe(true);
    });

    it('should not defrost when outdoor temperature is above threshold', async () => {
      const needsDefrost = await Effect.runPromise(
        heatingStrategy.needsDefrost({
          currentTemp: 19.0,
          weatherTemp: 0.0, // Above defrost threshold (-5.0)
          hour: 10,
          isWeekday: true,
        })
      );

      expect(needsDefrost).toBe(false);
    });

    it('should track defrost timing correctly', async () => {
      // Start defrost
      await Effect.runPromise(heatingStrategy.startDefrost());
      
      // Immediately check - should not need defrost again
      const needsDefrostAfterStart = await Effect.runPromise(
        heatingStrategy.needsDefrost({
          currentTemp: 19.0,
          weatherTemp: -8.0, // Below threshold
          hour: 10,
          isWeekday: true,
        })
      );

      expect(needsDefrostAfterStart).toBe(false);
    });

    it('should respect defrost period timing', async () => {
      // Create strategy with shorter period for testing
      const shortPeriodOptions = createTestStateMachine({
        heating: {
          ...testOptions.heating,
          defrost: {
            temperatureThreshold: -5.0,
            periodSeconds: 1, // Very short period
            durationSeconds: 300,
          },
        },
      });
      
      const strategy = new HeatingStrategy(shortPeriodOptions);
      
      // Start defrost
      await Effect.runPromise(strategy.startDefrost());
      
      // Wait for period to pass
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      // Now should need defrost again
      const needsDefrostAfterPeriod = await Effect.runPromise(
        strategy.needsDefrost({
          currentTemp: 19.0,
          weatherTemp: -8.0,
          hour: 10,
          isWeekday: true,
        })
      );

      expect(needsDefrostAfterPeriod).toBe(true);
    });

    it('should handle missing defrost configuration', async () => {
      const noDefrostOptions = createTestStateMachine({
        heating: {
          ...testOptions.heating,
          defrost: undefined,
        },
      });
      
      const strategy = new HeatingStrategy(noDefrostOptions);
      
      const needsDefrost = await Effect.runPromise(
        strategy.needsDefrost({
          currentTemp: 19.0,
          weatherTemp: -8.0,
          hour: 10,
          isWeekday: true,
        })
      );

      expect(needsDefrost).toBe(false);
    });
  });

  describe('Active Hours Logic Validation', () => {
    it('should respect weekday vs weekend active hours for heating', async () => {
      const scenario = sampleTemperatureData.heating.coldDay;

      // Test weekday early hour (7 AM) - should heat
      const weekdayEarly = await Effect.runPromise(
        heatingStrategy.shouldHeat({
          currentTemp: scenario.indoor,
          weatherTemp: scenario.outdoor,
          hour: 7, // startWeekday = 7
          isWeekday: true,
        })
      );

      // Test weekend early hour (5 AM) - should not heat (start = 6)
      const weekendEarly = await Effect.runPromise(
        heatingStrategy.shouldHeat({
          currentTemp: scenario.indoor,
          weatherTemp: scenario.outdoor,
          hour: 5, // Before weekend start (6)
          isWeekday: false,
        })
      );

      expect(weekdayEarly).toBe(true);
      expect(weekendEarly).toBe(false);
    });

    it('should handle boundary hour conditions for heating', async () => {
      const scenario = sampleTemperatureData.heating.coldDay;

      // Test exact start hour
      const startHour = await Effect.runPromise(
        heatingStrategy.shouldHeat({
          currentTemp: scenario.indoor,
          weatherTemp: scenario.outdoor,
          hour: 6, // Exact start hour for weekend
          isWeekday: false,
        })
      );

      // Test exact end hour
      const endHour = await Effect.runPromise(
        heatingStrategy.shouldHeat({
          currentTemp: scenario.indoor,
          weatherTemp: scenario.outdoor,
          hour: 22, // Exact end hour
          isWeekday: false,
        })
      );

      expect(startHour).toBe(true);
      expect(endHour).toBe(true);
    });

    it('should handle no active hours restriction for heating', async () => {
      const noActiveHoursOptions = createTestStateMachine({
        activeHours: undefined,
      });
      const strategy = new HeatingStrategy(noActiveHoursOptions);
      const scenario = sampleTemperatureData.heating.coldDay;

      const shouldHeat = await Effect.runPromise(
        strategy.shouldHeat({
          currentTemp: scenario.indoor,
          weatherTemp: scenario.outdoor,
          hour: 2, // Middle of night
          isWeekday: true,
        })
      );

      expect(shouldHeat).toBe(true);
    });
  });

  describe('Temperature Threshold Edge Cases', () => {
    it('should handle exact threshold temperatures for heating', async () => {
      const time = timeScenarios.activeWeekday;

      // Test exact minimum temperature
      const atMin = await Effect.runPromise(
        heatingStrategy.shouldHeat({
          currentTemp: 20.0, // Exact minimum
          weatherTemp: 5.0,
          hour: time.hour,
          isWeekday: time.isWeekday,
        })
      );

      // Test exact maximum temperature
      const atMax = await Effect.runPromise(
        heatingStrategy.shouldHeat({
          currentTemp: 22.0, // Exact maximum
          weatherTemp: 5.0,
          hour: time.hour,
          isWeekday: time.isWeekday,
        })
      );

      expect(atMin).toBe(false); // At minimum, should not heat
      expect(atMax).toBe(false); // At maximum, should not heat
    });

    it('should heat when indoor temperature falls below minimum threshold', async () => {
      const time = timeScenarios.activeWeekday;

      const belowMin = await Effect.runPromise(
        heatingStrategy.shouldHeat({
          currentTemp: 19.9, // Just below minimum (20.0)
          weatherTemp: 5.0,
          hour: time.hour,
          isWeekday: time.isWeekday,
        })
      );

      expect(belowMin).toBe(true);
    });

    it('should handle extreme cold conditions', async () => {
      const time = timeScenarios.activeWeekday;

      // Extreme indoor cold
      const extremeIndoor = await Effect.runPromise(
        heatingStrategy.shouldHeat({
          currentTemp: 10.0, // Very cold indoor
          weatherTemp: 0.0,
          hour: time.hour,
          isWeekday: time.isWeekday,
        })
      );

      expect(extremeIndoor).toBe(true);
    });
  });

  describe('Seasonal Scenario Simulation', () => {
    it('should handle typical winter day heating cycle', async () => {
      const winterDay = [
        { hour: 6, indoor: 19.0, outdoor: -2.0, expected: true }, // Early morning, cold
        { hour: 8, indoor: 20.5, outdoor: 0.0, expected: false }, // Warmed up
        { hour: 16, indoor: 19.5, outdoor: -1.0, expected: true }, // Evening cool down
        { hour: 22, indoor: 21.0, outdoor: 2.0, expected: false }, // Warmed up for night
        { hour: 23, indoor: 18.0, outdoor: -3.0, expected: false }, // Outside active hours
      ];

      for (const scenario of winterDay) {
        const shouldHeat = await Effect.runPromise(
          heatingStrategy.shouldHeat({
            currentTemp: scenario.indoor,
            weatherTemp: scenario.outdoor,
            hour: scenario.hour,
            isWeekday: true,
          })
        );

        expect(shouldHeat).toBe(scenario.expected);
      }
    });

    it('should handle mild spring/fall day (limited heating)', async () => {
      const mildDay = [
        { hour: 8, indoor: 21.0, outdoor: 8.0 }, // Mild morning, no heating
        { hour: 12, indoor: 22.0, outdoor: 12.0 }, // Warm midday, no heating  
        { hour: 18, indoor: 21.5, outdoor: 10.0 }, // Mild evening, no heating
      ];

      for (const scenario of mildDay) {
        const shouldHeat = await Effect.runPromise(
          heatingStrategy.shouldHeat({
            currentTemp: scenario.indoor,
            weatherTemp: scenario.outdoor,
            hour: scenario.hour,
            isWeekday: true,
          })
        );

        expect(shouldHeat).toBe(false);
      }
    });
  });

  describe('Defrost Cycle Integration Testing', () => {
    it('should simulate complete defrost cycle with timing', async () => {
      const defrostScenario = {
        currentTemp: 19.0,
        weatherTemp: -8.0, // Below defrost threshold
        hour: 10,
        isWeekday: true,
      };

      // Initially should need defrost
      const initialDefrostCheck = await Effect.runPromise(
        heatingStrategy.needsDefrost(defrostScenario)
      );
      expect(initialDefrostCheck).toBe(true);

      // Start defrost
      await Effect.runPromise(heatingStrategy.startDefrost());

      // Immediately after starting, should not need defrost
      const afterStartCheck = await Effect.runPromise(
        heatingStrategy.needsDefrost(defrostScenario)
      );
      expect(afterStartCheck).toBe(false);

      // Should still want to heat during defrost (defrost doesn't prevent heating decision)
      const shouldHeatDuringDefrost = await Effect.runPromise(
        heatingStrategy.shouldHeat(defrostScenario)
      );
      expect(shouldHeatDuringDefrost).toBe(true);
    });

    it('should handle defrost completion tracking', async () => {
      // Start defrost
      await Effect.runPromise(heatingStrategy.startDefrost());
      
      // Verify defrost was started (internal state changed)
      const needsDefrostAfterStart = await Effect.runPromise(
        heatingStrategy.needsDefrost({
          currentTemp: 19.0,
          weatherTemp: -8.0,
          hour: 10,
          isWeekday: true,
        })
      );

      expect(needsDefrostAfterStart).toBe(false);
    });
  });

  describe('Entity-Specific Defrost Behavior', () => {
    it('should handle mixed defrost settings across entities', async () => {
      // Test with defrost enabled
      const withDefrostOptions = createTestStateMachine({
        heating: {
          ...testOptions.heating,
          defrost: {
            temperatureThreshold: -5.0,
            periodSeconds: 3600,
            durationSeconds: 300,
          },
        },
      });

      const strategyWithDefrost = new HeatingStrategy(withDefrostOptions);
      
      const needsDefrostWith = await Effect.runPromise(
        strategyWithDefrost.needsDefrost({
          currentTemp: 19.0,
          weatherTemp: -8.0,
          hour: 10,
          isWeekday: true,
        })
      );

      // Test without defrost
      const withoutDefrostOptions = createTestStateMachine({
        heating: {
          ...testOptions.heating,
          defrost: undefined,
        },
      });

      const strategyWithoutDefrost = new HeatingStrategy(withoutDefrostOptions);
      
      const needsDefrostWithout = await Effect.runPromise(
        strategyWithoutDefrost.needsDefrost({
          currentTemp: 19.0,
          weatherTemp: -8.0,
          hour: 10,
          isWeekday: true,
        })
      );

      expect(needsDefrostWith).toBe(true);
      expect(needsDefrostWithout).toBe(false);
    });

    it('should validate different defrost configurations', () => {
      const defrostConfigs = [
        { temperatureThreshold: -5.0, periodSeconds: 3600, durationSeconds: 300 },
        { temperatureThreshold: -10.0, periodSeconds: 7200, durationSeconds: 600 },
        { temperatureThreshold: 0.0, periodSeconds: 1800, durationSeconds: 150 },
      ];
      
      defrostConfigs.forEach(config => {
        const options = createTestStateMachine({
          heating: {
            ...testOptions.heating,
            defrost: config,
          },
        });

        expect(options.heating.defrost?.temperatureThreshold).toBe(config.temperatureThreshold);
        expect(options.heating.defrost?.periodSeconds).toBe(config.periodSeconds);
        expect(options.heating.defrost?.durationSeconds).toBe(config.durationSeconds);
      });
    });
  });

  describe('Preset Mode Behaviors', () => {
    it('should validate different preset modes for heating', () => {
      const presetModes = ['comfort', 'quiet', 'windFreeSleep', 'eco', 'boost'];
      
      presetModes.forEach(preset => {
        const options = createTestStateMachine({
          heating: {
            ...testOptions.heating,
            presetMode: preset,
          },
        });

        expect(options.heating.presetMode).toBe(preset);
      });
    });

    it('should handle heating with different preset configurations', async () => {
      const presetOptions = createTestStateMachine({
        heating: {
          ...testOptions.heating,
          presetMode: 'boost',
        },
      });

      const strategy = new HeatingStrategy(presetOptions);
      const scenario = sampleTemperatureData.heating.coldDay;
      const time = timeScenarios.activeWeekday;

      const shouldHeat = await Effect.runPromise(
        strategy.shouldHeat({
          currentTemp: scenario.indoor,
          weatherTemp: scenario.outdoor,
          hour: time.hour,
          isWeekday: time.isWeekday,
        })
      );

      expect(shouldHeat).toBe(true);
      expect(presetOptions.heating.presetMode).toBe('boost');
    });
  });

  describe('State Transition Testing', () => {
    it('should simulate heating state transitions', async () => {
      // Simulate: Off → Heating → Defrost → Heating → Off cycle
      const transitionScenarios = [
        { name: 'Initial cold state', indoor: 19.0, outdoor: 5.0, expected: true },
        { name: 'Heating active', indoor: 20.5, outdoor: 5.0, expected: false },
        { name: 'Cold again', indoor: 19.5, outdoor: -8.0, expected: true, expectDefrost: true },
        { name: 'Warmed up', indoor: 21.5, outdoor: 8.0, expected: false },
      ];

      const time = timeScenarios.activeWeekday;

      for (const scenario of transitionScenarios) {
        const shouldHeat = await Effect.runPromise(
          heatingStrategy.shouldHeat({
            currentTemp: scenario.indoor,
            weatherTemp: scenario.outdoor,
            hour: time.hour,
            isWeekday: time.isWeekday,
          })
        );

        expect(shouldHeat).toBe(scenario.expected);

        if (scenario.expectDefrost) {
          const needsDefrost = await Effect.runPromise(
            heatingStrategy.needsDefrost({
              currentTemp: scenario.indoor,
              weatherTemp: scenario.outdoor,
              hour: time.hour,
              isWeekday: time.isWeekday,
            })
          );
          expect(needsDefrost).toBe(true);
        }
      }
    });

    it('should handle rapid temperature oscillation for heating', async () => {
      const time = timeScenarios.activeWeekday;
      const oscillations = [
        { indoor: 19.9, expected: true },  // Just below threshold
        { indoor: 20.1, expected: false }, // Just above threshold
        { indoor: 19.8, expected: true },  // Below again
        { indoor: 20.2, expected: false }, // Above again
      ];

      for (const oscillation of oscillations) {
        const shouldHeat = await Effect.runPromise(
          heatingStrategy.shouldHeat({
            currentTemp: oscillation.indoor,
            weatherTemp: 5.0,
            hour: time.hour,
            isWeekday: time.isWeekday,
          })
        );

        expect(shouldHeat).toBe(oscillation.expected);
      }
    });
  });

  describe('Helper Function Testing', () => {
    it('should validate temperature ranges correctly for heating', () => {
      const { heating } = testOptions;
      
      expect(testUtils.assertTemperatureInRange(21.0, heating.temperatureThresholds.indoorMin, heating.temperatureThresholds.indoorMax)).toBe(true);
      expect(testUtils.assertTemperatureInRange(19.0, heating.temperatureThresholds.indoorMin, heating.temperatureThresholds.indoorMax)).toBe(false);
      expect(testUtils.assertTemperatureInRange(23.0, heating.temperatureThresholds.indoorMin, heating.temperatureThresholds.indoorMax)).toBe(false);
    });

    it('should validate outdoor temperature ranges for heating', () => {
      const { heating } = testOptions;
      
      expect(testUtils.assertTemperatureInRange(5.0, heating.temperatureThresholds.outdoorMin, heating.temperatureThresholds.outdoorMax)).toBe(true);
      expect(testUtils.assertTemperatureInRange(-15.0, heating.temperatureThresholds.outdoorMin, heating.temperatureThresholds.outdoorMax)).toBe(false);
      expect(testUtils.assertTemperatureInRange(20.0, heating.temperatureThresholds.outdoorMin, heating.temperatureThresholds.outdoorMax)).toBe(false);
    });
  });

  describe('Decision Simulation Helpers', () => {
    it('should simulate heating decisions for test scenarios', async () => {
      const shouldHeatScenarios = testScenarios.heating.shouldHeat();
      const shouldNotHeatScenarios = testScenarios.heating.shouldNotHeat();

      // Test scenarios that should trigger heating
      for (const scenario of shouldHeatScenarios) {
        const shouldHeat = await Effect.runPromise(
          heatingStrategy.shouldHeat({
            currentTemp: scenario.indoor,
            weatherTemp: scenario.outdoor,
            hour: scenario.hour,
            isWeekday: scenario.isWeekday,
          })
        );

        expect(shouldHeat).toBe(true);
      }

      // Test scenarios that should not trigger heating
      for (const scenario of shouldNotHeatScenarios) {
        const shouldHeat = await Effect.runPromise(
          heatingStrategy.shouldHeat({
            currentTemp: scenario.indoor,
            weatherTemp: scenario.outdoor,
            hour: scenario.hour,
            isWeekday: scenario.isWeekday,
          })
        );

        expect(shouldHeat).toBe(false);
      }
    });

    it('should handle defrost needed scenarios', async () => {
      const defrostScenarios = testScenarios.heating.defrostNeeded();

      for (const scenario of defrostScenarios) {
        const needsDefrost = await Effect.runPromise(
          heatingStrategy.needsDefrost({
            currentTemp: scenario.indoor,
            weatherTemp: scenario.outdoor,
            hour: scenario.hour,
            isWeekday: scenario.isWeekday,
          })
        );

        expect(needsDefrost).toBe(true);
      }
    });
  });

  describe('Configuration Validation', () => {
    it('should validate heating configuration parameters', () => {
      const { heating } = testOptions;
      
      expect(heating.temperature).toBe(21.0);
      expect(heating.temperatureThresholds.indoorMin).toBe(20.0);
      expect(heating.temperatureThresholds.indoorMax).toBe(22.0);
      expect(heating.temperatureThresholds.outdoorMin).toBe(-10.0);
      expect(heating.temperatureThresholds.outdoorMax).toBe(15.0);
      expect(heating.presetMode).toBe('comfort');
    });

    it('should validate defrost configuration parameters', () => {
      const { heating } = testOptions;
      
      expect(heating.defrost?.temperatureThreshold).toBe(-5.0);
      expect(heating.defrost?.periodSeconds).toBe(3600);
      expect(heating.defrost?.durationSeconds).toBe(300);
    });

    it('should validate active hours configuration for heating', () => {
      const { activeHours } = testOptions;
      
      expect(activeHours?.start).toBe(6);
      expect(activeHours?.end).toBe(22);
      expect(activeHours?.startWeekday).toBe(7);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle invalid temperature values gracefully', async () => {
      const time = timeScenarios.activeWeekday;

      // Test with NaN values
      const shouldHeatNaN = await Effect.runPromise(
        heatingStrategy.shouldHeat({
          currentTemp: NaN,
          weatherTemp: 5.0,
          hour: time.hour,
          isWeekday: time.isWeekday,
        })
      );

      expect(shouldHeatNaN).toBe(false);
    });

    it('should handle extreme temperature values', async () => {
      const time = timeScenarios.activeWeekday;

      // Test with extreme values
      const extremeValues = [
        { indoor: -100, outdoor: 5.0, expected: true },
        { indoor: 100, outdoor: 5.0, expected: false },
        { indoor: 19.0, outdoor: -100, expected: false },
        { indoor: 19.0, outdoor: 100, expected: false },
      ];

      for (const values of extremeValues) {
        const shouldHeat = await Effect.runPromise(
          heatingStrategy.shouldHeat({
            currentTemp: values.indoor,
            weatherTemp: values.outdoor,
            hour: time.hour,
            isWeekday: time.isWeekday,
          })
        );

        expect(shouldHeat).toBe(values.expected);
      }
    });
  });
});