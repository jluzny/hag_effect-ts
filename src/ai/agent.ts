/**
 * AI Agent for HAG Effect-TS variant.
 * 
 * Effect-native LangChain integration for intelligent HVAC decision making.
 */

import { Effect, Context, Layer, pipe, Ref } from 'effect';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { Tool } from '@langchain/core/tools';
import { AgentExecutor, createToolCallingAgent } from 'langchain/agents';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { HvacOptions, ApplicationOptions } from '../config/settings.ts';
import { HVACStateMachine } from '../hvac/state-machine.ts';
import { HomeAssistantClient } from '../home-assistant/client.ts';
import { HVACMode, OperationResult } from '../types/common.ts';
import { AIError, StateError, ErrorUtils } from '../core/exceptions.ts';
import { LoggerService } from '../core/container.ts';

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
    readonly processTemperatureChange: (event: TemperatureChangeEvent) => Effect.Effect<OperationResult, AIError>;
    readonly manualOverride: (action: string, options?: Record<string, unknown>) => Effect.Effect<OperationResult, AIError>;
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
  description = 'Control HVAC system (heat, cool, off) with optional target temperature';

  constructor(
    private stateMachine: HVACStateMachine,
    private logger: LoggerService,
  ) {
    super();
  }

  async _call(input: string): Promise<string> {
    try {
      const { action, temperature } = JSON.parse(input);
      
      // Parse HVAC mode
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
          return `Error: Invalid action '${action}'. Use 'heat', 'cool', or 'off'.`;
      }

      // Execute through Effect - simplified for tool context
      const result = await Effect.runPromise(
        pipe(
          this.executeManualOverride(mode, temperature),
          Effect.andThen(() =>
            this.logger.debug('AI agent executed HVAC control', { action, temperature })
          ),
          Effect.catchAll((error) =>
            pipe(
              this.logger.error('AI HVAC control failed', error),
              Effect.andThen(Effect.fail(error))
            )
          )
        )
      );
      
      return `Successfully set HVAC to ${action}${temperature ? ` at ${temperature}°C` : ''}`;
      
    } catch (error) {
      const errorMsg = `Failed to control HVAC: ${error instanceof Error ? error.message : String(error)}`;
      return errorMsg;
    }
  }

  private executeManualOverride = (mode: HVACMode, temperature?: number): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      // Placeholder for state machine manual override
      // In practice, this would call the actual state machine method
      yield* Effect.void;
    });
}

/**
 * Effect-native temperature reading tool
 */
class EffectTemperatureReadingTool extends Tool {
  name = 'get_temperature';
  description = 'Get current indoor and outdoor temperature readings';

  constructor(
    private haClient: HomeAssistantClient,
    private hvacOptions: HvacOptions,
    private logger: LoggerService,
  ) {
    super();
  }

  async _call(_input: string): Promise<string> {
    try {
      const result = await Effect.runPromise(
        pipe(
          Effect.all({
            indoorState: this.haClient.getState(this.hvacOptions.tempSensor),
            outdoorState: this.haClient.getState(this.hvacOptions.outdoorSensor)
              .pipe(Effect.catchAll(() => Effect.succeed(null))),
          }),
          Effect.map(({ indoorState, outdoorState }) => {
            const indoorTemp = indoorState.getNumericState();
            const outdoorTemp = outdoorState?.getNumericState() ?? null;

            return {
              indoor: indoorTemp,
              outdoor: outdoorTemp,
              timestamp: new Date().toISOString(),
            };
          }),
          Effect.tap((temperatures) =>
            this.logger.debug('AI agent read temperatures', temperatures)
          )
        )
      );
      
      return JSON.stringify(result);

    } catch (error) {
      const errorMsg = `Failed to read temperatures: ${error instanceof Error ? error.message : String(error)}`;
      return errorMsg;
    }
  }
}

/**
 * Effect-native HVAC status tool
 */
class EffectHVACStatusTool extends Tool {
  name = 'get_hvac_status';
  description = 'Get current HVAC system status and state machine information';

  constructor(
    private stateMachine: HVACStateMachine,
    private logger: LoggerService,
  ) {
    super();
  }

