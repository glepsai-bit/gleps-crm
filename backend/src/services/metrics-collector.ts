import os from 'os';
import { execSync } from 'child_process';
import { logger } from '../utils/logger';

export interface MetricsSnapshot {
  timestamp: string;
  cpu: number;          // percentage 0-100
  ram_used: number;     // bytes
  ram_total: number;    // bytes
  disk_used: number;    // bytes
  disk_total: number;   // bytes
  network_in: number;   // bytes/s
  network_out: number;  // bytes/s
  node_heap_used: number;
  node_heap_total: number;
  uptime: number;       // seconds
}

export interface ServerResources {
  cpu_percent: number;
  cpu_cores: number;
  ram_used_bytes: number;
  ram_total_bytes: number;
  ram_percent: number;
  disk_used_bytes: number;
  disk_total_bytes: number;
  disk_percent: number;
  network_in_bytes_sec: number;
  network_out_bytes_sec: number;
  node_heap_used: number;
  node_heap_total: number;
  node_rss: number;
  uptime_seconds: number;
  os_type: string;
  os_platform: string;
  hostname: string;
}

const MAX_HISTORY_POINTS = 288; // 24h at 5min intervals
const COLLECTION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

class MetricsCollector {
  private static instance: MetricsCollector;
  private history: MetricsSnapshot[] = [];
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private lastNetworkStats: { rx: number; tx: number; timestamp: number } | null = null;
  private lastCpuTimes: { idle: number; total: number } | null = null;

  private constructor() {}

  static getInstance(): MetricsCollector {
    if (!MetricsCollector.instance) {
      MetricsCollector.instance = new MetricsCollector();
    }
    return MetricsCollector.instance;
  }

  /**
   * Start collecting metrics at regular intervals
   */
  start(): void {
    if (this.intervalHandle) return;

    logger.info('📊 Metrics collector started (interval: 5min)');

    // Collect immediately
    this.collectSnapshot();

    // Then every 5 minutes
    this.intervalHandle = setInterval(() => {
      this.collectSnapshot();
    }, COLLECTION_INTERVAL_MS);
  }

  /**
   * Stop collecting
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      logger.info('📊 Metrics collector stopped');
    }
  }

  /**
   * Get current server resources
   */
  getCurrentResources(): ServerResources {
    const cpuPercent = this.getCpuPercent();
    const memInfo = this.getMemoryInfo();
    const diskInfo = this.getDiskInfo();
    const networkInfo = this.getNetworkRate();
    const heapInfo = process.memoryUsage();

    return {
      cpu_percent: cpuPercent,
      cpu_cores: os.cpus().length,
      ram_used_bytes: memInfo.used,
      ram_total_bytes: memInfo.total,
      ram_percent: memInfo.total > 0 ? Math.round((memInfo.used / memInfo.total) * 100) : 0,
      disk_used_bytes: diskInfo.used,
      disk_total_bytes: diskInfo.total,
      disk_percent: diskInfo.total > 0 ? Math.round((diskInfo.used / diskInfo.total) * 100) : 0,
      network_in_bytes_sec: networkInfo.rxPerSec,
      network_out_bytes_sec: networkInfo.txPerSec,
      node_heap_used: heapInfo.heapUsed,
      node_heap_total: heapInfo.heapTotal,
      node_rss: heapInfo.rss,
      uptime_seconds: os.uptime(),
      os_type: os.type(),
      os_platform: os.platform(),
      hostname: os.hostname(),
    };
  }

  /**
   * Get historical snapshots
   */
  getHistory(period: '24h' | '7d' | '30d'): MetricsSnapshot[] {
    const now = Date.now();
    let cutoff: number;

    switch (period) {
      case '24h':
        cutoff = now - 24 * 60 * 60 * 1000;
        break;
      case '7d':
        cutoff = now - 7 * 24 * 60 * 60 * 1000;
        break;
      case '30d':
        cutoff = now - 30 * 24 * 60 * 60 * 1000;
        break;
    }

    return this.history.filter(s => new Date(s.timestamp).getTime() >= cutoff);
  }

  /**
   * Get weekly consumption averages
   */
  getWeeklyConsumption(): Array<{ day: string; cpu_avg: number; ram_avg: number; requests: number }> {
    const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const weekData: Record<number, { cpuSum: number; ramSum: number; count: number }> = {};

    for (let i = 0; i < 7; i++) {
      weekData[i] = { cpuSum: 0, ramSum: 0, count: 0 };
    }

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentHistory = this.history.filter(s => new Date(s.timestamp).getTime() >= sevenDaysAgo);

    for (const snapshot of recentHistory) {
      const dayOfWeek = new Date(snapshot.timestamp).getDay();
      const ramPercent = snapshot.ram_total > 0 ? (snapshot.ram_used / snapshot.ram_total) * 100 : 0;
      weekData[dayOfWeek].cpuSum += snapshot.cpu;
      weekData[dayOfWeek].ramSum += ramPercent;
      weekData[dayOfWeek].count++;
    }

    // Reorder: Mon-Sun
    const orderedDays = [1, 2, 3, 4, 5, 6, 0];
    return orderedDays.map(dayIndex => ({
      day: days[dayIndex],
      cpu_avg: weekData[dayIndex].count > 0
        ? Math.round(weekData[dayIndex].cpuSum / weekData[dayIndex].count)
        : 0,
      ram_avg: weekData[dayIndex].count > 0
        ? Math.round(weekData[dayIndex].ramSum / weekData[dayIndex].count)
        : 0,
      requests: 0, // Would need request counting middleware
    }));
  }

