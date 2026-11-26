import type { StoredLog } from "@h5-log/sdk";
import { compileSearchQuery } from "./search-query.js";

export const LOG_WINDOW_SIZE = 2000;

export interface LogFilter {
  appId?: string;
  environment?: string;
  clientKey?: string;
  sessionId?: string;
  level?: string;
  /** Rule: 逗号分隔的来源取并集，空值表示不限来源。 */
  source?: string;
  search?: string;
}

/** Rule: 会话目录只受客户端范围约束，日志行再应用其他筛选；一次编译固定本次查询的条件。 */
export function createLogMatcher(filter: LogFilter) {
  const { appId, environment, clientKey, sessionId, level, source } = filter;
  const search = filter.search?.trim();
  const searchQuery = search ? compileSearchQuery(search) : undefined;
  const sources = new Set(source ? source.split(",") : []);

  function inScope(log: Pick<StoredLog, "appId" | "environment" | "clientKey">): boolean {
    return (
      (!appId || log.appId === appId) &&
      (!environment || log.environment === environment) &&
      (!clientKey || log.clientKey === clientKey)
    );
  }

  function matches(log: StoredLog): boolean {
    return (
      inScope(log) &&
      (!sessionId || log.sessionId === sessionId) &&
      (!level || log.level === level) &&
      (sources.size === 0 || sources.has(log.source)) &&
      (!searchQuery || searchQuery.matches(JSON.stringify(log.args)))
    );
  }

  return { inScope, matches };
}