  async _call(_input: string): Promise<string> {
    try {
      const result = await Effect.runPromise(
        pipe(
          this.getStateMachineStatus(),
          Effect.map((status) => ({
            currentState: status.currentState,
            context: status.context,
            timestamp: new Date().toISOString(),
          })),
          Effect.tap((status) =>
            this.logger.debug('AI agent read HVAC status', status)
          )
        )
      );
      
      return JSON.stringify(result);

    } catch (error) {
      const errorMsg = `Failed to get HVAC status: ${error instanceof Error ? error.message : String(error)}`;
      return errorMsg;
    }
  }

  private getStateMachineStatus = (): Effect.Effect<any, never> =>
    Effect.succeed({ currentState: 'idle', context: {} }); // Placeholder
}

/**
 * HVAC Agent implementation
 */
class HVACAgentImpl {
  constructor(
    private hvacOptions: HvacOptions,
    private appOptions: ApplicationOptions,
    private stateMachine: HVACStateMachine,
    private haClient: HomeAssistantClient,
    private logger: LoggerService,
    private stateRef: Ref.Ref<AgentState>,
  ) {}

  /**
   * Initialize the LangChain agent
   */
  initializeAgent = (): Effect.Effect<void, AIError> =>
    pipe(
      Effect.gen(function* () {
        // Initialize OpenAI LLM
        const llm = new ChatOpenAI({
          modelName: 'gpt-4o-mini',
          temperature: 0.1,
          openAIApiKey: this.appOptions.openaiApiKey,
        });

        // Initialize tools
        const tools = [
          new EffectHVACControlTool(this.stateMachine, this.logger),
          new EffectTemperatureReadingTool(this.haClient, this.hvacOptions, this.logger),
          new EffectHVACStatusTool(this.stateMachine, this.logger),
        ];

        const systemPrompt = `You are an intelligent HVAC automation agent for a home automation system.

Your role is to:
1. Monitor temperature changes and make intelligent heating/cooling decisions
2. Analyze HVAC system efficiency and provide recommendations
3. Handle manual override requests with validation
4. Provide status summaries and insights

Current HVAC Configuration:
- System Mode: ${this.hvacOptions.systemMode}
- Temperature Sensor: ${this.hvacOptions.tempSensor}
- Outdoor Sensor: ${this.hvacOptions.outdoorSensor}
- Heating Target: ${this.hvacOptions.heating.temperature}°C
- Cooling Target: ${this.hvacOptions.cooling.temperature}°C
- Heating Range: ${this.hvacOptions.heating.temperatureThresholds.indoorMin}°C - ${this.hvacOptions.heating.temperatureThresholds.indoorMax}°C
- Cooling Range: ${this.hvacOptions.cooling.temperatureThresholds.indoorMin}°C - ${this.hvacOptions.cooling.temperatureThresholds.indoorMax}°C

Available Tools:
1. hvac_control - Control HVAC system (heat/cool/off)
2. get_temperature - Read current temperatures
3. get_hvac_status - Get system status

Always consider:
- Energy efficiency
- Comfort optimization
- Outdoor weather conditions
- Time of day and usage patterns
- System constraints and thresholds

Respond concisely and provide actionable insights.`;

        const prompt = ChatPromptTemplate.fromMessages([
          ['system', systemPrompt],
          ['placeholder', '{chat_history}'],
          ['human', '{input}'],
          ['placeholder', '{agent_scratchpad}'],
        ]);

        const agent = yield* Effect.tryPromise({
          try: () => createToolCallingAgent({
            llm,
            tools,
            prompt,
          }),
          catch: (error) => ErrorUtils.aiError(`Failed to create agent: ${error}`),
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

        yield* this.logger.info('AI agent initialized successfully');

      }).bind(this)(),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('Failed to initialize AI agent', error),
          Effect.andThen(Effect.fail(error))
        )
      )
    );

  /**
   * Process temperature change events
   */
  processTemperatureChange = (event: TemperatureChangeEvent): Effect.Effect<OperationResult, AIError> =>
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
            const input = `Temperature sensor ${event.entityId} changed from ${event.oldState || 'unknown'} to ${event.newState} at ${event.timestamp}. 

Please analyze this change and determine if any HVAC action is needed. Consider:
1. Current system status and mode
2. Temperature thresholds and targets
3. Outdoor conditions
4. Energy efficiency

If action is needed, execute the appropriate HVAC control.`;

