/**
 * SQLite WAL Graph Memory Engine
 * Implements Karpathy-style entity/wikilink graph with recursive CTEs
 * Uses better-sqlite3 with PRAGMA journal_mode=WAL for concurrent access
 */

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

export interface Entity {
  id: string;
  name: string;
  type: string;
  properties: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface Wikilink {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  linkType: 'reference' | 'definition' | 'mention' | 'relation';
  context: string;
  createdAt: number;
}

export interface GraphQueryResult {
  entities: Entity[];
  links: Wikilink[];
  paths?: Array<{ path: string[]; distance: number }>;
}

export class GraphMemoryEngine {
  private db: Database.Database;
  private companyId: string;

  constructor(dataDir: string, companyId: string) {
    this.companyId = companyId;
    const dbPath = join(dataDir, `graph-${companyId}.db`);
    
    // Ensure data directory exists
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.configureDatabase();
    this.initializeSchema();
  }

  private configureDatabase(): void {
    // Enable WAL mode for concurrent readers/writers
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -32768'); // 32MB cache
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('mmap_size = 268435456'); // 256MB mmap
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        properties TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS wikilinks (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        source_entity_id TEXT NOT NULL,
        target_entity_id TEXT NOT NULL,
        link_type TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (source_entity_id) REFERENCES entities(id),
        FOREIGN KEY (target_entity_id) REFERENCES entities(id)
      );

      CREATE INDEX IF NOT EXISTS idx_entities_company ON entities(company_id);
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
      CREATE INDEX IF NOT EXISTS idx_wikilinks_company ON wikilinks(company_id);
      CREATE INDEX IF NOT EXISTS idx_wikilinks_source ON wikilinks(source_entity_id);
      CREATE INDEX IF NOT EXISTS idx_wikilinks_target ON wikilinks(target_entity_id);
      CREATE INDEX IF NOT EXISTS idx_wikilinks_type ON wikilinks(link_type);
    `);
  }

  // Entity operations
  upsertEntity(entity: Omit<Entity, 'createdAt' | 'updatedAt'> & { createdAt?: number; updatedAt?: number }): Entity {
    const now = Date.now();
    const existing = this.db.prepare('SELECT * FROM entities WHERE id = ? AND company_id = ?').get(entity.id, this.companyId);
    
    if (existing) {
      const updated = {
        ...entity,
        properties: JSON.stringify(entity.properties),
        updatedAt: now
      };
      this.db.prepare(`
        UPDATE entities 
        SET name = ?, type = ?, properties = ?, updated_at = ?
        WHERE id = ? AND company_id = ?
      `).run(entity.name, entity.type, JSON.stringify(entity.properties), now, entity.id, this.companyId);
      
      return { ...entity, createdAt: existing.created_at, updatedAt: now };
    } else {
      const newEntity = {
        ...entity,
        properties: JSON.stringify(entity.properties),
        createdAt: entity.createdAt || now,
        updatedAt: now
      };
      this.db.prepare(`
        INSERT INTO entities (id, company_id, name, type, properties, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        entity.id, this.companyId, entity.name, entity.type,
        JSON.stringify(entity.properties), newEntity.createdAt, now
      );
      
      return { ...entity, properties: entity.properties, createdAt: newEntity.createdAt, updatedAt: now };
    }
  }

  getEntity(id: string): Entity | null {
    const row = this.db.prepare('SELECT * FROM entities WHERE id = ? AND company_id = ?').get(id, this.companyId);
    if (!row) return null;
    return this.rowToEntity(row);
  }

  getEntityByName(name: string): Entity | null {
    const row = this.db.prepare('SELECT * FROM entities WHERE name = ? AND company_id = ?').get(name, this.companyId);
    if (!row) return null;
    return this.rowToEntity(row);
  }

  deleteEntity(id: string): boolean {
    const result = this.db.prepare('DELETE FROM entities WHERE id = ? AND company_id = ?').run(id, this.companyId);
    // Also delete associated wikilinks
    this.db.prepare('DELETE FROM wikilinks WHERE (source_entity_id = ? OR target_entity_id = ?) AND company_id = ?')
      .run(id, id, this.companyId);
    return result.changes > 0;
  }

