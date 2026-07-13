import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

@Injectable()
export class AnthropicClientService {
  private readonly client: Anthropic;

  constructor(private readonly config: ConfigService) {
    this.client = new Anthropic({
      apiKey: this.config.get<string>('ANTHROPIC_API_KEY'),
    });
  }

  /**
   * Pede resposta estruturada (JSON) forçando o formato via prompt +
   * validação. Usa tool_use, que é mais confiável que pedir "responda em
   * JSON" em texto livre.
   */
  async structuredCompletion<T>(params: {
    system: string;
    prompt: string;
    toolName: string;
    toolDescription: string;
    inputSchema: Record<string, unknown>;
  }): Promise<{ result: T; tokensUsed: number; durationMs: number }> {
    const start = Date.now();

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: params.system,
      messages: [{ role: 'user', content: params.prompt }],
      tools: [
        {
          name: params.toolName,
          description: params.toolDescription,
          input_schema: params.inputSchema as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: 'tool', name: params.toolName },
    });

    const toolUse = response.content.find((c) => c.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new Error('Agente não retornou resultado estruturado');
    }

    return {
      result: toolUse.input as T,
      tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
      durationMs: Date.now() - start,
    };
  }
}
