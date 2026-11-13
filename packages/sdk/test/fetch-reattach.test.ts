import { describe, expect, it } from "vitest";
import { attachFetchLogger } from "../src/fetch.js";
import type { Logger } from "../src/types.js";

function recorder() {
  const events: { level: string; data: any }[] = [];
  let enabled = true;
  const logger = {
    context: { sessionId: "same-session" },
    getStatus: () => ({ enabled }),
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    record: (_source: string, level: string, data: unknown) =>
      events.push({ level, data }),
  } as unknown as Logger & { setEnabled: (value: boolean) => void };
  return { logger, events };
}

it("reattach assigns unique request IDs even when an old response arrives late", async () => {
  const pending: ((response: Response) => void)[] = [];
  const target = {
    fetch: (() =>
      new Promise<Response>((resolve) =>
        pending.push(resolve),
      )) as typeof fetch,
  };
  const { logger, events } = recorder();
  const detachFirst = attachFetchLogger(logger, target);
  const first = target.fetch("https://business.test/first");
  detachFirst();
  logger.setEnabled(false);
  const late = pending.shift()!(
    new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
    }),
  );
  await first;
  await late;
  logger.setEnabled(true);
  const detachSecond = attachFetchLogger(logger, target);
  const second = target.fetch("https://business.test/second");
  pending.shift()!(
    new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
    }),
  );
  await second;
  await new Promise((resolve) => setTimeout(resolve, 0));
  detachSecond();
  const requestIds = events
    .filter((event) => event.data.phase === "request")
    .map((event) => event.data.requestId);
  expect(requestIds).toHaveLength(2);
  expect(new Set(requestIds).size).toBe(2);
});