            return Effect.tryPromise({
              try: () => state.agent!.invoke({
                input,
                chat_history: state.conversationHistory,
              }),
              catch: (error) => ErrorUtils.aiError(`Temperature processing failed: ${error}`),
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
              }))
            )
          ),
          Effect.tap(() =>
            this.logger.info('AI temperature change processing completed')
          )
        );
      }),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('AI temperature change processing failed', error),
          Effect.andThen(Effect.succeed({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
          }))
        )
      )
    );

  /**
   * Handle manual override requests
   */
  manualOverride = (action: string, options: Record<string, unknown> = {}): Effect.Effect<OperationResult, AIError> =>
    pipe(
      this.stateRef,
      Ref.get,
      Effect.flatMap((state) => {
        if (!state.agent) {
          return Effect.fail(ErrorUtils.aiError('AI agent not initialized'));
        }

        return pipe(
          this.logger.info('AI processing manual override', { action, options }),
          Effect.andThen(() => {
            const input = `User requested manual HVAC override: action="${action}"${options.temperature ? `, temperature=${options.temperature}°C` : ''}.

Please:
1. Validate this request against current conditions and thresholds
2. Check if this action makes sense given current indoor/outdoor temperatures
3. Execute the HVAC control if appropriate
4. Provide feedback on the action and any recommendations

Use the hvac_control tool to execute the override: {"action": "${action}"${options.temperature ? `, "temperature": ${options.temperature}` : ''}}.`;

            return Effect.tryPromise({
              try: () => state.agent!.invoke({
                input,
                chat_history: state.conversationHistory,
              }),
              catch: (error) => ErrorUtils.aiError(`Manual override failed: ${error}`),
            });
          }),
          Effect.flatMap((result) =>
            pipe(
              this.updateConversationHistory(`manual_override_${action}`, result.output),
              Effect.map(() => ({
                success: true,
                data: {
                  aiResponse: result.output,
                  action,
                  options,
                },
                timestamp: new Date().toISOString(),
              }))
            )
          ),
          Effect.tap(() =>
            this.logger.info('AI manual override completed', { action })
          )
        );
      })
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
            const input = `Please analyze the current HVAC system efficiency and performance.

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
              try: () => state.agent!.invoke({
                input,
                chat_history: state.conversationHistory,
              }),
              catch: (error) => ErrorUtils.aiError(`Efficiency evaluation failed: ${error}`),
            });
          }),
          Effect.flatMap((result) =>
            pipe(
              this.updateConversationHistory('efficiency_evaluation', result.output),
              Effect.map(() => ({
                success: true,
                data: {
                  analysis: result.output,
                  recommendations: this.extractRecommendations(result.output),
                },
                timestamp: new Date().toISOString(),
              }))
            )
          ),
          Effect.tap(() =>
            this.logger.info('AI efficiency evaluation completed')
          )
        );
      })
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
            const input = `Please provide a brief status summary of the HVAC system.

Steps:
1. Get current temperatures
2. Get HVAC status
3. Provide a concise summary (2-3 sentences) covering:
   - Current system state
   - Temperature conditions
   - Any immediate recommendations

Keep the summary brief and informative.`;

            return Effect.tryPromise({
              try: () => state.agent!.invoke({
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
              }))
            )
          )
        );
      })
    );

  /**
   * Clear conversation history
   */
  clearHistory = (): Effect.Effect<void, never> =>
    pipe(
      this.stateRef,
      Ref.update((state) => ({ ...state, conversationHistory: [] })),
      Effect.andThen(this.logger.debug('AI conversation history cleared'))
    );

  /**
   * Get conversation history length
   */
  getHistoryLength = (): Effect.Effect<number, never> =>
    pipe(
      this.stateRef,
      Ref.get,
      Effect.map((state) => state.conversationHistory.length)
    );

  /**
   * Update conversation history
   */
  private updateConversationHistory = (inputKey: string, output: string): Effect.Effect<void, never> =>
    pipe(
      this.stateRef,
      Ref.update((state) => {
        const newHistory = [
          ...state.conversationHistory,
          new HumanMessage(`${inputKey}: processing`),
          new AIMessage(output),
        ];

        // Keep conversation history manageable
        const managedHistory = newHistory.length > 20 ? newHistory.slice(-20) : newHistory;

        return { ...state, conversationHistory: managedHistory };
      })
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
        if (/\b(recommend|suggest|should|consider|optimize|improve)\b/i.test(sentence)) {
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
    const hvacOptions = yield* Context.Tag<HvacOptions>('HvacOptions');
    const appOptions = yield* Context.Tag<ApplicationOptions>('ApplicationOptions');
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
      stateRef
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
  })
);