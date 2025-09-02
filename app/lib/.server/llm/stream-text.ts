import { convertToCoreMessages, streamText as _streamText, type Message } from 'ai';
import { MAX_TOKENS_FALLBACK, PROVIDER_COMPLETION_LIMITS, isReasoningModel, type FileMap } from './constants';
import { ModelCapabilityService } from './model-capability-service';
import { getCodingPrompt } from '~/lib/common/prompts/coding-prompt';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, MODIFICATIONS_TAG_NAME, PROVIDER_LIST, WORK_DIR } from '~/utils/constants';
import type { IProviderSetting } from '~/types/model';
import { PromptLibrary } from '~/lib/common/prompt-library';
import { allowedHTMLElements } from '~/utils/markdown';
import { LLMManager } from '~/lib/modules/llm/manager';
import { createScopedLogger } from '~/utils/logger';
import { createFilesContext, extractPropertiesFromMessage } from './utils';
import { getPlanningPrompt } from '~/lib/common/prompts/planning-prompt';
import type { DesignScheme } from '~/types/design-scheme';

export type Messages = Message[];

export interface StreamingOptions extends Omit<Parameters<typeof _streamText>[0], 'model'> {
  supabaseConnection?: {
    isConnected: boolean;
    hasSelectedProject: boolean;
    credentials?: {
      anonKey?: string;
      supabaseUrl?: string;
    };
  };
}

const logger = createScopedLogger('stream-text');

async function getCompletionTokenLimit(
  modelDetails: any,
  options: {
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
    serverEnv?: Record<string, string>;
  },
): Promise<number> {
  try {
    // Use ModelCapabilityService for dynamic, accurate limits
    const capabilityService = ModelCapabilityService.getInstance();
    const limits = await capabilityService.getSafeTokenLimits(modelDetails, options);

    return limits.maxCompletionTokens;
  } catch (error) {
    logger.warn(`Failed to get dynamic token limits for ${modelDetails.name}, using fallback:`, error);

    // Fallback to legacy logic with conservative limits
    if (modelDetails.maxCompletionTokens && modelDetails.maxCompletionTokens > 0) {
      return modelDetails.maxCompletionTokens;
    }

    const providerDefault = PROVIDER_COMPLETION_LIMITS[modelDetails.provider];

    if (providerDefault) {
      return providerDefault;
    }

    return Math.min(MAX_TOKENS_FALLBACK, 8192); // Very conservative fallback
  }
}

function sanitizeText(text: string): string {
  let sanitized = text.replace(/<div class=\\"__boltThought__\\">.*?<\/div>/s, '');
  sanitized = sanitized.replace(/<think>.*?<\/think>/s, '');
  sanitized = sanitized.replace(/<boltAction type="file" filePath="package-lock\.json">[\s\S]*?<\/boltAction>/g, '');

  return sanitized.trim();
}

