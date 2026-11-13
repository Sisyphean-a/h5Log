export type LogLevel = "debug" | "info" | "log" | "warn" | "error";
export type LogSource = "console" | "error" | "http" | "bridge" | "custom";
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface LogContext {
  appId: string;
  environment: string;
  deviceId: string;
  sessionId: string;
  deviceName: string;
  userAgent: string;
}
export interface LogEvent extends LogContext {
  eventId: string;
  timestamp: number;
  pageUrl: string;
  level: LogLevel;
  source: LogSource;
  args: JsonValue[];
  requestId?: string;
}
export interface StoredLog extends LogEvent {
  id: number;
  receivedAt: number;
  clientKey: string;
}
export interface LogClient extends LogContext {
  key: string;
  lastSeen: number;
  logCount: number;
  errorCount: number;
}
export interface LogSession {
  clientKey: string;
  sessionId: string;
  firstSeen: number;
  lastSeen: number;
  logCount: number;
  errorCount: number;
  pageUrl: string;
}
export interface LogPage {
  logs: StoredLog[];
  clients: LogClient[];
  sessions: LogSession[];
  cursor: number;
  hasMore: boolean;
  total: number;
  retentionHours: number;
  serverId: string;
}
export interface LogDetail {
  log: StoredLog;
  related: StoredLog[];
}
export interface ClientUpdate {
  clients: LogClient[];
  expiresBefore: number;
  evictedThroughId: number;
}
export interface ServiceStatus {
  status: "ok";
  serverId: string;
  startedAt: number;
  now: number;
  uptimeSeconds: number;
  logs: number;
  bytes: number;
  clients: number;
  sessions: number;
  received: number;
  evicted: number;
  subscribers: number;
  retentionHours: number;
  limits: {
    maxLogs: number;
    maxBytes: number;
    maxSubscribers: number;
    maxEventBytes: number;
  };
}
export interface LoggerStatus {
  enabled: boolean;
  queued: number;
  dropped: number;
  lastError: string | null;
  sent: number;
  lastSentAt: number | null;
  retryAt: number | null;
  state: "disabled" | "idle" | "sending" | "retrying";
}
export interface Logger {
  readonly context: Readonly<LogContext>;
  record(source: LogSource, level: LogLevel, ...args: unknown[]): void;
  flush(): Promise<void>;
  stop(): void;
  getStatus(): LoggerStatus;
}
export interface LoggerOptions {
  enabled: boolean;
  appId: string;
  endpoint: string;
  environment?: string;
  deviceName?: string;
  captureConsole?: boolean;
  captureErrors?: boolean;
  captureFetch?: boolean;
}
export const CONTEXT_LIMITS: Readonly<Record<keyof LogContext, number>> =
  Object.freeze({
    appId: 128,
    environment: 64,
    deviceId: 256,
    sessionId: 256,
    deviceName: 128,
    userAgent: 1024,
  });
export const MAX_EVENT_BYTES = 128 * 1024;
export const MAX_BATCH_BYTES = 512 * 1024;
export const MAX_BATCH_EVENTS = 50;
