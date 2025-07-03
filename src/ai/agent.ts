/**
 * AI Agent for HAG Effect-TS variant.
 *
 * Effect-native LangChain integration for intelligent HVAC decision making.
 */

import { Context, Effect, Layer, pipe, Ref } from 'effect';
import { NodeHttpClient } from '@effect/platform-node';
import { ChatOpenAI } from '@langchain/openai';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { Tool } from '@langchain/core/tools';
import { AgentExecutor, createToolCallingAgent } from 'langchain/agents';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { ApplicationOptions, HvacOptions } from '../config/settings_simple.ts';
import { HVACStateMachine } from '../hvac/state-machine.ts';
import { HomeAssistantClient } from '../home-assistant/client.ts';
import { HVACMode, OperationResult } from '../types/common.ts';
import { AIError, ErrorUtils } from '../core/exceptions.ts';
import {
  ApplicationOptionsService,
  HvacOptionsService,
  LoggerService,
} from '../core/container.ts';

/**
 * HVAC status summary interface
 */
interface HVACStatusSummary {
  success: boolean;
  aiSummary?: string;
  recommendations?: string[];
  error?: string;
}

/**
 * Temperature change event data
 */
interface TemperatureChangeEvent {
  entityId: string;
  newState: string;
  oldState?: string;
  timestamp: string;
  attributes?: Record<string, unknown>;
}

/**
 * AI Agent state
 */
interface AgentState {
  llm?: ChatOpenAI;
  tools: Tool[];
  agent?: AgentExecutor;
  conversationHistory: (HumanMessage | AIMessage | SystemMessage)[];
}

/**
 * HVAC Agent service definition
 */
export class HVACAgent extends Context.Tag('HVACAgent')<
  HVACAgent,
  {
    readonly processTemperatureChange: (
      event: TemperatureChangeEvent,
    ) => Effect.Effect<OperationResult, AIError>;
    readonly manualOverride: (
      action: string,
      options?: Record<string, unknown>,
    ) => Effect.Effect<OperationResult, AIError>;
    readonly evaluateEfficiency: () => Effect.Effect<OperationResult, AIError>;
    readonly getStatusSummary: () => Effect.Effect<HVACStatusSummary, never>;
    readonly clearHistory: () => Effect.Effect<void, never>;
    readonly getHistoryLength: () => Effect.Effect<number, never>;
  }
>() {}

/**
 * Effect-native HVAC control tool
 */
class EffectHVACControlTool extends Tool {
  name = 'hvac_control';
  description =
    'Control HVAC system (heat, cool, off) with optional target temperature';

  constructor(
    private stateMachine: Context.Tag.Service<HVACStateMachine>,
    private logger: Context.Tag.Service<LoggerService>,
  ) {
    super();
  }

