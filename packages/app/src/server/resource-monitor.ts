import { readFile } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";
import { RESOURCE_INTERVAL_MS, type ResourceMetric, type ResourceSnapshot } from "../service-status.js";

type CpuTimes = { total: number; idle: number };
type Memory = { total: number; used: number };

async function hostCpuTimes(): Promise<CpuTimes | null> {
  if (process.platform === "linux") {
    const stat = await readFile("/proc/stat", "utf8");
    const fields = stat.slice(0, stat.indexOf("\n")).trim().split(/\s+/);
    if (fields[0] !== "cpu") return null;
    // Rule: guest 时间已包含在 user/nice 中；iowait 不算 CPU 忙碌。
    const times = fields.slice(1, 9).map(Number);
    if (times.length < 4 || times.some((time) => !Number.isFinite(time) || time < 0)) return null;
    return { total: times.reduce((sum, time) => sum + time, 0), idle: times[3]! + (times[4] ?? 0) };
  }
  return cpus().reduce<CpuTimes>((sum, { times }) => ({
    total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
    idle: sum.idle + times.idle,
  }), { total: 0, idle: 0 });
}

async function hostMemory(): Promise<Memory | null> {
  if (process.platform !== "linux") {
    const total = totalmem();
    return { total, used: total - freemem() };
  }
  const info = await readFile("/proc/meminfo", "utf8");
  const total = Number(/^MemTotal:\s+(\d+) kB/m.exec(info)?.[1]) * 1024;
  const available = Number(/^MemAvailable:\s+(\d+) kB/m.exec(info)?.[1]) * 1024;
  return total > 0 && available >= 0 && available <= total ? { total, used: total - available } : null;
}

function track(previous: ResourceMetric, current: number | null): ResourceMetric {
  return { current, peak: current === null ? previous.peak : Math.max(previous.peak ?? current, current) };
}

function hostCpuPercent(previous: CpuTimes | null, current: CpuTimes | null): number | null {
  if (!previous || !current) return null;
  const elapsed = current.total - previous.total;
  const busy = elapsed - (current.idle - previous.idle);
  return elapsed > 0 && busy >= 0 && busy <= elapsed ? 100 * busy / elapsed : null;
}

export function createResourceMonitor() {
  const empty = { current: null, peak: null };
  let snapshot: ResourceSnapshot = {
    sampledAt: null,
    hostCpu: empty,
    hostMemory: { ...empty, total: null },
    processCpu: empty,
    processMemory: empty,
  };
  let previous: { host: CpuTimes | null; cpu: NodeJS.CpuUsage; time: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  async function sample(): Promise<void> {
    const [host, memory] = await Promise.allSettled([hostCpuTimes(), hostMemory()]);
    if (stopped) return;
    const hostTimes = host.status === "fulfilled" ? host.value : null;
    const memoryUsage = memory.status === "fulfilled" ? memory.value : null;
    const cpu = process.cpuUsage();
    const time = performance.now();
    const cpuPercent = previous
      ? (cpu.user + cpu.system - previous.cpu.user - previous.cpu.system) / (time - previous.time) / 10
      : null;
    snapshot = {
      sampledAt: Date.now(),
      hostCpu: track(snapshot.hostCpu, hostCpuPercent(previous?.host ?? null, hostTimes)),
      hostMemory: { ...track(snapshot.hostMemory, memoryUsage?.used ?? null), total: memoryUsage?.total ?? null },
      processCpu: track(snapshot.processCpu, cpuPercent),
      processMemory: track(snapshot.processMemory, process.memoryUsage.rss()),
    };
    previous = { host: hostTimes, cpu, time };
    timer = setTimeout(() => void sample(), RESOURCE_INTERVAL_MS).unref();
  }

  return {
    start: () => { if (!stopped) void sample(); },
    read: () => snapshot,
    stop: () => { stopped = true; clearTimeout(timer); },
  };
}
