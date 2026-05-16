import { describe, expect, it } from "vitest";
import {
  createExchangeStore,
  type CreateOrderInput,
} from "../src/store/exchange-store";
import { createEngine } from "../src/engine";
import type { EngineRequest } from "../src/types";

const userId = crypto.randomUUID();
describe("engine - create_order", () => {
  it("should create an order on the orderbook", () => {
    const store = createExchangeStore();
    const engine = createEngine(store);

    const payload: CreateOrderInput = {
      userId,
      type: "limit",
      side: "buy",
      symbol: "SOL",
      price: 10,
      qty: 5,
    };
    const response = engine.handle({
      type: "create_order",
      payload: payload as unknown as Record<string, unknown>,
      correlationId: "NA",
      responseQueue: "NA",
    });

    expect(response).toMatchObject({
      orderId: expect.any(String),
      status: "open",
      filledQty: 0,
      averagePrice: expect.any(Number),
      fills: [],
    });
  });
});
