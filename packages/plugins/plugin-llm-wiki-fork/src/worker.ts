/**
 * Plugin-LLM-Wiki-Fork Worker
 * Integrates GraphMemoryEngine with Paperclip's plugin worker interface
 */

import { GraphMemoryEngine, getGraphEngine, closeGraphEngine, Entity, Wikilink, GraphQueryResult } from './graph-engine.js';

export interface PluginContext {
  companyId: string;
  agentId: string;
  dataDir: string;
}

export interface PluginToolCall {
  name: string;
  arguments: Record<string, unknown>;
  id: string;
}

export interface PluginToolResult {
  toolCallId: string;
  content: unknown;
  isError?: boolean;
}

class PluginWorker {
  private engine: GraphMemoryEngine | null = null;
  private context: PluginContext | null = null;

  async initialize(context: PluginContext): Promise<void> {
    this.context = context;
    this.engine = getGraphEngine(context.dataDir, context.companyId);
  }

  async executeTool(toolCall: PluginToolCall): Promise<PluginToolResult> {
    if (!this.engine) {
      return {
        toolCallId: toolCall.id,
        content: { error: 'Engine not initialized' },
        isError: true
      };
    }

    try {
      switch (toolCall.name) {
        case 'entity_upsert':
          return this.handleEntityUpsert(toolCall);
        case 'entity_get':
          return this.handleEntityGet(toolCall);
        case 'entity_search':
          return this.handleEntitySearch(toolCall);
        case 'entity_list':
          return this.handleEntityList(toolCall);
        case 'entity_delete':
          return this.handleEntityDelete(toolCall);
        case 'wikilink_upsert':
          return this.handleWikilinkUpsert(toolCall);
        case 'wikilink_get':
          return this.handleWikilinkGet(toolCall);
        case 'graph_neighborhood':
          return this.handleGraphNeighborhood(toolCall);
        case 'graph_find_paths':
          return this.handleGraphFindPaths(toolCall);
        default:
          return {
            toolCallId: toolCall.id,
            content: { error: `Unknown tool: ${toolCall.name}` },
            isError: true
          };
      }
    } catch (error) {
      return {
        toolCallId: toolCall.id,
        content: { error: error instanceof Error ? error.message : String(error) },
        isError: true
      };
    }
  }

  private handleEntityUpsert(toolCall: PluginToolCall): PluginToolResult {
    const entity = this.engine!.upsertEntity({
      id: toolCall.arguments.id as string,
      name: toolCall.arguments.name as string,
      type: toolCall.arguments.type as string,
      properties: (toolCall.arguments.properties as Record<string, unknown>) || {},
      createdAt: toolCall.arguments.createdAt as number,
      updatedAt: toolCall.arguments.updatedAt as number
    });
    return { toolCallId: toolCall.id, content: entity };
  }

  private handleEntityGet(toolCall: PluginToolCall): PluginToolResult {
    const id = toolCall.arguments.id as string;
    const name = toolCall.arguments.name as string;
    let entity: Entity | null = null;
    
    if (id) {
      entity = this.engine!.getEntity(id);
    } else if (name) {
      entity = this.engine!.getEntityByName(name);
    }
    
    return { toolCallId: toolCall.id, content: entity };
  }

  private handleEntitySearch(toolCall: PluginToolCall): PluginToolResult {
    const query = toolCall.arguments.query as string;
    const limit = (toolCall.arguments.limit as number) || 20;
    const entities = this.engine!.searchEntities(query, limit);
    return { toolCallId: toolCall.id, content: { entities } };
  }

  private handleEntityList(toolCall: PluginToolCall): PluginToolResult {
    const limit = (toolCall.arguments.limit as number) || 100;
    const offset = (toolCall.arguments.offset as number) || 0;
    const entities = this.engine!.getAllEntities(limit, offset);
    return { toolCallId: toolCall.id, content: { entities } };
  }

  private handleEntityDelete(toolCall: PluginToolCall): PluginToolResult {
    const id = toolCall.arguments.id as string;
    const deleted = this.engine!.deleteEntity(id);
    return { toolCallId: toolCall.id, content: { deleted } };
  }

