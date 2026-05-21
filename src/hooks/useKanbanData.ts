/**
 * useKanbanData Hook
 * 
 * Centralized state management for Kanban with:
 * - Stale-while-revalidate pattern (no flickering)
 * - Intelligent polling (30s background refresh)
 * - Merge-based updates (adds/updates without replacing)
 * - Database-agnostic design (works with any backend)
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { mergeById, type MergeResult } from '@/utils/dataSync';

interface UseKanbanDataOptions<T> {
  /** Function to fetch data from API */
  fetchFn: () => Promise<T[]>;
  /** Polling interval in ms (default: 30000) */
  pollingInterval?: number;
  /** Whether to enable automatic polling (default: true) */
  enablePolling?: boolean;
  /** Callback when new items are detected */
  onNewItems?: (ids: string[]) => void;
}

interface UseKanbanDataReturn<T> {
  data: T[];
  isInitialLoading: boolean;
  isSyncing: boolean;
  lastSyncAt: string | null;
  error: Error | null;
  /** Trigger a manual refresh */
  refresh: () => Promise<void>;
  /** Imperatively update local state (for optimistic updates) */
  updateItem: (id: string, updates: Partial<T>) => void;
  /** Add item locally (for optimistic creates) */
  addItem: (item: T) => void;
  /** Remove item locally (for optimistic deletes) */
  removeItem: (id: string) => void;
  /** IDs of recently added items (for animations) */
  newItemIds: Set<string>;
}

export function useKanbanData<T extends { id: string; updated_at?: string }>(
  options: UseKanbanDataOptions<T>
): UseKanbanDataReturn<T> {
  const { 
    fetchFn, 
    pollingInterval = 30000, 
    enablePolling = true,
    onNewItems 
  } = options;

  const [data, setData] = useState<T[]>([]);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [newItemIds, setNewItemIds] = useState<Set<string>>(new Set());

  const isFirstLoad = useRef(true);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  // Clear new item animation after delay
  const clearNewItemIds = useCallback((ids: string[]) => {
    setTimeout(() => {
      setNewItemIds(prev => {
        const next = new Set(prev);
        ids.forEach(id => next.delete(id));
        return next;
      });
    }, 2000); // Animation duration
  }, []);

  const fetchData = useCallback(async (isBackground = false) => {
    if (!isBackground && data.length === 0) {
      setIsInitialLoading(true);
    } else if (isBackground) {
      setIsSyncing(true);
    }

    try {
      const incoming = await fetchFn();
      
      setData(current => {
        if (current.length === 0) {
          // First load - just set data
          return incoming;
        }

        // Merge with existing data
        const result: MergeResult<T> = mergeById(current, incoming, true);
        
        // Track new items for animation
        if (result.added.length > 0) {
          setNewItemIds(prev => new Set([...prev, ...result.added]));
          clearNewItemIds(result.added);
          onNewItems?.(result.added);
        }

        return result.data;
      });

      setLastSyncAt(new Date().toISOString());
      setError(null);
      isFirstLoad.current = false;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch data'));
      console.error('Kanban data fetch error:', err);
    } finally {
      setIsInitialLoading(false);
      setIsSyncing(false);
    }
  }, [fetchFn, data.length, clearNewItemIds, onNewItems]);

  // Initial fetch
  useEffect(() => {
    fetchData(false);
  }, []);

  // Polling
  useEffect(() => {
    if (!enablePolling) return;

    pollingRef.current = setInterval(() => {
      if (!isFirstLoad.current) {
        fetchData(true);
      }
    }, pollingInterval);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, [fetchData, pollingInterval, enablePolling]);

  // Manual refresh
  const refresh = useCallback(async () => {
    await fetchData(true);
  }, [fetchData]);

  // Optimistic update
  const updateItem = useCallback((id: string, updates: Partial<T>) => {
    setData(current => 
      current.map(item => 
        item.id === id ? { ...item, ...updates } : item
      )
    );
  }, []);

  // Optimistic add
  const addItem = useCallback((item: T) => {
    setData(current => [item, ...current]);
    setNewItemIds(prev => new Set([...prev, item.id]));
    clearNewItemIds([item.id]);
  }, [clearNewItemIds]);

  // Optimistic remove
  const removeItem = useCallback((id: string) => {
    setData(current => current.filter(item => item.id !== id));
  }, []);

  return {
    data,
    isInitialLoading,
    isSyncing,
    lastSyncAt,
    error,
    refresh,
    updateItem,
    addItem,
    removeItem,
    newItemIds,
  };
}
