interface SearchTerm {
  needle: string;
  negated: boolean;
}

/** Rule: 与 logcat 一致，先按 || 分组，再按 && 合取；仅词首 - 表示取反。 */
export function compileSearchQuery(query: string) {
  const normalized = query.trim().toLowerCase();
  const usesOperators = normalized.includes("&&") || normalized.includes("||") || normalized.startsWith("-");
  const groups = usesOperators
    ? normalized.split("||")
      .map((group) => group.split("&&")
        .map(parseTerm)
        .filter((term): term is SearchTerm => term !== undefined))
      .filter((group) => group.length > 0)
    : [];

  // Rule: 沿用 logcat 的草稿语义，忽略空项；没有有效项时搜索完整字面文本。
  const highlightTerms = groups.length > 0
    ? [...new Set(groups.flatMap((group) => group.filter((term) => !term.negated).map((term) => term.needle)))]
    : normalized ? [normalized] : [];

  function matches(text: string): boolean {
    const lower = text.toLowerCase();
    if (groups.length === 0) return lower.includes(normalized);
    return groups.some((group) => group.every((term) => {
      const matched = lower.includes(term.needle);
      return term.negated ? !matched : matched;
    }));
  }

  return { matches, highlightTerms };
}

function parseTerm(value: string): SearchTerm | undefined {
  let needle = value.trim();
  let negated = false;
  while (needle.startsWith("-")) {
    negated = !negated;
    needle = needle.slice(1).trim();
  }
  return needle ? { needle, negated } : undefined;
}
