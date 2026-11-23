import type { ServiceStatus } from "@h5-log/sdk";

export const RESOURCE_INTERVAL_MS = 10_000;

export interface ResourceMetric {
  current: number | null;
  peak: number | null;
}

export interface ResourceSnapshot {
  sampledAt: number | null;
  hostCpu: ResourceMetric;
  hostMemory: ResourceMetric & { total: number | null };
  processCpu: ResourceMetric;
  processMemory: ResourceMetric;
}

export interface WorkbenchServiceStatus extends ServiceStatus {
  resources: ResourceSnapshot;
}