  // ========== PRIVATE METHODS ==========\\

  private collectSnapshot(): void {
    try {
      const cpuPercent = this.getCpuPercent();
      const memInfo = this.getMemoryInfo();
      const diskInfo = this.getDiskInfo();
      const networkInfo = this.getNetworkRate();
      const heapInfo = process.memoryUsage();

      const snapshot: MetricsSnapshot = {
        timestamp: new Date().toISOString(),
        cpu: cpuPercent,
        ram_used: memInfo.used,
        ram_total: memInfo.total,
        disk_used: diskInfo.used,
        disk_total: diskInfo.total,
        network_in: networkInfo.rxPerSec,
        network_out: networkInfo.txPerSec,
        node_heap_used: heapInfo.heapUsed,
        node_heap_total: heapInfo.heapTotal,
        uptime: os.uptime(),
      };

      this.history.push(snapshot);

      // Circular buffer: keep only MAX_HISTORY_POINTS
      if (this.history.length > MAX_HISTORY_POINTS) {
        this.history = this.history.slice(-MAX_HISTORY_POINTS);
      }
    } catch (error) {
      logger.error('Failed to collect metrics snapshot', error);
    }
  }

  /**
   * CPU usage percentage using os.cpus() delta
   */
  private getCpuPercent(): number {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    for (const cpu of cpus) {
      totalIdle += cpu.times.idle;
      totalTick += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
    }

    if (this.lastCpuTimes) {
      const idleDiff = totalIdle - this.lastCpuTimes.idle;
      const totalDiff = totalTick - this.lastCpuTimes.total;
      const percent = totalDiff > 0 ? Math.round((1 - idleDiff / totalDiff) * 100) : 0;
      this.lastCpuTimes = { idle: totalIdle, total: totalTick };
      return Math.max(0, Math.min(100, percent));
    }

    this.lastCpuTimes = { idle: totalIdle, total: totalTick };

    // First call: use load average as fallback
    const loadAvg = os.loadavg()[0]; // 1min average
    const numCpus = cpus.length;
    return Math.min(100, Math.round((loadAvg / numCpus) * 100));
  }

  /**
   * Memory info from os module
   */
  private getMemoryInfo(): { used: number; total: number } {
    const total = os.totalmem();
    const free = os.freemem();
    return { used: total - free, total };
  }

  /**
   * Disk info using df command (Linux/macOS) with fallback
   */
  private getDiskInfo(): { used: number; total: number } {
    try {
      const platform = os.platform();
      if (platform === 'linux' || platform === 'darwin') {
        const output = execSync('df -B1 / 2>/dev/null | tail -1', { encoding: 'utf8', timeout: 5000 });
        const parts = output.trim().split(/\s+/);
        if (parts.length >= 4) {
          const total = parseInt(parts[1], 10);
          const used = parseInt(parts[2], 10);
          if (!isNaN(total) && !isNaN(used)) {
            return { used, total };
          }
        }
      } else if (platform === 'win32') {
        const output = execSync('wmic logicaldisk get size,freespace /format:csv 2>nul', {
          encoding: 'utf8',
          timeout: 5000,
        });
        const lines = output.trim().split('\n').filter(l => l.trim());
        let totalDisk = 0;
        let freeDisk = 0;
        for (const line of lines.slice(1)) {
          const parts = line.split(',');
          if (parts.length >= 3) {
            const free = parseInt(parts[1], 10);
            const size = parseInt(parts[2], 10);
            if (!isNaN(free) && !isNaN(size)) {
              freeDisk += free;
              totalDisk += size;
            }
          }
        }
        if (totalDisk > 0) {
          return { used: totalDisk - freeDisk, total: totalDisk };
        }
      }
    } catch {
      // Silently fail
    }
    return { used: 0, total: 0 };
  }

  /**
   * Network rate from /proc/net/dev (Linux) with fallback
   */
  private getNetworkRate(): { rxPerSec: number; txPerSec: number } {
    try {
      if (os.platform() === 'linux') {
        const output = execSync('cat /proc/net/dev 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
        const lines = output.trim().split('\n').slice(2); // Skip headers

        let totalRx = 0;
        let totalTx = 0;

        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          const iface = parts[0].replace(':', '');
          if (iface === 'lo') continue; // Skip loopback

          totalRx += parseInt(parts[1], 10) || 0;
          totalTx += parseInt(parts[9], 10) || 0;
        }

        const now = Date.now();

        if (this.lastNetworkStats) {
          const timeDiff = (now - this.lastNetworkStats.timestamp) / 1000;
          if (timeDiff > 0) {
            const rxPerSec = Math.round((totalRx - this.lastNetworkStats.rx) / timeDiff);
            const txPerSec = Math.round((totalTx - this.lastNetworkStats.tx) / timeDiff);
            this.lastNetworkStats = { rx: totalRx, tx: totalTx, timestamp: now };
            return {
              rxPerSec: Math.max(0, rxPerSec),
              txPerSec: Math.max(0, txPerSec),
            };
          }
        }

        this.lastNetworkStats = { rx: totalRx, tx: totalTx, timestamp: now };
      }
    } catch {
      // Silently fail
    }
    return { rxPerSec: 0, txPerSec: 0 };
  }
}

export const metricsCollector = MetricsCollector.getInstance();