  async _call(input: string): Promise<string> {
    const executionStart = Date.now();
    return Effect.runPromise(
      pipe(
        Effect.tryPromise({
          try: async () => {
            await Effect.runPromise(
              this.logger.info('🤖 AI executing HVAC control tool', {
                input,
                timestamp: new Date().toISOString(),
              }),
            );
            const { action, temperature } = JSON.parse(input);

            await Effect.runPromise(
              this.logger.debug('📝 AI parsed HVAC control parameters', {
                action,
                temperature,
                hasTemperature: temperature !== undefined,
              }),
            );

            let mode: HVACMode;
            switch (action.toLowerCase()) {
              case 'heat':
                mode = HVACMode.HEAT;
                break;
              case 'cool':
                mode = HVACMode.COOL;
                break;
              case 'off':
                mode = HVACMode.OFF;
                break;
              default:
                await Effect.runPromise(
                  this.logger.warning('⚠️ AI provided invalid HVAC action', {
                    action,
                    validActions: ['heat', 'cool', 'off'],
                  }),
                );
                return `Error: Invalid action '${action}'. Use 'heat', 'cool', or 'off'.`;
            }

            const status = await Effect.runPromise(this.stateMachine.getStatus());
            const currentState = status.currentState;

            await Effect.runPromise(
              this.logger.info('⚡ AI executing HVAC mode change', {
                requestedMode: mode,
                requestedTemperature: temperature,
                currentState,
                currentContext: status.context,
                decisionRationale: 'AI_agent_decision',
              }),
            );

            await Effect.runPromise(
              this.stateMachine.manualOverride(mode, temperature),
            );

            const newStatus = await Effect.runPromise(this.stateMachine.getStatus());
            const newState = newStatus.currentState;
            const executionTime = Date.now() - executionStart;

            await Effect.runPromise(
              this.logger.info('✅ AI HVAC control executed successfully', {
                action,
                mode,
                temperature,
                oldState: currentState,
                newState,
                stateChanged: currentState !== newState,
                executionTimeMs: executionTime,
              }),
            );

            return `Successfully set HVAC to ${action}${
              temperature ? ` at ${temperature}°C` : ''
            }. State changed from ${currentState} to ${newState}.`;
          },
          catch: (error) => {
            const executionTime = Date.now() - executionStart;
            const errorMsg = `Failed to control HVAC: ${
              error instanceof Error ? error.message : String(error)
            }`;
            Effect.runSync(
              this.logger.error('❌ AI HVAC control failed', error, {
                input,
                executionTimeMs: executionTime,
                errorType: error instanceof Error ? error.name : 'Unknown',
              }),
            );
            return errorMsg;
          },
        }),
      ),
    );
  }

  private executeManualOverride = (
    mode: HVACMode,
    temperature?: number,
  ): Effect.Effect<void, AIError> =>
    pipe(
      this.stateMachine.manualOverride(mode, temperature),
      Effect.mapError((stateError) =>
        ErrorUtils.aiError(
          `Manual override execution failed: ${
            stateError instanceof Error
              ? stateError.message
              : String(stateError)
          }`,
        )
      ),
    );
}

/**
 * Effect-native temperature reading tool
 */
class EffectTemperatureReadingTool extends Tool {
  name = 'get_temperature';
  description = 'Get current indoor and outdoor temperature readings';

  constructor(
    private haClient: Context.Tag.Service<HomeAssistantClient>,
    private hvacOptions: HvacOptions,
    private logger: Context.Tag.Service<LoggerService>,
  ) {
    super();
  }