export async function streamText(props: {
  messages: Omit<Message, 'id'>[];
  env?: Env;
  options?: StreamingOptions;
  apiKeys?: Record<string, string>;
  files?: FileMap;
  providerSettings?: Record<string, IProviderSetting>;
  promptId?: string;
  contextOptimization?: boolean;
  contextFiles?: FileMap;
  summary?: string;
  messageSliceId?: number;
  chatMode?: 'discuss' | 'build';
  designScheme?: DesignScheme;
}) {
  const {
    messages,
    env: serverEnv,
    options,
    apiKeys,
    files,
    providerSettings,
    promptId,
    contextOptimization,
    contextFiles,
    summary,
    chatMode,
    designScheme,
  } = props;
  let currentModel = DEFAULT_MODEL;
  let currentProvider = DEFAULT_PROVIDER.name;
  let processedMessages = messages.map((message) => {
    const newMessage = { ...message };

    if (message.role === 'user') {
      const { model, provider, content } = extractPropertiesFromMessage(message);
      currentModel = model;
      currentProvider = provider;
      newMessage.content = sanitizeText(content);
    } else if (message.role == 'assistant') {
      newMessage.content = sanitizeText(message.content);
    }

    // Sanitize all text parts in parts array, if present
    if (Array.isArray(message.parts)) {
      newMessage.parts = message.parts.map((part) =>
        part.type === 'text' ? { ...part, text: sanitizeText(part.text) } : part,
      );
    }

    return newMessage;
  });

  const provider = PROVIDER_LIST.find((p) => p.name === currentProvider) || DEFAULT_PROVIDER;
  const staticModels = LLMManager.getInstance().getStaticModelListFromProvider(provider);
  let modelDetails = staticModels.find((m) => m.name === currentModel);

  if (!modelDetails) {
    const modelsList = [
      ...(provider.staticModels || []),
      ...(await LLMManager.getInstance().getModelListFromProvider(provider, {
        apiKeys,
        providerSettings,
        serverEnv: serverEnv as any,
      })),
    ];

    if (!modelsList.length) {
      throw new Error(`No models found for provider ${provider.name}`);
    }

    modelDetails = modelsList.find((m) => m.name === currentModel);

    if (!modelDetails) {
      // Check if it's a Google provider and the model name looks like it might be incorrect
      if (provider.name === 'Google' && currentModel.includes('2.5')) {
        throw new Error(
          `Model "${currentModel}" not found. Gemini 2.5 Pro doesn't exist. Available Gemini models include: gemini-1.5-pro, gemini-2.0-flash, gemini-1.5-flash. Please select a valid model.`,
        );
      }

      // Fallback to first model with warning
      logger.warn(
        `MODEL [${currentModel}] not found in provider [${provider.name}]. Falling back to first model. ${modelsList[0].name}`,
      );
      modelDetails = modelsList[0];
    }
  }

  const dynamicMaxTokens = modelDetails
    ? await getCompletionTokenLimit(modelDetails, { apiKeys, providerSettings, serverEnv: serverEnv as any })
    : Math.min(MAX_TOKENS_FALLBACK, 8192);

  // Use model-specific limits directly - no artificial cap needed
  const safeMaxTokens = dynamicMaxTokens;

  logger.info(
    `Token limits for model ${modelDetails.name}: maxTokens=${safeMaxTokens}, maxTokenAllowed=${modelDetails.maxTokenAllowed}, maxCompletionTokens=${modelDetails.maxCompletionTokens}`,
  );

  let systemPrompt =
    PromptLibrary.getPropmtFromLibrary(promptId || 'coding', {
      cwd: WORK_DIR,
      allowedHtmlElements: allowedHTMLElements,
      modificationTagName: MODIFICATIONS_TAG_NAME,
      designScheme,
      supabase: {
        isConnected: options?.supabaseConnection?.isConnected || false,
        hasSelectedProject: options?.supabaseConnection?.hasSelectedProject || false,
        credentials: options?.supabaseConnection?.credentials || undefined,
      },
    }) ?? getCodingPrompt();

  if (chatMode === 'build' && contextFiles && contextOptimization) {
    const codeContext = createFilesContext(contextFiles, true);

    systemPrompt = `${systemPrompt}

    Below is the artifact containing the context loaded into context buffer for you to have knowledge of and might need changes to fullfill current user request.
    CONTEXT BUFFER:
    ---
    ${codeContext}
    ---
    `;

    if (summary) {
      systemPrompt = `${systemPrompt}
      below is the chat history till now
      CHAT SUMMARY:
      ---
      ${props.summary}
      ---
      `;

      if (props.messageSliceId) {
        processedMessages = processedMessages.slice(props.messageSliceId);
      } else {
        const lastMessage = processedMessages.pop();

        if (lastMessage) {
          processedMessages = [lastMessage];
        }
      }
    }
  }

  const effectiveLockedFilePaths = new Set<string>();

  if (files) {
    for (const [filePath, fileDetails] of Object.entries(files)) {
      if (fileDetails?.isLocked) {
        effectiveLockedFilePaths.add(filePath);
      }
    }
  }

  if (effectiveLockedFilePaths.size > 0) {
    const lockedFilesListString = Array.from(effectiveLockedFilePaths)
      .map((filePath) => `- ${filePath}`)
      .join('\n');
    systemPrompt = `${systemPrompt}

    IMPORTANT: The following files are locked and MUST NOT be modified in any way. Do not suggest or make any changes to these files. You can proceed with the request but DO NOT make any changes to these files specifically:
    ${lockedFilesListString}
    ---
    `;
  } else {
    console.log('No locked files found from any source for prompt.');
  }

  logger.info(`Sending llm call to ${provider.name} with model ${modelDetails.name}`);

  // Log reasoning model detection and token parameters
  const isReasoning = isReasoningModel(modelDetails.name);
  logger.info(
    `Model "${modelDetails.name}" is reasoning model: ${isReasoning}, using ${isReasoning ? 'maxCompletionTokens' : 'maxTokens'}: ${safeMaxTokens}`,
  );

  // Validate token limits before API call
  if (safeMaxTokens > (modelDetails.maxTokenAllowed || 128000)) {
    logger.warn(
      `Token limit warning: requesting ${safeMaxTokens} tokens but model supports max ${modelDetails.maxTokenAllowed || 128000}`,
    );
  }

  // Use maxCompletionTokens for reasoning models (o1, GPT-5), maxTokens for traditional models
  const tokenParams = isReasoning ? { maxCompletionTokens: safeMaxTokens } : { maxTokens: safeMaxTokens };

  // Filter out unsupported parameters for reasoning models
  const filteredOptions =
    isReasoning && options
      ? Object.fromEntries(
          Object.entries(options).filter(
            ([key]) =>
              ![
                'temperature',
                'topP',
                'presencePenalty',
                'frequencyPenalty',
                'logprobs',
                'topLogprobs',
                'logitBias',
              ].includes(key),
          ),
        )
      : options || {};

  // DEBUG: Log filtered options
  logger.info(
    `DEBUG STREAM: Options filtering for model "${modelDetails.name}":`,
    JSON.stringify(
      {
        isReasoning,
        originalOptions: options || {},
        filteredOptions,
        originalOptionsKeys: options ? Object.keys(options) : [],
        filteredOptionsKeys: Object.keys(filteredOptions),
        removedParams: options ? Object.keys(options).filter((key) => !(key in filteredOptions)) : [],
      },
      null,
      2,
    ),
  );

  // Debug logging for system prompt selection
  const selectedPromptType = chatMode === 'build' ? 'systemPrompt (BUILD MODE)' : 'getPlanningPrompt (DISCUSS MODE)';
  logger.info(`ChatMode: "${chatMode}", Selected prompt: ${selectedPromptType}`);

  // Special handling for Kimi models - use simple system prompt
  const isKimiModel =
    modelDetails.name.toLowerCase().includes('kimi') ||
    (provider.name === 'Moonshot' && modelDetails.name.toLowerCase().includes('kimi'));

  // Special handling for Grok Code models - optimized for agentic coding
  const isGrokCodeModel = modelDetails.name.toLowerCase().includes('grok-code-fast');

  let finalSystemPrompt;

  if (isGrokCodeModel) {
    // Create Grok Code optimized prompt following xAI best practices
    finalSystemPrompt = `You are an expert software developer assistant powered by Grok Code Fast 1, specifically optimized for agentic coding tasks and iterative development workflows.

<system_constraints>
  You operate in WebContainer, an in-browser Node.js runtime:
  - Current working directory: ${WORK_DIR}
  - You have full access to create, read, modify, and execute files
  - You can run shell commands and manage project dependencies
  - Focus on delivering working, production-ready code solutions
</system_constraints>

<grok_coding_guidelines>
  CORE PRINCIPLES:
  - Embrace rapid iteration: Take advantage of fast execution for quick refinements
  - Focus on agentic tasks: Navigate large codebases with precision using tools
  - Provide rich context: Use detailed explanations and comprehensive code examples
  - Be thorough and specific: Include edge cases, error handling, and best practices
  - Leverage native tool calling: Use structured actions for optimal performance

  TASK APPROACH:
  1. Analyze the full project structure and dependencies
  2. Identify specific files and components that need modification
  3. Provide complete, working implementations with proper error handling
  4. Include relevant imports, exports, and integration points
  5. Consider performance, scalability, and maintainability
  6. Test assumptions and validate solutions incrementally

  SPECIALIZED LANGUAGES (prioritized expertise):
  - TypeScript: Advanced patterns, type safety, modern features
  - Python: Full-stack development, async/await, modern frameworks
  - Java: Enterprise patterns, Spring ecosystem, concurrency
  - Rust: Memory safety, performance optimization, async programming
  - C++: Modern C++ features, RAII, template metaprogramming
  - Go: Concurrency patterns, microservices, high-performance applications
</grok_coding_guidelines>

<artifacts>
  CRITICAL: For file operations and commands, use boltArtifact and boltAction format:
  
  Structure: <boltArtifact id="unique-id" title="Description"><boltAction type="action-type">content</boltAction></boltArtifact>
  
  Action Types:
  - file: Creating/updating files (add filePath attribute)
  - shell: Running commands  
  - start: Starting project (use ONLY for project startup, LAST action)

  Example for comprehensive file creation:
  <boltArtifact id="create-feature" title="Create Feature Module">
  <boltAction type="file" filePath="src/features/UserAuth.tsx">
  import React, { useState, useCallback, useEffect } from 'react';
  import type { User, AuthState } from './types';

  interface UserAuthProps {
    onAuthChange: (user: User | null) => void;
    initialState?: AuthState;
  }

  export function UserAuth({ onAuthChange, initialState }: UserAuthProps) {
    const [authState, setAuthState] = useState<AuthState>(initialState ?? 'idle');
    const [user, setUser] = useState<User | null>(null);

    const handleAuth = useCallback(async (credentials: LoginCredentials) => {
      try {
        setAuthState('loading');
        const authenticatedUser = await authenticate(credentials);
        setUser(authenticatedUser);
        setAuthState('authenticated');
        onAuthChange(authenticatedUser);
      } catch (error) {
        setAuthState('error');
        console.error('Authentication failed:', error);
        onAuthChange(null);
      }
    }, [onAuthChange]);

    return (
      // Implementation with comprehensive error handling
    );
  }
  </boltAction>
  </boltArtifact>
</artifacts>

OPTIMIZATION FOCUS: Leverage Grok Code Fast 1's strengths in rapid iteration, comprehensive context understanding, and agentic task execution. Provide detailed, working solutions that can be immediately implemented and tested.`;

    logger.info(`Using Grok Code optimized prompt for model: ${modelDetails.name}`);
  } else if (isKimiModel) {
    // Create Kimi-compatible coding prompt with essential file writing capabilities
    finalSystemPrompt = `You are Kimi, an AI assistant created by Moonshot AI, helping users with coding and development tasks.

<system_constraints>
  You operate in WebContainer, an in-browser Node.js runtime:
  - Current working directory: ${WORK_DIR}
  - You can create, read, and modify files
  - You can run shell commands
</system_constraints>

<artifacts>
  IMPORTANT: To create or modify files, you MUST use boltArtifact and boltAction format:
  
  Structure: <boltArtifact id="unique-id" title="Description"><boltAction type="action-type">content</boltAction></boltArtifact>
  
  Action Types:
  - file: Creating/updating files (add filePath attribute)
  - shell: Running commands  
  - start: Starting project (use ONLY for project startup, LAST action)

  Example for creating a file:
  <boltArtifact id="create-component" title="Create React Component">
  <boltAction type="file" filePath="src/Component.jsx">
  import React from 'react';

  function Component() {
    return <div>Hello World</div>;
  }

  export default Component;
  </boltAction>
  </boltArtifact>
  
  Example for running commands:
  <boltArtifact id="install-deps" title="Install Dependencies">
  <boltAction type="shell">
  npm install react
  </boltAction>
  </boltArtifact>
</artifacts>

CRITICAL: Always use boltAction for file operations and commands. Never just provide code without the proper boltAction wrapper.`;

    logger.info(`Using Kimi-compatible coding prompt for model: ${modelDetails.name}`);
  } else {
    finalSystemPrompt = chatMode === 'build' ? systemPrompt : getPlanningPrompt();
  }

  const streamParams = {
    model: provider.getModelInstance({
      model: modelDetails.name,
      serverEnv,
      apiKeys,
      providerSettings,
    }),
    system: finalSystemPrompt,
    ...tokenParams,
    messages: convertToCoreMessages(processedMessages as any),
    ...filteredOptions,

    // Set temperature to 1 for reasoning models (required by OpenAI API)
    ...(isReasoning ? { temperature: 1 } : {}),
  };

  // DEBUG: Log final streaming parameters
  logger.info(
    `DEBUG STREAM: Final streaming params for model "${modelDetails.name}":`,
    JSON.stringify(
      {
        hasTemperature: 'temperature' in streamParams,
        hasMaxTokens: 'maxTokens' in streamParams,
        hasMaxCompletionTokens: 'maxCompletionTokens' in streamParams,
        paramKeys: Object.keys(streamParams).filter((key) => !['model', 'messages', 'system'].includes(key)),
        streamParams: Object.fromEntries(
          Object.entries(streamParams).filter(([key]) => !['model', 'messages', 'system'].includes(key)),
        ),
      },
      null,
      2,
    ),
  );

  return await _streamText(streamParams);
}
