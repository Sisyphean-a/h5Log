import { compileSearchQuery } from "../search-query.js";

export type LogTokenKind =
  | "plain"
  | "tag"
  | "url"
  | "http-method"
  | "http-prefix"
  | "http-name"
  | "error-keyword"
  | "stack-prefix"
  | "stack-frame"
  | "metric"
  | "path";

export interface LogToken {
  text: string;
  kind: LogTokenKind;
  start: number;
  end: number;
}

export interface LogPiece {
  text: string;
  kind: LogTokenKind;
  hit: boolean;
}

// Rule: 语义高亮只标可辨认的片段，不改变日志原文；搜索命中单独加底色。
const tokenPatterns: Array<{ kind: LogTokenKind; regex: RegExp }> = [
  { kind: "url", regex: /https?:\/\/[^\s)]+/g },
  { kind: "http-method", regex: /\b(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g },
  {
    kind: "error-keyword",
    regex: /(?:TypeError|ReferenceError|SyntaxError|RangeError|Error|Exception)\b|失败|错误|超时/g,
  },
  {
    kind: "stack-prefix",
    regex: /\bat\b(?=\s+[\w./@-]+\.(?:vue|ts|tsx|js|jsx):\d+)/g,
  },
  {
    kind: "stack-frame",
    regex: /[\w./@-]+\.(?:vue|ts|tsx|js|jsx):\d+(?::\d+)?\b/g,
  },
  {
    kind: "metric",
    regex: /\b\d+(?:\.\d+)? ?(?:ms|s|KB|MB|GB|%)(?![A-Za-z])/g,
  },
  { kind: "path", regex: /(?:\/[\w./@?&=#-]+)+/g },
];

const tokenCache = new Map<string, LogToken[]>();
const piecesCache = new Map<string, LogPiece[]>();
const cacheLimit = 1200;

export function tokenizeLogText(text: string): LogToken[] {
  const cached = tokenCache.get(text);
  if (cached) return cached;

  const tokens = httpSummaryTokens(text);
  let cursor = tokens.at(-1)?.end ?? 0;
  const tag = cursor === 0 ? leadingTag(text) : undefined;
  if (tag) {
    if (tag.index > 0) {
      tokens.push({
        text: text.slice(0, tag.index),
        kind: "plain",
        start: 0,
        end: tag.index,
      });
    }
    tokens.push({
      text: tag.text,
      kind: "tag",
      start: tag.index,
      end: tag.index + tag.text.length,
    });
    cursor = tag.index + tag.text.length;
  }
  while (cursor < text.length) {
    const next = findNextToken(text, cursor);
    if (!next) {
      tokens.push({
        text: text.slice(cursor),
        kind: "plain",
        start: cursor,
        end: text.length,
      });
      break;
    }
    if (next.index > cursor) {
      tokens.push({
        text: text.slice(cursor, next.index),
        kind: "plain",
        start: cursor,
        end: next.index,
      });
    }
    tokens.push({
      text: next.text,
      kind: next.kind,
      start: next.index,
      end: next.index + next.text.length,
    });
    cursor = next.index + next.text.length;
  }

  const result: LogToken[] =
    tokens.length > 0
      ? tokens
      : [{ text, kind: "plain", start: 0, end: text.length }];
  remember(tokenCache, text, result);
  return result;
}

/** 搜索命中只切分已有语义 token，避免两种高亮互相覆盖。 */
export function highlightLogText(text: string, query: string): LogPiece[] {
  const needle = query.trim().toLowerCase();
  const key = `${needle}\u0000${text}`;
  const cached = piecesCache.get(key);
  if (cached) return cached;

  const tokens = tokenizeLogText(text);
  const { highlightTerms } = compileSearchQuery(needle);
  if (highlightTerms.length === 0) {
    const pieces = tokens.map(plainPiece);
    remember(piecesCache, key, pieces);
    return pieces;
  }

  const ranges = findRanges(text.toLowerCase(), highlightTerms);
  const pieces: LogPiece[] = [];
  for (const token of tokens) {
    let from = token.start;
    for (const [start, end] of ranges) {
      if (end <= token.start || start >= token.end) continue;
      const hitStart = Math.max(start, token.start);
      const hitEnd = Math.min(end, token.end);
      if (hitStart > from) {
        pieces.push({
          text: text.slice(from, hitStart),
          kind: token.kind,
          hit: false,
        });
      }
      pieces.push({
        text: text.slice(hitStart, hitEnd),
        kind: token.kind,
        hit: true,
      });
      from = hitEnd;
    }
    if (from < token.end) {
      pieces.push({
        text: text.slice(from, token.end),
        kind: token.kind,
        hit: false,
      });
    }
  }

  remember(piecesCache, key, pieces);
  return pieces;
}

export function tokenClass(kind: LogTokenKind): string | undefined {
  return kind === "plain" ? undefined : `tok-${kind}`;
}

function plainPiece(token: LogToken): LogPiece {
  return { text: token.text, kind: token.kind, hit: false };
}

/** Rule: 接口名称只取查询串/片段之前的末段路径，前缀与参数保留原文但降低权重。 */
function httpSummaryTokens(text: string): LogToken[] {
  const match = /^([→←×]\s+[A-Za-z]+\s+)(\S+)/.exec(text);
  if (!match) return [];
  const urlStart = match[1]!.length;
  const url = match[2]!;
  const query = url.search(/[?#]/);
  const path = query < 0 ? url : url.slice(0, query);
  const authorityEnd = /^[a-z][a-z\d+.-]*:\/\/[^/]+/i.exec(path)?.[0].length ?? 0;
  const nameEnd = path.replace(/\/+$/, "").length;
  const nameStart = Math.max(authorityEnd, path.lastIndexOf("/", nameEnd - 1) + 1);
  const hasName = nameEnd > nameStart;
  const start = urlStart + (hasName ? nameStart : 0);
  const end = urlStart + (hasName ? nameEnd : path.length);
  const ranges: Array<{ kind: LogTokenKind; start: number; end: number }> = [
    { kind: "http-prefix", start: 0, end: start },
    { kind: "http-name", start, end },
    { kind: "http-prefix", start: end, end: match[0].length },
  ];
  return ranges.filter((range) => range.end > range.start)
    .map((range) => ({ ...range, text: text.slice(range.start, range.end) }));
}

function leadingTag(
  text: string,
): { index: number; text: string } | undefined {
  const match = /^\s*(\[[\w\p{Script=Han}.:/-]{1,40}\])/u.exec(text);
  const tag = match?.[1];
  if (!match || !tag) return undefined;
  return { index: match[0].length - tag.length, text: tag };
}

function findNextToken(
  text: string,
  cursor: number,
): { index: number; text: string; kind: LogTokenKind } | undefined {
  let best: { index: number; text: string; kind: LogTokenKind } | undefined;

  for (const pattern of tokenPatterns) {
    pattern.regex.lastIndex = cursor;
    const match = pattern.regex.exec(text);
    if (!match || match[0].length === 0) continue;
    if (!best || match.index < best.index) {
      best = { index: match.index, text: match[0], kind: pattern.kind };
    }
  }

  return best;
}

function findRanges(text: string, needles: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const needle of needles) {
    let cursor = 0;
    while (cursor < text.length) {
      const index = text.indexOf(needle, cursor);
      if (index === -1) break;
      ranges.push([index, index + needle.length]);
      cursor = index + needle.length;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1]) {
      previous[1] = Math.max(previous[1], range[1]);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.size >= cacheLimit) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}