  async _call(_input: string): Promise<string> {
    const readingStart = Date.now();
    return Effect.runPromise(
      pipe(
        Effect.tryPromise({
          try: async () => {
            await Effect.runPromise(
              this.logger.info('🌡️ AI reading temperature data', {
                indoorSensor: this.hvacOptions.tempSensor,
                outdoorSensor: this.hvacOptions.outdoorSensor,
                timestamp: new Date().toISOString(),
              }),
            );

            const indoorState = await Effect.runPromise(
              pipe(
                this.haClient.getState(this.hvacOptions.tempSensor),
                Effect.provide(NodeHttpClient.layer),
              ),
            );
            const indoorTemp = indoorState.getNumericState();

            await Effect.runPromise(
              this.logger.debug('✅ AI indoor temperature retrieved', {
                sensor: this.hvacOptions.tempSensor,
                temperature: indoorTemp,
                state: indoorState.state,
                lastUpdated: indoorState.lastUpdated,
              }),
            );

            let outdoorTemp: number | null = null;
            try {
              const outdoorState = await Effect.runPromise(
                pipe(
                  this.haClient.getState(this.hvacOptions.outdoorSensor),
                  Effect.provide(NodeHttpClient.layer),
                ),
              );
              outdoorTemp = outdoorState.getNumericState();

              await Effect.runPromise(
                this.logger.debug('✅ AI outdoor temperature retrieved', {
                  sensor: this.hvacOptions.outdoorSensor,
                  temperature: outdoorTemp,
                  state: outdoorState.state,
                  lastUpdated: outdoorState.lastUpdated,
                }),
              );
            } catch (error) {
              await Effect.runPromise(
                this.logger.warning(
                  '⚠️ AI failed to get outdoor temperature',
                  {
                    error,
                    sensor: this.hvacOptions.outdoorSensor,
                    fallbackBehavior: 'continue_with_null',
                  },
                ),
              );
            }

            const result = {
              indoor: indoorTemp,
              outdoor: outdoorTemp,
              timestamp: new Date().toISOString(),
            };

            const readingTime = Date.now() - readingStart;

            await Effect.runPromise(
              this.logger.info('✅ AI temperature reading completed', {
                ...result,
                readingTimeMs: readingTime,
                indoorValid: indoorTemp !== null,
                outdoorValid: outdoorTemp !== null,
                temperatureDifference: indoorTemp && outdoorTemp
                  ? indoorTemp - outdoorTemp
                  : null,
              }),
            );

            return JSON.stringify(result);
          },
          catch: (error) => {
            const readingTime = Date.now() - readingStart;
            const errorMsg = `Failed to read temperatures: ${
              error instanceof Error ? error.message : String(error)
            }`;
            Effect.runSync(
              this.logger.error('❌ AI temperature reading failed', error, {
                readingTimeMs: readingTime,
                indoorSensor: this.hvacOptions.tempSensor,
                outdoorSensor: this.hvacOptions.outdoorSensor,
                errorType: error instanceof Error ? error.name : 'Unknown',
              }),
            );
            return errorMsg;
          },
        }),
      ),
    );
  }
}

/**
 * Effect-native HVAC status tool
 */
class EffectHVACStatusTool extends Tool {
  name = 'get_hvac_status';
  description = 'Get current HVAC system status and state machine information';

  constructor(
    private stateMachine: Context.Tag.Service<HVACStateMachine>,
    private logger: Context.Tag.Service<LoggerService>,
  ) {
    super();
  }

  async _call(_input: string): Promise<string> {
    const statusStart = Date.now();
    return Effect.runPromise(
      pipe(
        Effect.tryPromise({
          try: async () => {
            await Effect.runPromise(
              this.logger.info('📋 AI reading HVAC status', {
                timestamp: new Date().toISOString(),
              }),
            );

            const status = await Effect.runPromise(this.stateMachine.getStatus());

            const result = {
              currentState: status.currentState,
              context: status.context,
              canHeat: status.canHeat,
              canCool: status.canCool,
              systemMode: status.systemMode,
              timestamp: new Date().toISOString(),
            };

            const statusTime = Date.now() - statusStart;

            await Effect.runPromise(
              this.logger.info('✅ AI HVAC status retrieved', {
                ...result,
                statusTimeMs: statusTime,
                hasTemperatureData: !!(status.context.indoorTemp &&
                  status.context.outdoorTemp),
                isActive: status.currentState !== 'idle',
              }),
            );

            return JSON.stringify(result);
          },
          catch: (error) => {
            const statusTime = Date.now() - statusStart;
            const errorMsg = `Failed to get HVAC status: ${
              error instanceof Error ? error.message : String(error)
            }`;
            Effect.runSync(
              this.logger.error('❌ AI status reading failed', error, {
                statusTimeMs: statusTime,
                errorType: error instanceof Error ? error.name : 'Unknown',
              }),
            );
            return errorMsg;
          },
        }),
      ),
    );
  }
}

/**
 * HVAC Agent implementation
 */
class HVACAgentImpl {
  constructor(
    private hvacOptions: HvacOptions,
    private appOptions: ApplicationOptions,
    private stateMachine: Context.Tag.Service<HVACStateMachine>,
    private haClient: Context.Tag.Service<HomeAssistantClient>,
    private logger: Context.Tag.Service<LoggerService>,
    private stateRef: Ref.Ref<AgentState>,
  ) {}

