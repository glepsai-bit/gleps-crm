import { useState, useEffect, useCallback, useRef } from 'react';

interface SyncResource {
  name: string;
  fetchFn: () => Promise<void>;
  interval?: number;
  enabled?: boolean;
}

interface UseSyncManagerReturn {
  isSyncing: boolean;
  lastSyncAt: string | null;
  isTabActive: boolean;
  registerResource: (resource: SyncResource) => void;
  unregisterResource: (name: string) => void;
  triggerSync: (resourceName?: string) => Promise<void>;
  triggerSyncAll: () => Promise<void>;
}

const DEFAULT_INTERVAL = 30000; // 30 seconds

export function useSyncManager(): UseSyncManagerReturn {
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [isTabActive, setIsTabActive] = useState(true);
  const resourcesRef = useRef<Map<string, SyncResource>>(new Map());
  const intervalsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Track tab visibility
  useEffect(() => {
    const handleVisibilityChange = () => {
      const isActive = document.visibilityState === 'visible';
      setIsTabActive(isActive);
      
      if (isActive) {
        // Resume polling when tab becomes active
        resourcesRef.current.forEach((resource, name) => {
          if (resource.enabled !== false && !intervalsRef.current.has(name)) {
            startPolling(name, resource);
          }
        });
      } else {
        // Pause polling when tab is hidden
        intervalsRef.current.forEach((intervalId) => {
          clearInterval(intervalId);
        });
        intervalsRef.current.clear();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const startPolling = useCallback((name: string, resource: SyncResource) => {
    if (intervalsRef.current.has(name)) {
      clearInterval(intervalsRef.current.get(name)!);
    }

    const interval = resource.interval || DEFAULT_INTERVAL;
    const intervalId = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      
      try {
        setIsSyncing(true);
        await resource.fetchFn();
        setLastSyncAt(new Date().toISOString());
      } catch (error) {
        console.error(`[SyncManager] Error syncing ${name}:`, error);
      } finally {
        setIsSyncing(false);
      }
    }, interval);

    intervalsRef.current.set(name, intervalId);
  }, []);

  const registerResource = useCallback((resource: SyncResource) => {
    resourcesRef.current.set(resource.name, resource);
    
    if (resource.enabled !== false && document.visibilityState === 'visible') {
      startPolling(resource.name, resource);
    }
  }, [startPolling]);

  const unregisterResource = useCallback((name: string) => {
    resourcesRef.current.delete(name);
    
    const intervalId = intervalsRef.current.get(name);
    if (intervalId) {
      clearInterval(intervalId);
      intervalsRef.current.delete(name);
    }
  }, []);

  const triggerSync = useCallback(async (resourceName?: string) => {
    setIsSyncing(true);
    
    try {
      if (resourceName) {
        const resource = resourcesRef.current.get(resourceName);
        if (resource) {
          await resource.fetchFn();
          // Reset polling timer
          if (resource.enabled !== false) {
            startPolling(resourceName, resource);
          }
        }
      }
      setLastSyncAt(new Date().toISOString());
    } catch (error) {
      console.error('[SyncManager] Error during sync:', error);
    } finally {
      setIsSyncing(false);
    }
  }, [startPolling]);

  const triggerSyncAll = useCallback(async () => {
    setIsSyncing(true);
    
    try {
      const promises = Array.from(resourcesRef.current.values())
        .filter(r => r.enabled !== false)
        .map(r => r.fetchFn());
      
      await Promise.allSettled(promises);
      setLastSyncAt(new Date().toISOString());
      
      // Reset all polling timers
      resourcesRef.current.forEach((resource, name) => {
        if (resource.enabled !== false) {
          startPolling(name, resource);
        }
      });
    } catch (error) {
      console.error('[SyncManager] Error during sync all:', error);
    } finally {
      setIsSyncing(false);
    }
  }, [startPolling]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      intervalsRef.current.forEach((intervalId) => {
        clearInterval(intervalId);
      });
    };
  }, []);

  return {
    isSyncing,
    lastSyncAt,
    isTabActive,
    registerResource,
    unregisterResource,
    triggerSync,
    triggerSyncAll,
  };
}

// Simplified hook for individual components with built-in polling
interface UseAutoRefreshParams {
  fetchFn: () => Promise<void>;
  interval?: number;
  enabled?: boolean;
  immediate?: boolean;
}

interface UseAutoRefreshReturn {
  isSyncing: boolean;
  lastSyncAt: string | null;
  isTabActive: boolean;
  triggerSync: () => Promise<void>;
}

export function useAutoRefresh({
  fetchFn,
  interval = DEFAULT_INTERVAL,
  enabled = true,
  immediate = false,
}: UseAutoRefreshParams): UseAutoRefreshReturn {
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [isTabActive, setIsTabActive] = useState(true);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Track tab visibility
  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsTabActive(document.visibilityState === 'visible');
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const triggerSync = useCallback(async () => {
    // Cancel previous request if still running
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    setIsSyncing(true);
    try {
      await fetchFn();
      setLastSyncAt(new Date().toISOString());
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        console.error('[AutoRefresh] Sync error:', error);
      }
    } finally {
      setIsSyncing(false);
    }
  }, [fetchFn]);

  // Start polling when enabled and tab is active
  useEffect(() => {
    if (!enabled) return;

    const startPolling = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }

      intervalRef.current = setInterval(() => {
        if (document.visibilityState === 'visible') {
          triggerSync();
        }
      }, interval);
    };

    if (isTabActive) {
      startPolling();
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [enabled, interval, isTabActive, triggerSync]);

  // Immediate fetch on mount if requested
  useEffect(() => {
    if (immediate && enabled) {
      triggerSync();
    }
  }, [immediate, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    isSyncing,
    lastSyncAt,
    isTabActive,
    triggerSync,
  };
}
