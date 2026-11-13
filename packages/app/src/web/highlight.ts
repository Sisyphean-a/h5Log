export type LogTokenKind =
  | "plain"
  | "tag"
  | "url"
  | "http-method"
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

  const tokens: LogToken[] = [];
  let cursor = 0;
  const tag = leadingTag(text);
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
  if (!needle) {
    const pieces = tokens.map(plainPiece);
    remember(piecesCache, key, pieces);
    return pieces;
  }

  const ranges = findRanges(text.toLowerCase(), needle);
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

function leadingTag(
  text: string,
): { index: number; text: string } | undefined {
  const match = /^\s*(\[[\w.:/-]{1,40}\])/.exec(text);
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

function findRanges(text: string, needle: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const index = text.indexOf(needle, cursor);
    if (index === -1) break;
    ranges.push([index, index + needle.length]);
    cursor = index + needle.length;
  }
  return ranges;
}

function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.size >= cacheLimit) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}
