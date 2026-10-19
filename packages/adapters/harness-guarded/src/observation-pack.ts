/**
 * SoL-Pi ObservationPack
 * 10 KiB threshold, evidence-preserving reducer
 * Implements the research track 2 specification
 */

export interface ObservationEntry {
  type: 'tool_call' | 'tool_result' | 'system' | 'user_message' | 'assistant_message';
  timestamp: number;
  data: unknown;
}

export class ObservationPack {
  private entries: ObservationEntry[] = [];
  private readonly maxBytes: number;
  private currentBytes: number = 0;

  constructor(maxBytes: number = 10 * 1024) {
    this.maxBytes = maxBytes;
  }

  addEntry(entry: ObservationEntry): void {
    const entrySize = this.estimateSize(entry);
    
    // If adding this entry would exceed the budget, reduce first
    if (this.currentBytes + entrySize > this.maxBytes) {
      this.reduce();
    }

    // If still over budget after reduction, drop oldest non-critical entries
    if (this.currentBytes + entrySize > this.maxBytes) {
      this.dropOldestNonCritical(entrySize);
    }

    this.entries.push(entry);
    this.currentBytes += entrySize;
  }

  private estimateSize(entry: ObservationEntry): number {
    // Rough estimate: JSON string length + overhead
    return JSON.stringify(entry).length + 50;
  }

  private reduce(): void {
    // Evidence-preserving reduction strategy:
    // 1. Keep all tool_call/tool_result pairs (evidence)
    // 2. Compress system messages
    // 3. Summarize old user/assistant messages
    // 4. Drop oldest entries if still over budget

    const criticalIndices = new Set<number>();
    const toolCallIds = new Set<string>();

    // First pass: identify critical entries (tool calls and their results)
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (entry.type === 'tool_call') {
        criticalIndices.add(i);
        // Try to find matching tool_result
        const toolCallId = (entry.data as { id?: string }).id;
        if (toolCallId) toolCallIds.add(toolCallId);
      } else if (entry.type === 'tool_result') {
        const toolCallId = (entry.data as { toolCallId?: string }).toolCallId;
        if (toolCallIds.has(toolCallId)) {
          criticalIndices.add(i);
        }
      }
    }

    // Second pass: compress non-critical entries
    const newEntries: ObservationEntry[] = [];
    let newBytes = 0;

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (criticalIndices.has(i)) {
        newEntries.push(entry);
        newBytes += this.estimateSize(entry);
      } else if (entry.type === 'system') {
        // Compress system messages to minimal form
        const compressed: ObservationEntry = {
          ...entry,
          data: { type: 'system', summary: 'compressed' }
        };
        newEntries.push(compressed);
        newBytes += this.estimateSize(compressed);
      } else if (entry.type === 'user_message' || entry.type === 'assistant_message') {
        // Summarize old messages (keep last 3)
        const recentMessages = this.entries
          .filter(e => e.type === 'user_message' || e.type === 'assistant_message')
          .slice(-3);
        
        if (recentMessages.includes(entry)) {
          newEntries.push(entry);
          newBytes += this.estimateSize(entry);
        } else {
          // Replace with summary
          const summarized: ObservationEntry = {
            ...entry,
            data: { type: entry.type, summary: 'earlier message summarized' }
          };
          newEntries.push(summarized);
          newBytes += this.estimateSize(summarized);
        }
      }
    }

    this.entries = newEntries;
    this.currentBytes = newBytes;
  }

  private dropOldestNonCritical(requiredBytes: number): void {
    // Drop oldest non-critical entries until we have space
    let freed = 0;
    const toKeep: ObservationEntry[] = [];
    
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      const size = this.estimateSize(entry);
      
      if (freed >= requiredBytes || this.isCritical(entry)) {
        toKeep.unshift(entry);
      } else {
        freed += size;
      }
    }

    this.entries = toKeep;
    this.currentBytes = this.entries.reduce((sum, e) => sum + this.estimateSize(e), 0);
  }

  private isCritical(entry: ObservationEntry): boolean {
    return entry.type === 'tool_call' || entry.type === 'tool_result';
  }

  reset(): void {
    this.entries = [];
    this.currentBytes = 0;
  }

  getEntries(): ReadonlyArray<ObservationEntry> {
    return this.entries;
  }

  getSize(): number {
    return this.currentBytes;
  }

  getMaxSize(): number {
    return this.maxBytes;
  }

  toJSON(): object {
    return {
      entries: this.entries,
      size: this.currentBytes,
      maxSize: this.maxBytes,
      entryCount: this.entries.length
    };
  }
}