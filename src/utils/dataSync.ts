/**
 * Data Synchronization Utilities
 * 
 * Database-agnostic functions for intelligent data merging.
 * Works with any backend: Supabase, REST API, PostgreSQL, etc.
 */

export interface Identifiable {
  id: string;
  updated_at?: string;
}

export interface MergeResult<T> {
  data: T[];
  added: string[];
  updated: string[];
  removed: string[];
}

/**
 * Merges incoming data with existing data based on ID.
 * - New items are added to the beginning
 * - Existing items are updated in place
 * - Optionally removes items not in incoming data
 * 
 * @param existing Current local state
 * @param incoming New data from API
 * @param removeStale Whether to remove items not in incoming (default: false)
 */
export function mergeById<T extends Identifiable>(
  existing: T[],
  incoming: T[],
  removeStale = false
): MergeResult<T> {
  const existingMap = new Map(existing.map(item => [item.id, item]));
  const incomingMap = new Map(incoming.map(item => [item.id, item]));
  
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  
  // Track which items need to be added (new) or updated
  const result: T[] = [];
  const newItems: T[] = [];
  
  for (const item of incoming) {
    const existingItem = existingMap.get(item.id);
    
    if (!existingItem) {
      // New item
      added.push(item.id);
      newItems.push(item);
    } else {
      // Check if updated (compare updated_at if available)
      const isUpdated = item.updated_at && existingItem.updated_at 
        ? new Date(item.updated_at) > new Date(existingItem.updated_at)
        : JSON.stringify(item) !== JSON.stringify(existingItem);
      
      if (isUpdated) {
        updated.push(item.id);
        result.push(item);
      } else {
        result.push(existingItem);
      }
    }
  }
  
  // Add new items at the beginning
  const merged = [...newItems, ...result];
  
  // Handle stale removal if requested
  if (removeStale) {
    for (const item of existing) {
      if (!incomingMap.has(item.id)) {
        removed.push(item.id);
      }
    }
  } else {
    // Keep items that exist locally but not in incoming
    for (const item of existing) {
      if (!incomingMap.has(item.id)) {
        merged.push(item);
      }
    }
  }
  
  return { data: merged, added, updated, removed };
}

/**
 * Specialized merge for contacts
 */
export function mergeContacts<T extends Identifiable>(
  existing: T[],
  incoming: T[]
): MergeResult<T> {
  return mergeById(existing, incoming, true);
}

/**
 * Specialized merge for lead tags (associations)
 */
export function mergeLeadTags<T extends { id: string; contact_id: string; tag_id: string }>(
  existing: T[],
  incoming: T[]
): MergeResult<T> {
  return mergeById(existing, incoming, true);
}

/**
 * Detects changes between two snapshots for animation purposes
 */
export function detectChanges<T extends Identifiable>(
  before: T[],
  after: T[]
): { added: string[]; removed: string[]; moved: string[] } {
  const beforeIds = new Set(before.map(item => item.id));
  const afterIds = new Set(after.map(item => item.id));
  
  const added = after.filter(item => !beforeIds.has(item.id)).map(item => item.id);
  const removed = before.filter(item => !afterIds.has(item.id)).map(item => item.id);
  
  // For moved detection, we'd need position information
  // This is a placeholder for future implementation
  const moved: string[] = [];
  
  return { added, removed, moved };
}

/**
 * Creates a timestamp for tracking freshness
 */
export function createSyncTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Checks if data is stale based on age
 */
export function isStale(lastSync: string | null, maxAgeMs: number): boolean {
  if (!lastSync) return true;
  const age = Date.now() - new Date(lastSync).getTime();
  return age > maxAgeMs;
}