  /**
   * Initialize the LangChain agent
   */
  initializeAgent = (): Effect.Effect<void, AIError> => {
    const initStart = Date.now();
    return pipe(
      Effect.gen((function* (this: HVACAgentImpl) {
        yield* this.logger.info('🤖 Initializing AI agent', {
          model: 'gpt-4o-mini',
          temperature: 0.1,
          systemMode: this.hvacOptions.systemMode,
          toolsCount: 3,
          hasApiKey: !!this.appOptions.openaiApiKey,
          logLevel: this.appOptions.logLevel,
          timestamp: new Date().toISOString(),
        });

        const llm = new ChatOpenAI({
          modelName: 'gpt-4o-mini',
          temperature: 0.1,
          openAIApiKey: this.appOptions.openaiApiKey,
        });

        const tools = [
          new EffectHVACControlTool(this.stateMachine, this.logger),
          new EffectTemperatureReadingTool(
            this.haClient,
            this.hvacOptions,
            this.logger,
          ),
          new EffectHVACStatusTool(this.stateMachine, this.logger),
        ];

        const systemPrompt =
          `You are an intelligent HVAC automation agent for a home automation system.\n\nYour role is to:\n1. Monitor temperature changes and make intelligent heating/cooling decisions\n2. Analyze HVAC system efficiency and provide recommendations\n3. Handle manual override requests with validation\n4. Provide status summaries and insights\n\nCurrent HVAC Configuration:\n- System Mode: ${this.hvacOptions.systemMode}\n- Temperature Sensor: ${this.hvacOptions.tempSensor}\n- Outdoor Sensor: ${this.hvacOptions.outdoorSensor}\n- Heating Target: ${this.hvacOptions.heating.temperature}°C\n- Cooling Target: ${this.hvacOptions.cooling.temperature}°C\n- Heating Range: ${this.hvacOptions.heating.temperatureThresholds.indoorMin}°C - ${this.hvacOptions.heating.temperatureThresholds.indoorMax}°C\n- Cooling Range: ${this.hvacOptions.cooling.temperatureThresholds.indoorMin}°C - ${this.hvacOptions.cooling.temperatureThresholds.indoorMax}°C\n\nAvailable Tools:\n1. hvac_control - Control HVAC system (heat/cool/off)\n2. get_temperature - Read current temperatures\n3. get_hvac_status - Get system status\n\nAlways consider:\n- Energy efficiency\n- Comfort optimization\n- Outdoor weather conditions\n- Time of day and usage patterns\n- System constraints and thresholds\n\nRespond concisely and provide actionable insights.`;

        yield* this.logger.debug('📝 AI system prompt configured', {
          promptLength: systemPrompt.length,
          configurationIncluded: {
            systemMode: true,
            sensors: true,
            thresholds: true,
            targets: true,
          },
        });

        const prompt = ChatPromptTemplate.fromMessages([
          ['system', systemPrompt],
          ['placeholder', '{chat_history}'],
          ['human', '{input}'],
          ['placeholder', '{agent_scratchpad}'],
        ]);

        yield* this.logger.debug('⚙️ Creating LangChain agent', {
          toolsAvailable: tools.map((t) => ({ name: t.name, description: t.description })),
          llmModel: 'gpt-4o-mini',
        });

        const agent = yield* Effect.tryPromise({
          try: () =>
            Promise.resolve(
              createToolCallingAgent({
                llm: llm as never,
                tools,
                prompt,
              }),
            ),
          catch: (error) =>
            ErrorUtils.aiError(`Failed to create agent: ${error}`),
        });

        const executor = new AgentExecutor({
          agent,
          tools,
          verbose: this.appOptions.logLevel === 'debug',
          maxIterations: 10,
          handleParsingErrors: true,
        });

        yield* Ref.update(this.stateRef, (state) => ({
          ...state,
          llm,
          tools,
          agent: executor,
        }));

        const initTime = Date.now() - initStart;
        yield* this.logger.info('✅ AI agent initialized successfully', {
          initializationTimeMs: initTime,
          maxIterations: 10,
          verboseMode: this.appOptions.logLevel === 'debug',
          toolsRegistered: tools.length,
          agentReady: true,
        });
      }).bind(this)),
      Effect.catchAll((error) => {
        const initTime = Date.now() - initStart;
        return pipe(
          this.logger.error('❌ Failed to initialize AI agent', error, {
            initializationTimeMs: initTime,
            errorType: error instanceof Error ? error.name : 'Unknown',
            hasApiKey: !!this.appOptions.openaiApiKey,
            toolsCount: 3,
          }),
          Effect.andThen(Effect.fail(error)),
        );
      }),
    );
  };