  // Wikilink operations
  upsertWikilink(wikilink: Omit<Wikilink, 'createdAt'> & { createdAt?: number }): Wikilink {
    const now = wikilink.createdAt || Date.now();
    const existing = this.db.prepare('SELECT * FROM wikilinks WHERE id = ? AND company_id = ?').get(wikilink.id, this.companyId);
    
    if (existing) {
      this.db.prepare(`
        UPDATE wikilinks 
        SET source_entity_id = ?, target_entity_id = ?, link_type = ?, context = ?
        WHERE id = ? AND company_id = ?
      `).run(wikilink.sourceEntityId, wikilink.targetEntityId, wikilink.linkType, wikilink.context, wikilink.id, this.companyId);
    } else {
      this.db.prepare(`
        INSERT INTO wikilinks (id, company_id, source_entity_id, target_entity_id, link_type, context, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(wikilink.id, this.companyId, wikilink.sourceEntityId, wikilink.targetEntityId, wikilink.linkType, wikilink.context, now);
    }
    
    return { ...wikilink, createdAt: now };
  }

  getWikilinksForEntity(entityId: string): Wikilink[] {
    const rows = this.db.prepare('SELECT * FROM wikilinks WHERE (source_entity_id = ? OR target_entity_id = ?) AND company_id = ?')
      .all(entityId, entityId, this.companyId);
    return rows.map(this.rowToWikilink);
  }

  // Recursive CTE graph traversal
  findPaths(
    sourceId: string, 
    targetId: string, 
    maxDepth: number = 3,
    linkTypes?: string[]
  ): Array<{ path: string[]; distance: number }> {
    const linkTypeFilter = linkTypes && linkTypes.length > 0 
      ? `AND link_type IN (${linkTypes.map(() => '?').join(',')})` 
      : '';
    const linkTypeParams = linkTypes || [];

    // Recursive CTE for path finding
    const query = `
      WITH RECURSIVE path_finder(path, current_id, target_id, distance, visited) AS (
        -- Base case: start from source
        SELECT 
          CAST(source_entity_id AS TEXT) as path,
          target_entity_id as current_id,
          ? as target_id,
          1 as distance,
          CAST(source_entity_id AS TEXT) as visited
        FROM wikilinks 
        WHERE source_entity_id = ? AND company_id = ? ${linkTypeFilter}
        
        UNION ALL
        
        -- Recursive step: follow links
        SELECT 
          pf.path || '->' || w.target_entity_id,
          w.target_entity_id,
          pf.target_id,
          pf.distance + 1,
          pf.visited || ',' || w.target_entity_id
        FROM path_finder pf
        JOIN wikilinks w ON w.source_entity_id = pf.current_id AND w.company_id = ? ${linkTypeFilter}
        WHERE pf.distance < ?
          AND pf.current_id != pf.target_id
          AND instr(pf.visited, w.target_entity_id) = 0
      )
      SELECT path, distance FROM path_finder 
      WHERE current_id = target_id
      ORDER BY distance ASC
      LIMIT 10
    `;

    const params = [targetId, sourceId, this.companyId, ...linkTypeParams, this.companyId, maxDepth];
    const rows = this.db.prepare(query).all(...params) as Array<{ path: string; distance: number }>;
    
    return rows.map(row => ({
      path: row.path.split('->'),
      distance: row.distance
    }));
  }

  // Entity neighborhood (1-2 hop traversal)
  getNeighborhood(entityId: string, maxDepth: number = 2): GraphQueryResult {
    const query = `
      WITH RECURSIVE neighborhood(entity_id, distance, path) AS (
        SELECT ?, 0, CAST(? AS TEXT)
        UNION ALL
        SELECT w.target_entity_id, n.distance + 1, n.path || '->' || w.target_entity_id
        FROM neighborhood n
        JOIN wikilinks w ON w.source_entity_id = n.entity_id AND w.company_id = ?
        WHERE n.distance < ?
          AND instr(n.path, w.target_entity_id) = 0
      )
      SELECT DISTINCT e.*, n.distance FROM neighborhood n
      JOIN entities e ON e.id = n.entity_id AND e.company_id = ?
      ORDER BY n.distance ASC
    `;

    const entityRows = this.db.prepare(query).all(entityId, entityId, this.companyId, maxDepth, this.companyId) as Array<{
      id: string;
      company_id: string;
      name: string;
      type: string;
      properties: string;
      created_at: number;
      updated_at: number;
      distance: number;
    }>;

    const entities = entityRows.map(this.rowToEntity);
    const entityIds = entities.map(e => e.id);
    
    // Get all wikilinks between these entities
    const placeholders = entityIds.map(() => '?').join(',');
    const linkRows = this.db.prepare(`
      SELECT * FROM wikilinks 
      WHERE company_id = ? 
      AND source_entity_id IN (${placeholders}) 
      AND target_entity_id IN (${placeholders})
    `).all(this.companyId, ...entityIds, ...entityIds) as Array<{
      id: string;
      company_id: string;
      source_entity_id: string;
      target_entity_id: string;
      link_type: string;
      context: string;
      created_at: number;
    }>;

    const links = linkRows.map(this.rowToWikilink);

    return { entities, links };
  }

  // Search entities by name/type
  searchEntities(query: string, limit: number = 20): Entity[] {
    const rows = this.db.prepare(`
      SELECT * FROM entities 
      WHERE company_id = ? AND (name LIKE ? OR type LIKE ?)
      ORDER BY 
        CASE WHEN name = ? THEN 0 ELSE 1 END,
        updated_at DESC
      LIMIT ?
    `).all(this.companyId, `%${query}%`, `%${query}%`, query, limit) as Array<{
      id: string;
      company_id: string;
      name: string;
      type: string;
      properties: string;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map(this.rowToEntity);
  }

  // Get all entities for a company (with pagination)
  getAllEntities(limit: number = 100, offset: number = 0): Entity[] {
    const rows = this.db.prepare(`
      SELECT * FROM entities 
      WHERE company_id = ?
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `).all(this.companyId, limit, offset) as Array<{
      id: string;
      company_id: string;
      name: string;
      type: string;
      properties: string;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map(this.rowToEntity);
  }

  private rowToEntity(row: {
    id: string;
    company_id: string;
    name: string;
    type: string;
    properties: string;
    created_at: number;
    updated_at: number;
  }): Entity {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      properties: JSON.parse(row.properties || '{}'),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private rowToWikilink(row: {
    id: string;
    company_id: string;
    source_entity_id: string;
    target_entity_id: string;
    link_type: string;
    context: string;
    created_at: number;
  }): Wikilink {
    return {
      id: row.id,
      sourceEntityId: row.source_entity_id,
      targetEntityId: row.target_entity_id,
      linkType: row.link_type as Wikilink['linkType'],
      context: row.context,
      createdAt: row.created_at
    };
  }

  close(): void {
    this.db.close();
  }
}

// Singleton factory for plugin worker
let engineInstance: GraphMemoryEngine | null = null;

export function getGraphEngine(dataDir: string, companyId: string): GraphMemoryEngine {
  if (!engineInstance) {
    engineInstance = new GraphMemoryEngine(dataDir, companyId);
  }
  return engineInstance;
}

export function closeGraphEngine(): void {
  if (engineInstance) {
    engineInstance.close();
    engineInstance = null;
  }
}