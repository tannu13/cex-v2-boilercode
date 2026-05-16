import "dotenv/config";
import { createClient } from "redis";
import { env } from "./utils/env.js";
import { createExchangeStore } from "./store/exchange-store.js";
import { createEngine } from "./engine.js";
import type { EngineRequest, EngineResponse } from "./types.js";

const brokerClient = createClient({ url: env.redisUrl }).on(
  "error",
  (error) => {
    console.error("Redis broker client error", error);
  },
);

const responseClient = createClient({ url: env.redisUrl }).on(
  "error",
  (error) => {
    console.error("Redis response client error", error);
  },
);

await Promise.all([brokerClient.connect(), responseClient.connect()]);

async function sendResponse(
  responseQueue: string,
  response: EngineResponse,
): Promise<void> {
  await responseClient.lPush(responseQueue, JSON.stringify(response));
}

/*
function getBestAsk(symbol: string) {
  const orderbook = ORDERBOOKS.get(symbol);
  if (!orderbook) return null;

  const bestAsk = orderbook.asks.entries().next().value;
  if (!bestAsk) return null;

  return {
    price: bestAsk[0],
    orders: bestAsk[1],
  };
}

function getBestBid(symbol: string) {
  const orderbook = ORDERBOOKS.get(symbol);
  if (!orderbook) return null;

  const bestBid = orderbook.bids.entries().next().value;
  if (!bestBid) return null;

  return {
    price: bestBid[0],
    orders: bestBid[1],
  };
}
*/

console.log(`Engine listening on Redis queue: ${env.incomingQueue}`);

const store = createExchangeStore();
const engine = createEngine(store);

for (;;) {
  const item = await brokerClient.brPop(env.incomingQueue, 0);
  if (!item) continue;

  let message: EngineRequest;

  try {
    message = JSON.parse(item.element) as EngineRequest;
  } catch {
    console.error("Skipping invalid broker message");
    continue;
  }

  try {
    const data = engine.handle(message);
    await sendResponse(message.responseQueue, {
      correlationId: message.correlationId,
      ok: true,
      data,
    });
  } catch (error) {
    await sendResponse(message.responseQueue, {
      correlationId: message.correlationId,
      ok: false,
      error: error instanceof Error ? error.message : "engine_error",
    });
  }
}