  private handleWikilinkUpsert(toolCall: PluginToolCall): PluginToolResult {
    const wikilink = this.engine!.upsertWikilink({
      id: toolCall.arguments.id as string,
      sourceEntityId: toolCall.arguments.sourceEntityId as string,
      targetEntityId: toolCall.arguments.targetEntityId as string,
      linkType: toolCall.arguments.linkType as Wikilink['linkType'],
      context: (toolCall.arguments.context as string) || '',
      createdAt: toolCall.arguments.createdAt as number
    });
    return { toolCallId: toolCall.id, content: wikilink };
  }

  private handleWikilinkGet(toolCall: PluginToolCall): PluginToolResult {
    const entityId = toolCall.arguments.entityId as string;
    const links = this.engine!.getWikilinksForEntity(entityId);
    return { toolCallId: toolCall.id, content: { links } };
  }

  private handleGraphNeighborhood(toolCall: PluginToolCall): PluginToolResult {
    const entityId = toolCall.arguments.entityId as string;
    const maxDepth = (toolCall.arguments.maxDepth as number) || 2;
    const result = this.engine!.getNeighborhood(entityId, maxDepth);
    return { toolCallId: toolCall.id, content: result };
  }

  private handleGraphFindPaths(toolCall: PluginToolCall): PluginToolResult {
    const sourceId = toolCall.arguments.sourceId as string;
    const targetId = toolCall.arguments.targetId as string;
    const maxDepth = (toolCall.arguments.maxDepth as number) || 3;
    const linkTypes = toolCall.arguments.linkTypes as string[] | undefined;
    const paths = this.engine!.findPaths(sourceId, targetId, maxDepth, linkTypes);
    return { toolCallId: toolCall.id, content: { paths } };
  }

  async shutdown(): Promise<void> {
    if (this.engine) {
      closeGraphEngine();
      this.engine = null;
    }
  }
}

// Singleton worker instance
let workerInstance: PluginWorker | null = null;

export function getPluginWorker(): PluginWorker {
  if (!workerInstance) {
    workerInstance = new PluginWorker();
  }
  return workerInstance;
}

// MCP tool registration interface (matches upstream plugin-llm-wiki)
export const mcpTools = [
  {
    name: 'entity_upsert',
    description: 'Create or update an entity in the graph',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        type: { type: 'string' },
        properties: { type: 'object' },
        createdAt: { type: 'number' },
        updatedAt: { type: 'number' }
      },
      required: ['id', 'name', 'type']
    }
  },
  {
    name: 'entity_get',
    description: 'Get an entity by ID or name',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' }
      }
    }
  },
  {
    name: 'entity_search',
    description: 'Search entities by name or type',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' }
      },
      required: ['query']
    }
  },
  {
    name: 'entity_list',
    description: 'List all entities with pagination',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
        offset: { type: 'number' }
      }
    }
  },
  {
    name: 'entity_delete',
    description: 'Delete an entity and its links',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'wikilink_upsert',
    description: 'Create or update a wikilink between entities',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        sourceEntityId: { type: 'string' },
        targetEntityId: { type: 'string' },
        linkType: { type: 'string', enum: ['reference', 'definition', 'mention', 'relation'] },
        context: { type: 'string' },
        createdAt: { type: 'number' }
      },
      required: ['id', 'sourceEntityId', 'targetEntityId', 'linkType']
    }
  },
  {
    name: 'wikilink_get',
    description: 'Get all wikilinks for an entity',
    inputSchema: {
      type: 'object',
      properties: {
        entityId: { type: 'string' }
      },
      required: ['entityId']
    }
  },
  {
    name: 'graph_neighborhood',
    description: 'Get entity neighborhood (1-2 hop traversal)',
    inputSchema: {
      type: 'object',
      properties: {
        entityId: { type: 'string' },
        maxDepth: { type: 'number' }
      },
      required: ['entityId']
    }
  },
  {
    name: 'graph_find_paths',
    description: 'Find paths between two entities using recursive CTE',
    inputSchema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string' },
        targetId: { type: 'string' },
        maxDepth: { type: 'number' },
        linkTypes: { type: 'array', items: { type: 'string' } }
      },
      required: ['sourceId', 'targetId']
    }
  }
];

export function registerMcpTools(registry: { register: (tool: typeof mcpTools[0]) => void }): void {
  for (const tool of mcpTools) {
    registry.register(tool);
  }
}