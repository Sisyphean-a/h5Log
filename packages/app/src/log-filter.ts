import type { StoredLog } from "@h5-log/sdk";

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
  const search = filter.search?.trim().toLocaleLowerCase();
  const sources = new Set(source ? source.split(",") : []);

  function inScope(log: StoredLog): boolean {
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
      (!search || JSON.stringify(log.args).toLocaleLowerCase().includes(search))
    );
  }

  return { inScope, matches };
}
