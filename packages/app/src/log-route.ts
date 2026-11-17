export function parseLogRoute(pathname: string): {
  index: number;
  source: "console" | "http" | "error";
  search: string;
} | undefined {
  const match = /(?:^|\/)(console|interface|error)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return undefined;
  try {
    return {
      index: match.index,
      source: match[1] === "interface" ? "http" : match[1] as "console" | "error",
      search: decodeURIComponent(match[2] ?? ""),
    };
  } catch {
    return undefined;
  }
}