  /**
   * Process temperature change events
   */
  processTemperatureChange = (
    event: TemperatureChangeEvent,
  ): Effect.Effect<OperationResult, AIError> =>
    pipe(
      this.stateRef,
      Ref.get,
      Effect.flatMap((state) => {
        if (!state.agent) {
          return Effect.fail(ErrorUtils.aiError('AI agent not initialized'));
        }

        return pipe(
          this.logger.info('AI processing temperature change', {
            entityId: event.entityId,
            newState: event.newState,
            oldState: event.oldState,
          }),
          Effect.andThen(() => {
            const input = `Temperature sensor ${event.entityId} changed from ${
              event.oldState || 'unknown'
            } to ${event.newState} at ${event.timestamp}.

Please analyze this change and determine if any HVAC action is needed. Consider:
1. Current system status and mode
2. Temperature thresholds and targets
3. Outdoor conditions
4. Energy efficiency

If action is needed, execute the appropriate HVAC control.`;

            return Effect.tryPromise({
              try: () =>
                state.agent!.invoke({
                  input,
                  chat_history: state.conversationHistory,
                }),
              catch: (error) =>
                ErrorUtils.aiError(`Temperature processing failed: ${error}`),
            });
          }),
          Effect.flatMap((result) =>
            pipe(
              this.updateConversationHistory(event.entityId, result.output),
              Effect.map(() => ({
                success: true,
                data: {
                  aiResponse: result.output,
                  steps: result.intermediateSteps?.length || 0,
                },
                timestamp: new Date().toISOString(),
              })),
            )
          ),
          Effect.tap(() =>
            this.logger.info('AI temperature change processing completed')
          ),
        );
      }),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('AI temperature change processing failed', error),
          Effect.andThen(Effect.succeed({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
          })),
        )
      ),
    );

  /**
   * Handle manual override requests
   */
  manualOverride = (
    action: string,
    options: Record<string, unknown> = {},
  ): Effect.Effect<OperationResult, AIError> =>
    pipe(
      this.stateRef,
      Ref.get,
      Effect.flatMap((state) => {
        if (!state.agent) {
          return Effect.fail(ErrorUtils.aiError('AI agent not initialized'));
        }

        const overrideStart = Date.now();
        return pipe(
          this.logger.info('🎯 AI processing manual override request', {
            action,
            options,
            hasTemperature: options.temperature !== undefined,
            requestedTemperature: options.temperature,
            conversationHistoryLength: state.conversationHistory.length,
          }),
          Effect.andThen(() => {
            const input =
              `User requested manual HVAC override: action="${action}"${
                options.temperature
                  ? `, temperature=${options.temperature}°C`
                  : ''
              }.

Please:
1. Validate this request against current conditions and thresholds
2. Check if this action makes sense given current indoor/outdoor temperatures
3. Execute the HVAC control if appropriate
4. Provide feedback on the action and any recommendations

Use the hvac_control tool to execute the override: {"action": "${action}"${
                options.temperature
                  ? `, "temperature": ${options.temperature}`
                  : ''
              }}.`;

            return Effect.tryPromise({
              try: () =>
                state.agent!.invoke({
                  input,
                  chat_history: state.conversationHistory,
                }),
              catch: (error) =>
                ErrorUtils.aiError(`Manual override failed: ${error}`),
            });
          }),
          Effect.flatMap((result) =>
            pipe(
              this.updateConversationHistory(`manual_override_${action}`, result.output),
              Effect.map(() => {
                const overrideTime = Date.now() - overrideStart;
                return {
                  success: true,
                  data: {
                    aiResponse: result.output,
                    action,
                    options,
                    steps: result.intermediateSteps?.length || 0,
                    toolsUsed: result.intermediateSteps?.map((step: any) => step.action?.tool) || [],
                    overrideTimeMs: overrideTime,
                    validationResult: !result.output.toLowerCase().includes('error') ? 'approved' : 'rejected'
                  },
                  timestamp: new Date().toISOString(),
                };
              }),
            )
          ),
          Effect.tap((result) =>
            this.logger.info('✅ AI manual override completed', {
              action,
              options,
              output: result.data.aiResponse.substring(0, 150) + (result.data.aiResponse.length > 150 ? '...' : ''),
              outputLength: result.data.aiResponse.length,
              intermediateSteps: result.data.steps,
              overrideTimeMs: result.data.overrideTimeMs,
              toolsUsed: result.data.toolsUsed,
              validationPassed: result.data.validationResult === 'approved',
              conversationLength: state.conversationHistory.length
            })
          ),
        );
      }),
    );

  /**
   * Evaluate system efficiency
   */
  evaluateEfficiency = (): Effect.Effect<OperationResult, AIError> =>
    pipe(
      this.stateRef,
      Ref.get,
      Effect.flatMap((state) => {
        if (!state.agent) {
          return Effect.fail(ErrorUtils.aiError('AI agent not initialized'));
        }

        return pipe(
          this.logger.info('AI evaluating system efficiency'),
          Effect.andThen(() => {
            const input =
              `Please analyze the current HVAC system efficiency and performance.

Steps:
1. Get current temperatures using get_temperature tool
2. Get HVAC status using get_hvac_status tool
3. Analyze efficiency based on:
   - Temperature differential between indoor/outdoor
   - Current system state and mode
   - How well the system is maintaining target temperatures
   - Energy efficiency considerations
4. Provide specific recommendations for improvement

Please provide a comprehensive analysis with actionable recommendations.`;

            return Effect.tryPromise({
              try: () =>
                state.agent!.invoke({
                  input,
                  chat_history: state.conversationHistory,
                }),
              catch: (error) =>
                ErrorUtils.aiError(`Efficiency evaluation failed: ${error}`),
            });
          }),
          Effect.flatMap((result) =>
            pipe(
              this.updateConversationHistory(
                'efficiency_evaluation',
                result.output,
              ),
              Effect.map(() => ({
                success: true,
                data: {
                  analysis: result.output,
                  recommendations: this.extractRecommendations(result.output),
                },
                timestamp: new Date().toISOString(),
              })),
            )
          ),
          Effect.tap(() =>
            this.logger.info('AI efficiency evaluation completed')
          ),
        );
      }),
    );

  /**
   * Get system status summary
   */
  getStatusSummary = (): Effect.Effect<HVACStatusSummary, never> =>
    pipe(
      this.stateRef,
      Ref.get,
      Effect.flatMap((state) => {
        if (!state.agent) {
          return Effect.succeed({
            success: false,
            error: 'AI agent not initialized',
          });
        }

        return pipe(
          this.logger.debug('AI generating status summary'),
          Effect.andThen(() => {
            const input =
              `Please provide a brief status summary of the HVAC system.

Steps:
1. Get current temperatures
2. Get HVAC status
3. Provide a concise summary (2-3 sentences) covering:
   - Current system state
   - Temperature conditions
   - Any immediate recommendations

Keep the summary brief and informative.`;

            return Effect.tryPromise({
              try: () =>
                state.agent!.invoke({
                  input,
                  chat_history: state.conversationHistory.slice(-6), // Limited history for status
                }),
              catch: (error) => error,
            });
          }),
          Effect.map((result) => ({
            success: true,
            aiSummary: result.output,
            recommendations: this.extractRecommendations(result.output),
          })),
          Effect.catchAll((error) =>
            pipe(
              this.logger.error('AI status summary failed', error),
              Effect.andThen(Effect.succeed({
                success: false,
                error: error instanceof Error ? error.message : String(error),
              })),
            )
          ),
        );
      }),
    );

  /**
   * Clear conversation history
   */
  clearHistory = (): Effect.Effect<void, never> =>
    pipe(
      this.stateRef,
      Ref.update((state) => ({ ...state, conversationHistory: [] })),
      Effect.andThen(this.logger.debug('AI conversation history cleared')),
    );

  /**
   * Get conversation history length
   */
  getHistoryLength = (): Effect.Effect<number, never> =>
    pipe(
      this.stateRef,
      Ref.get,
      Effect.map((state) => state.conversationHistory.length),
    );

  /**
   * Update conversation history
   */
  private updateConversationHistory = (
    input: string,
    output: string,
  ): Effect.Effect<void, never> =>
    pipe(
      this.stateRef,
      Ref.update((state) => {
        const newHistory = [
          ...state.conversationHistory,
          new HumanMessage(input),
          new AIMessage(output),
        ];

        // Keep conversation history manageable
        const managedHistory = newHistory.length > 20
          ? newHistory.slice(-20)
          : newHistory;

        return { ...state, conversationHistory: managedHistory };
      }),
    );

  /**
   * Extract recommendations from AI output
   */
  private extractRecommendations = (text: string): string[] => {
    const recommendations: string[] = [];

    // Look for bullet points or numbered lists
    const bulletRegex = /(?:^|\n)[•\-\*]\s*(.+)/g;
    const numberedRegex = /(?:^|\n)\d+\.\s*(.+)/g;

    let match;
    while ((match = bulletRegex.exec(text)) !== null) {
      recommendations.push(match[1].trim());
    }

    while ((match = numberedRegex.exec(text)) !== null) {
      recommendations.push(match[1].trim());
    }

    // If no structured recommendations found, look for sentences with recommendation keywords
    if (recommendations.length === 0) {
      const sentences = text.split(/[.!?]\s+/);
      for (const sentence of sentences) {
        if (
          /\b(recommend|suggest|should|consider|optimize|improve)\b/i.test(
            sentence,
          )
        ) {
          recommendations.push(sentence.trim());
        }
      }
    }

    return recommendations.slice(0, 5); // Limit to 5 recommendations
  };
}

/**
 * Layer for providing HVAC Agent service
 */
export const HVACAgentLive = Layer.effect(
  HVACAgent,
  Effect.gen(function* () {
    const hvacOptions = yield* HvacOptionsService;
    const appOptions = yield* ApplicationOptionsService;
    const stateMachine = yield* HVACStateMachine;
    const haClient = yield* HomeAssistantClient;
    const logger = yield* LoggerService;

    const initialState: AgentState = {
      tools: [],
      conversationHistory: [],
    };

    const stateRef = yield* Ref.make(initialState);

    const impl = new HVACAgentImpl(
      hvacOptions,
      appOptions,
      stateMachine,
      haClient,
      logger,
      stateRef,
    );

    // Initialize the agent
    yield* impl.initializeAgent();

    return HVACAgent.of({
      processTemperatureChange: impl.processTemperatureChange,
      manualOverride: impl.manualOverride,
      evaluateEfficiency: impl.evaluateEfficiency,
      getStatusSummary: impl.getStatusSummary,
      clearHistory: impl.clearHistory,
      getHistoryLength: impl.getHistoryLength,
    });
  }),
);
