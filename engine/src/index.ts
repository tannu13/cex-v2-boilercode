import "dotenv/config";
import { createClient } from "redis";
import { env } from "./utils/env.js";
import {
  BALANCES,
  FILLS,
  ORDERBOOKS,
  ORDERS,
  PRIMARY_CURRENCY,
  SUPPORTED_SYMBOLS,
  type Balance,
  type CreateOrderInput,
  type DepthResponse,
  type Fill,
  type OrderRecord,
  type RestingOrder,
} from "./store/exchange-store.js";

export type EngineCommandType =
  | "init_user_balance"
  | "create_order"
  | "get_depth"
  | "get_user_balance"
  | "get_order"
  | "cancel_order";

export interface EngineRequest {
  correlationId: string;
  responseQueue: string;
  type: EngineCommandType;
  payload: Record<string, unknown>;
}

export interface EngineResponse {
  correlationId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

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

// :-)) I added this just to check the flow, remove it when you start
const DUMMY_SELL_ORDER = {
  orderId: "dummy-sell-order-1",
  userId: "dummy-seller",
  type: "limit",
  side: "sell",
  symbol: "BTC",
  price: 100,
  qty: 1,
  filledQty: 0,
  status: "open",
};

async function sendResponse(
  responseQueue: string,
  response: EngineResponse,
): Promise<void> {
  await responseClient.lPush(responseQueue, JSON.stringify(response));
}

function getInitDUMMYBalancesForUser(userId: string) {
  const initialBalances = Object.fromEntries(
    SUPPORTED_SYMBOLS.map((s) => [s, { available: 100, locked: 0 }]),
  );
  initialBalances[PRIMARY_CURRENCY] = { available: 100, locked: 0 };
  return initialBalances;
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

function getNextBestAskPrice(symbol: string, startFrom: number = -1) {
  const orderbook = ORDERBOOKS.get(symbol);
  if (!orderbook) return null;

  let minPrice = Infinity;
  for (const price of orderbook.asks.keys()) {
    if (!orderbook.asks.get(price)) continue;
    if (price > startFrom && price < minPrice) {
      minPrice = price;
    }
  }

  return minPrice === Infinity ? null : minPrice;
}

function getNextBestBidPrice(symbol: string, startFrom: number = Infinity) {
  const orderbook = ORDERBOOKS.get(symbol);
  if (!orderbook) return null;

  let maxPrice = -Infinity;
  for (const price of orderbook.bids.keys()) {
    if (!orderbook.bids.get(price)) continue;
    if (price < startFrom && price > maxPrice) {
      maxPrice = price;
    }
  }

  return maxPrice === -Infinity ? null : maxPrice;
}

function handleEngineRequest(message: EngineRequest): unknown {
  /**
   * TODO(student):
   * 1. Check _message.type.
   * 2. Read _message.payload.
   * 3. Call your order book / balance / order logic.
   * 4. Return the data that should go back to the backend.
   *
   * Required message types:
   * - create_order
   * - get_depth
   * - get_user_balance
   * - get_order
   * - cancel_order
   */

  // just checking the flow, remove this when you start implementing the logic
  if (message.type === "init_user_balance") {
    const { id: userId } = message.payload;
    const initialUserBalances = getInitDUMMYBalancesForUser(userId as string);
    BALANCES.set(userId as string, initialUserBalances);
    return;
  }
  if (message.type === "create_order") {
    const { userId, type, side, symbol, price, qty } =
      message.payload as unknown as CreateOrderInput;
    const orderbook = ORDERBOOKS.get(symbol);
    if (!orderbook) {
      throw new Error(`Orderbook does not exist for symbol ${symbol}`);
    }

    // seed if user non-exstent on the BALANCES
    let userBalance = BALANCES.get(userId);
    if (!userBalance) {
      // ideally error would be thrown from here as user should have got the balances
      const initialUserBalances = getInitDUMMYBalancesForUser(userId);
      BALANCES.set(userId as string, initialUserBalances);
      userBalance = initialUserBalances;
    }

    const currentOrderId = crypto.randomUUID();

    if (type === "limit" && price) {
      // check + lock balance (INR for BUY, stock for SELL)
      // lock balance wud only happen for limit orders as market orders get either filled or cancelled
      if (side === "buy") {
        let bestAskPrice = getNextBestAskPrice(symbol);

        const totalPrice = price * qty;
        if (
          !userBalance[PRIMARY_CURRENCY] ||
          Number(userBalance[PRIMARY_CURRENCY]?.available) < totalPrice
        ) {
          throw new Error("User has insufficient balance");
        }
        let remainingQty = qty;
        while (remainingQty > 0 && bestAskPrice && bestAskPrice <= price) {
          const ordersAtPrice = orderbook.asks.get(
            bestAskPrice,
          ) as RestingOrder[]; // this'll always be there because i got the bestAskPrice from asks

          for (let i = ordersAtPrice.length - 1; i >= 0; i--) {
            const restingOrder = ordersAtPrice[i]!;
            const availableQty = restingOrder.qty - restingOrder.filledQty;
            if (availableQty > remainingQty) {
              // the current order can be filled - restingOrder is partially filled
              const fillId = crypto.randomUUID();
              const fill: Fill = {
                fillId,
                symbol,
                price: bestAskPrice,
                qty: remainingQty,
                buyOrderId: currentOrderId,
                sellOrderId: restingOrder.orderId,
                createdAt: new Date().getTime(),
              };

              let currentOrder = ORDERS.get(currentOrderId);
              if (!currentOrder) {
                currentOrder = {
                  orderId: currentOrderId,
                  userId,
                  side,
                  type,
                  symbol,
                  price: bestAskPrice,
                  qty: remainingQty,
                  filledQty: remainingQty,
                  status: "filled",
                  fills: [fill],
                  createdAt: new Date().getTime(),
                } satisfies OrderRecord;
              } else {
                currentOrder.filledQty += remainingQty;
                currentOrder.status = "filled";
                currentOrder.fills.push(fill);
              }
              ORDERS.set(currentOrderId, currentOrder);

              restingOrder.filledQty += remainingQty;
              restingOrder.status = "partially_filled";

              const restingOrderRecord = ORDERS.get(restingOrder.orderId);
              if (!restingOrderRecord) {
                // think this will never or should never happen
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrder,
                  fills: [fill],
                });
              } else {
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrderRecord,
                  status: "partially_filled",
                  filledQty: restingOrder.filledQty,
                  fills: [...restingOrderRecord.fills, fill],
                });
              }

              FILLS.push(fill);

              // deduct currency & add symbol qty from buyer
              const priceForFilledQty = fill.qty * bestAskPrice;
              userBalance[PRIMARY_CURRENCY] = {
                available:
                  userBalance[PRIMARY_CURRENCY].available - priceForFilledQty,
                locked: userBalance[PRIMARY_CURRENCY].locked,
              };
              userBalance[symbol] = {
                available: Number(userBalance[symbol]?.available) + fill.qty,
                locked: userBalance[symbol]?.locked || 0,
              };

              const sellerUserId = ORDERS.get(restingOrder.orderId)?.userId!;
              const sellerBalance = BALANCES.get(sellerUserId)!;
              // td:: how / if to handle if sellerUserId or sellerBalance is missing

              // add currency & deduct symbol qty from seller
              sellerBalance[PRIMARY_CURRENCY] = {
                available:
                  Number(sellerBalance[PRIMARY_CURRENCY]?.available) +
                  priceForFilledQty,
                locked: sellerBalance[PRIMARY_CURRENCY]?.locked || 0,
              };
              sellerBalance[symbol] = {
                available: Number(sellerBalance[symbol]?.available),
                locked: sellerBalance[symbol]?.locked! - fill.qty,
              };

              remainingQty = 0;
              break;
            } else if (availableQty === remainingQty) {
              // the current order can be filled - restingOrder is filled
              const fillId = crypto.randomUUID();
              const fill: Fill = {
                fillId,
                symbol,
                price: bestAskPrice,
                qty: remainingQty,
                buyOrderId: currentOrderId,
                sellOrderId: restingOrder.orderId,
                createdAt: new Date().getTime(),
              };

              let currentOrder = ORDERS.get(currentOrderId);
              if (!currentOrder) {
                currentOrder = {
                  orderId: currentOrderId,
                  userId,
                  side,
                  type,
                  symbol,
                  price: bestAskPrice,
                  qty: remainingQty,
                  filledQty: remainingQty,
                  status: "filled",
                  fills: [fill],
                  createdAt: new Date().getTime(),
                } satisfies OrderRecord;
              } else {
                currentOrder.filledQty += remainingQty;
                currentOrder.status = "filled";
                currentOrder.fills.push(fill);
              }
              ORDERS.set(currentOrderId, currentOrder);

              restingOrder.filledQty += remainingQty;
              restingOrder.status = "filled";

              const restingOrderRecord = ORDERS.get(restingOrder.orderId);
              if (!restingOrderRecord) {
                // think this will never or should never happen
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrder,
                  fills: [fill],
                });
              } else {
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrderRecord,
                  status: "filled",
                  filledQty: restingOrder.filledQty,
                  fills: [...restingOrderRecord.fills, fill],
                });
              }

              FILLS.push(fill);

              // deduct currency & add symbol qty from buyer
              const priceForFilledQty = fill.qty * bestAskPrice;
              userBalance[PRIMARY_CURRENCY] = {
                available:
                  userBalance[PRIMARY_CURRENCY].available - priceForFilledQty,
                locked: userBalance[PRIMARY_CURRENCY].locked,
              };
              userBalance[symbol] = {
                available: Number(userBalance[symbol]?.available) + fill.qty,
                locked: userBalance[symbol]?.locked || 0,
              };

              const sellerUserId = ORDERS.get(restingOrder.orderId)?.userId!;
              const sellerBalance = BALANCES.get(sellerUserId)!;

              // add currency & deduct symbol qty from seller
              sellerBalance[PRIMARY_CURRENCY] = {
                available:
                  Number(sellerBalance[PRIMARY_CURRENCY]?.available) +
                  priceForFilledQty,
                locked: sellerBalance[PRIMARY_CURRENCY]?.locked || 0,
              };
              sellerBalance[symbol] = {
                available: Number(sellerBalance[symbol]?.available),
                locked: sellerBalance[symbol]?.locked! - fill.qty,
              };

              remainingQty = 0;

              // move filled restingOrder out of orderbooks when they are filled
              if (restingOrder.status === "filled") {
                ordersAtPrice.splice(i, 1);
                if (ordersAtPrice.length <= 0) {
                  orderbook.asks.delete(bestAskPrice);
                }
              }
              break;
            } else {
              // availableQty < remainingQty
              remainingQty -= availableQty;
              // the current order can be partially filled - restingOrder is filled
              const fillId = crypto.randomUUID();
              const fill: Fill = {
                fillId,
                symbol,
                price: bestAskPrice,
                qty: availableQty,
                buyOrderId: currentOrderId,
                sellOrderId: restingOrder.orderId,
                createdAt: new Date().getTime(),
              };

              let currentOrder = ORDERS.get(currentOrderId);
              if (!currentOrder) {
                currentOrder = {
                  orderId: currentOrderId,
                  userId,
                  side,
                  type,
                  symbol,
                  price: bestAskPrice,
                  qty: qty,
                  filledQty: availableQty,
                  status: "partially_filled",
                  fills: [fill],
                  createdAt: new Date().getTime(),
                } satisfies OrderRecord;
              } else {
                currentOrder.filledQty += availableQty;
                currentOrder.status = "partially_filled";
                currentOrder.fills.push(fill);
              }
              ORDERS.set(currentOrderId, currentOrder);

              restingOrder.filledQty += availableQty;
              restingOrder.status = "filled";

              const restingOrderRecord = ORDERS.get(restingOrder.orderId);
              if (!restingOrderRecord) {
                // think this will never or should never happen
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrder,
                  fills: [fill],
                });
              } else {
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrderRecord,
                  status: "filled",
                  filledQty: restingOrder.filledQty,
                  fills: [...restingOrderRecord.fills, fill],
                });
              }

              FILLS.push(fill);

              // td:: this is getting repeated in above conditionals 2 times. only fill.qty is different
              const priceForFilledQty = fill.qty * bestAskPrice;
              userBalance[PRIMARY_CURRENCY] = {
                available:
                  userBalance[PRIMARY_CURRENCY].available - priceForFilledQty,
                locked: userBalance[PRIMARY_CURRENCY].locked,
              };
              userBalance[symbol] = {
                available: Number(userBalance[symbol]?.available) + fill.qty,
                locked: userBalance[symbol]?.locked || 0,
              };

              const sellerUserId = ORDERS.get(restingOrder.orderId)?.userId!;
              const sellerBalance = BALANCES.get(sellerUserId)!;

              // add currency & deduct symbol qty from seller
              sellerBalance[PRIMARY_CURRENCY] = {
                available:
                  Number(sellerBalance[PRIMARY_CURRENCY]?.available) +
                  priceForFilledQty,
                locked: sellerBalance[PRIMARY_CURRENCY]?.locked || 0,
              };
              sellerBalance[symbol] = {
                available: Number(sellerBalance[symbol]?.available),
                locked: sellerBalance[symbol]?.locked! - fill.qty,
              };

              // move filled restingOrder out of orderbooks when they are filled
              if (restingOrder.status === "filled") {
                ordersAtPrice.splice(i, 1);
                if (ordersAtPrice.length <= 0) {
                  orderbook.asks.delete(bestAskPrice);
                }
              }
            }
          }

          // get the next bestAskPrice
          bestAskPrice = getNextBestAskPrice(symbol, bestAskPrice);
        }

        if (remainingQty > 0) {
          const filledQty = qty - remainingQty;
          const currentOrder = {
            orderId: currentOrderId,
            userId,
            side,
            type,
            symbol,
            price,
            qty,
            filledQty,
            status: filledQty === 0 ? "open" : "partially_filled",
            createdAt: new Date().getTime(),
          } satisfies RestingOrder;
          // add the bid to order book
          const availableBids = orderbook.bids.get(price);
          // push the current bid to the order book as there are no asks matching given price
          if (!availableBids) {
            orderbook.bids.set(price, [currentOrder]);
          } else {
            availableBids.push(currentOrder);
          }

          if (filledQty === 0) {
            // pushing only the open orders, as any other type wud have been pushed from inside the for loop
            ORDERS.set(currentOrderId, {
              ...currentOrder,
              fills: [],
            });
          }

          // lock user balance for remainingQty
          const remainingTotalPrice = price * remainingQty;
          userBalance[PRIMARY_CURRENCY] = {
            available:
              userBalance[PRIMARY_CURRENCY].available - remainingTotalPrice,
            locked: userBalance[PRIMARY_CURRENCY].locked + remainingTotalPrice,
          };
        }
      } else if (side === "sell") {
        let bestBidPrice = getNextBestBidPrice(symbol);

        if (
          !userBalance[symbol] ||
          Number(userBalance[symbol]?.available) < qty
        ) {
          throw new Error("User has insufficient balance");
        }

        let remainingQty = qty;
        while (remainingQty > 0 && bestBidPrice && bestBidPrice >= price) {
          const ordersAtPrice = orderbook.bids.get(
            bestBidPrice,
          ) as RestingOrder[]; // this'll always be there because i got the bestBidPrice from bids

          for (let i = ordersAtPrice.length - 1; i >= 0; i--) {
            const restingOrder = ordersAtPrice[i]!;
            const availableQty = restingOrder.qty - restingOrder.filledQty;
            if (availableQty > remainingQty) {
              // the current order can be filled - restingOrder is partially filled
              const fillId = crypto.randomUUID();
              const fill: Fill = {
                fillId,
                symbol,
                price: bestBidPrice,
                qty: remainingQty,
                buyOrderId: restingOrder.orderId,
                sellOrderId: currentOrderId,
                createdAt: new Date().getTime(),
              };

              let currentOrder = ORDERS.get(currentOrderId);
              if (!currentOrder) {
                currentOrder = {
                  orderId: currentOrderId,
                  userId,
                  side,
                  type,
                  symbol,
                  price: bestBidPrice,
                  qty: remainingQty,
                  filledQty: remainingQty,
                  status: "filled",
                  fills: [fill],
                  createdAt: new Date().getTime(),
                } satisfies OrderRecord;
              } else {
                currentOrder.filledQty += remainingQty;
                currentOrder.status = "filled";
                currentOrder.fills.push(fill);
              }
              ORDERS.set(currentOrderId, currentOrder);

              restingOrder.filledQty += remainingQty;
              restingOrder.status = "partially_filled";

              const restingOrderRecord = ORDERS.get(restingOrder.orderId);
              if (!restingOrderRecord) {
                // think this will never or should never happen
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrder,
                  fills: [fill],
                });
              } else {
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrderRecord,
                  status: "partially_filled",
                  filledQty: restingOrder.filledQty,
                  fills: [...restingOrderRecord.fills, fill],
                });
              }

              FILLS.push(fill);

              // add currency & deduct symbol qty from seller
              const priceForFilledQty = fill.qty * bestBidPrice;
              userBalance[PRIMARY_CURRENCY] = {
                available:
                  Number(userBalance[PRIMARY_CURRENCY]?.available) +
                  priceForFilledQty,
                locked: userBalance[PRIMARY_CURRENCY]?.locked || 0,
              };
              userBalance[symbol] = {
                available: Number(userBalance[symbol].available),
                locked: userBalance[symbol].locked - fill.qty,
              };

              const buyerUserId = ORDERS.get(restingOrder.orderId)?.userId!;
              const buyerBalance = BALANCES.get(buyerUserId)!;
              // td:: how / if to handle if buyerUserId or buyerBalance is missing

              // deduct currency & add symbol qty from buyer
              buyerBalance[PRIMARY_CURRENCY] = {
                available:
                  Number(buyerBalance[PRIMARY_CURRENCY]?.available) -
                  priceForFilledQty,
                locked: Number(buyerBalance[PRIMARY_CURRENCY]?.locked),
              };
              buyerBalance[symbol] = {
                available: Number(buyerBalance[symbol]?.available) + fill.qty,
                locked: buyerBalance[symbol]?.locked || 0,
              };

              remainingQty = 0;
              break;
            } else if (availableQty === remainingQty) {
              // the current order can be filled - restingOrder is filled
              const fillId = crypto.randomUUID();
              const fill: Fill = {
                fillId,
                symbol,
                price: bestBidPrice,
                qty: remainingQty,
                buyOrderId: restingOrder.orderId,
                sellOrderId: currentOrderId,
                createdAt: new Date().getTime(),
              };

              let currentOrder = ORDERS.get(currentOrderId);
              if (!currentOrder) {
                currentOrder = {
                  orderId: currentOrderId,
                  userId,
                  side,
                  type,
                  symbol,
                  price: bestBidPrice,
                  qty: remainingQty,
                  filledQty: remainingQty,
                  status: "filled",
                  fills: [fill],
                  createdAt: new Date().getTime(),
                } satisfies OrderRecord;
              } else {
                currentOrder.filledQty += remainingQty;
                currentOrder.status = "filled";
                currentOrder.fills.push(fill);
              }
              ORDERS.set(currentOrderId, currentOrder);

              restingOrder.filledQty += remainingQty;
              restingOrder.status = "filled";

              const restingOrderRecord = ORDERS.get(restingOrder.orderId);
              if (!restingOrderRecord) {
                // think this will never or should never happen
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrder,
                  fills: [fill],
                });
              } else {
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrderRecord,
                  status: "filled",
                  filledQty: restingOrder.filledQty,
                  fills: [...restingOrderRecord.fills, fill],
                });
              }

              FILLS.push(fill);

              // add currency & deduct symbol qty from seller
              const priceForFilledQty = fill.qty * bestBidPrice;
              userBalance[PRIMARY_CURRENCY] = {
                available:
                  Number(userBalance[PRIMARY_CURRENCY]?.available) +
                  priceForFilledQty,
                locked: userBalance[PRIMARY_CURRENCY]?.locked || 0,
              };
              userBalance[symbol] = {
                available: Number(userBalance[symbol].available),
                locked: userBalance[symbol].locked - fill.qty,
              };

              const buyerUserId = ORDERS.get(restingOrder.orderId)?.userId!;
              const buyerBalance = BALANCES.get(buyerUserId)!;
              // td:: how / if to handle if buyerUserId or buyerBalance is missing

              // deduct currency & add symbol qty from buyer
              buyerBalance[PRIMARY_CURRENCY] = {
                available:
                  Number(buyerBalance[PRIMARY_CURRENCY]?.available) -
                  priceForFilledQty,
                locked:
                  Number(buyerBalance[PRIMARY_CURRENCY]?.locked) -
                  priceForFilledQty,
              };
              buyerBalance[symbol] = {
                available: Number(buyerBalance[symbol]?.available) + fill.qty,
                locked: buyerBalance[symbol]?.locked || 0,
              };

              remainingQty = 0;

              // move filled restingOrder out of orderbooks when they are filled
              if (restingOrder.status === "filled") {
                ordersAtPrice.splice(i, 1);
                if (ordersAtPrice.length <= 0) {
                  orderbook.bids.delete(bestBidPrice);
                }
              }
              break;
            } else {
              // availableQty < remainingQty
              remainingQty -= availableQty;
              // the current order can be partially filled - restingOrder is filled
              const fillId = crypto.randomUUID();
              const fill: Fill = {
                fillId,
                symbol,
                price: bestBidPrice,
                qty: availableQty,
                buyOrderId: restingOrder.orderId,
                sellOrderId: currentOrderId,
                createdAt: new Date().getTime(),
              };

              let currentOrder = ORDERS.get(currentOrderId);
              if (!currentOrder) {
                currentOrder = {
                  orderId: currentOrderId,
                  userId,
                  side,
                  type,
                  symbol,
                  price: bestBidPrice,
                  qty: qty,
                  filledQty: availableQty,
                  status: "partially_filled",
                  fills: [fill],
                  createdAt: new Date().getTime(),
                } satisfies OrderRecord;
              } else {
                currentOrder.filledQty += availableQty;
                currentOrder.status = "partially_filled";
                currentOrder.fills.push(fill);
              }
              ORDERS.set(currentOrderId, currentOrder);

              restingOrder.filledQty += availableQty;
              restingOrder.status = "filled";

              const restingOrderRecord = ORDERS.get(restingOrder.orderId);
              if (!restingOrderRecord) {
                // think this will never or should never happen
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrder,
                  fills: [fill],
                });
              } else {
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrderRecord,
                  status: "filled",
                  filledQty: restingOrder.filledQty,
                  fills: [...restingOrderRecord.fills, fill],
                });
              }

              FILLS.push(fill);

              // td:: this is getting repeated in above conditionals 2 times. only fill.qty is different
              // add currency & deduct symbol qty from seller
              const priceForFilledQty = fill.qty * bestBidPrice;
              userBalance[PRIMARY_CURRENCY] = {
                available:
                  Number(userBalance[PRIMARY_CURRENCY]?.available) +
                  priceForFilledQty,
                locked: userBalance[PRIMARY_CURRENCY]?.locked || 0,
              };
              userBalance[symbol] = {
                available: Number(userBalance[symbol].available),
                locked: userBalance[symbol].locked - fill.qty,
              };

              const buyerUserId = ORDERS.get(restingOrder.orderId)?.userId!;
              const buyerBalance = BALANCES.get(buyerUserId)!;
              // td:: how / if to handle if buyerUserId or buyerBalance is missing

              // deduct currency & add symbol qty from buyer
              buyerBalance[PRIMARY_CURRENCY] = {
                available:
                  Number(buyerBalance[PRIMARY_CURRENCY]?.available) -
                  priceForFilledQty,
                locked: Number(buyerBalance[PRIMARY_CURRENCY]?.locked),
              };
              buyerBalance[symbol] = {
                available: Number(buyerBalance[symbol]?.available) + fill.qty,
                locked: buyerBalance[symbol]?.locked || 0,
              };

              // move filled restingOrder out of orderbooks when they are filled
              if (restingOrder.status === "filled") {
                ordersAtPrice.splice(i, 1);
                if (ordersAtPrice.length <= 0) {
                  orderbook.bids.delete(bestBidPrice);
                }
              }
            }
          }

          // get the next bestBidPrice
          bestBidPrice = getNextBestBidPrice(symbol, bestBidPrice);
        }

        if (remainingQty > 0) {
          // add the bid to order book
          const filledQty = qty - remainingQty;
          const currentOrder = {
            orderId: currentOrderId,
            userId,
            side,
            type,
            symbol,
            price,
            qty,
            filledQty,
            status: filledQty === 0 ? "open" : "partially_filled",
            createdAt: new Date().getTime(),
          } satisfies RestingOrder;
          const availableAsks = orderbook.asks.get(price);
          if (!availableAsks) {
            orderbook.asks.set(price, [currentOrder]);
          } else {
            availableAsks.push(currentOrder);
          }

          if (filledQty === 0) {
            // pushing only the open orders, as any other type wud have been pushed from inside the for loop
            ORDERS.set(currentOrderId, {
              ...currentOrder,
              fills: [],
            });
          }

          // lock user balance for remainingQty
          userBalance[symbol] = {
            available: userBalance[symbol].available - remainingQty,
            locked: userBalance[symbol].locked + remainingQty,
          };
        }
      }
    } else if (type === "market") {
      if (side === "buy") {
        let bestAskPrice = getNextBestAskPrice(symbol);

        if (!bestAskPrice) {
          throw new Error("No available asks");
        }

        const totalPrice = bestAskPrice * qty;
        if (
          !userBalance[PRIMARY_CURRENCY] ||
          Number(userBalance[PRIMARY_CURRENCY]?.available) < totalPrice
        ) {
          // td:: this seems dodgy as the bestAskPrice right now might not have the available qty to match and then more funds might be needed at higher prices. in that case throwing might not be ideal as some might be settled. think more...
          throw new Error("User has insufficient balance");
        }

        // td:: update balance updation logic as it does not refund on cancellation the full amount as at that point the bestAskPrice could be different
        userBalance[PRIMARY_CURRENCY] = {
          available: userBalance[PRIMARY_CURRENCY].available - totalPrice,
          locked: userBalance[PRIMARY_CURRENCY].locked + totalPrice,
        };

        let remainingQty = qty;
        while (remainingQty > 0 && bestAskPrice) {
          const ordersAtPrice = orderbook.asks.get(
            bestAskPrice,
          ) as RestingOrder[];
          for (let i = ordersAtPrice.length - 1; i >= 0; i--) {
            const restingOrder = ordersAtPrice[i]!;
            const availableQty = restingOrder.qty - restingOrder.filledQty;
            if (availableQty > remainingQty) {
              // the current order can be filled - restingOrder is partially filled
              const fillId = crypto.randomUUID();
              const fill: Fill = {
                fillId,
                symbol,
                price: bestAskPrice,
                qty: remainingQty,
                buyOrderId: currentOrderId,
                sellOrderId: restingOrder.orderId,
                createdAt: new Date().getTime(),
              };

              let currentOrder = ORDERS.get(currentOrderId);
              if (!currentOrder) {
                currentOrder = {
                  orderId: currentOrderId,
                  userId,
                  side,
                  type,
                  symbol,
                  price: bestAskPrice,
                  qty: remainingQty,
                  filledQty: remainingQty,
                  status: "filled",
                  fills: [fill],
                  createdAt: new Date().getTime(),
                } satisfies OrderRecord;
              } else {
                currentOrder.filledQty += remainingQty;
                currentOrder.status = "filled";
                currentOrder.fills.push(fill);
              }
              ORDERS.set(currentOrderId, currentOrder);

              restingOrder.filledQty += remainingQty;
              restingOrder.status = "partially_filled";

              const restingOrderRecord = ORDERS.get(restingOrder.orderId);
              if (!restingOrderRecord) {
                // think this will never or should never happen
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrder,
                  fills: [fill],
                });
              } else {
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrderRecord,
                  status: "partially_filled",
                  filledQty: restingOrder.filledQty,
                  fills: [...restingOrderRecord.fills, fill],
                });
              }

              FILLS.push(fill);

              // deduct currency & add symbol qty from buyer
              const priceForFilledQty = fill.qty * bestAskPrice;
              userBalance[PRIMARY_CURRENCY] = {
                available: userBalance[PRIMARY_CURRENCY].available,
                locked:
                  userBalance[PRIMARY_CURRENCY].locked - priceForFilledQty,
              };
              userBalance[symbol] = {
                available: Number(userBalance[symbol]?.available) + fill.qty,
                locked: userBalance[symbol]?.locked || 0,
              };

              const sellerUserId = ORDERS.get(restingOrder.orderId)?.userId!;
              const sellerBalance = BALANCES.get(sellerUserId)!;
              // td:: how / if to handle if sellerUserId or sellerBalance is missing

              // add currency & deduct symbol qty from seller
              sellerBalance[PRIMARY_CURRENCY] = {
                available:
                  Number(sellerBalance[PRIMARY_CURRENCY]?.available) +
                  priceForFilledQty,
                locked: sellerBalance[PRIMARY_CURRENCY]?.locked || 0,
              };
              sellerBalance[symbol] = {
                available: Number(sellerBalance[symbol]?.available),
                locked: sellerBalance[symbol]?.locked! - fill.qty,
              };

              remainingQty = 0;
              break;
            } else if (availableQty === remainingQty) {
              // the current order can be filled - restingOrder is filled
              const fillId = crypto.randomUUID();
              const fill: Fill = {
                fillId,
                symbol,
                price: bestAskPrice,
                qty: remainingQty,
                buyOrderId: currentOrderId,
                sellOrderId: restingOrder.orderId,
                createdAt: new Date().getTime(),
              };

              let currentOrder = ORDERS.get(currentOrderId);
              if (!currentOrder) {
                currentOrder = {
                  orderId: currentOrderId,
                  userId,
                  side,
                  type,
                  symbol,
                  price: bestAskPrice,
                  qty: remainingQty,
                  filledQty: remainingQty,
                  status: "filled",
                  fills: [fill],
                  createdAt: new Date().getTime(),
                } satisfies OrderRecord;
              } else {
                currentOrder.filledQty += remainingQty;
                currentOrder.status = "filled";
                currentOrder.fills.push(fill);
              }
              ORDERS.set(currentOrderId, currentOrder);

              restingOrder.filledQty += remainingQty;
              restingOrder.status = "filled";

              const restingOrderRecord = ORDERS.get(restingOrder.orderId);
              if (!restingOrderRecord) {
                // think this will never or should never happen
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrder,
                  fills: [fill],
                });
              } else {
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrderRecord,
                  status: "filled",
                  filledQty: restingOrder.filledQty,
                  fills: [...restingOrderRecord.fills, fill],
                });
              }

              FILLS.push(fill);

              // deduct currency & add symbol qty from buyer
              const priceForFilledQty = fill.qty * bestAskPrice;
              userBalance[PRIMARY_CURRENCY] = {
                available: userBalance[PRIMARY_CURRENCY].available,
                locked:
                  userBalance[PRIMARY_CURRENCY].locked - priceForFilledQty,
              };
              userBalance[symbol] = {
                available: Number(userBalance[symbol]?.available) + fill.qty,
                locked: userBalance[symbol]?.locked || 0,
              };

              const sellerUserId = ORDERS.get(restingOrder.orderId)?.userId!;
              const sellerBalance = BALANCES.get(sellerUserId)!;

              // add currency & deduct symbol qty from seller
              sellerBalance[PRIMARY_CURRENCY] = {
                available:
                  Number(sellerBalance[PRIMARY_CURRENCY]?.available) +
                  priceForFilledQty,
                locked: sellerBalance[PRIMARY_CURRENCY]?.locked || 0,
              };
              sellerBalance[symbol] = {
                available: Number(sellerBalance[symbol]?.available),
                locked: sellerBalance[symbol]?.locked! - fill.qty,
              };

              remainingQty = 0;

              // move filled restingOrder out of orderbooks when they are filled
              if (restingOrder.status === "filled") {
                ordersAtPrice.splice(i, 1);
                if (ordersAtPrice.length <= 0) {
                  orderbook.asks.delete(bestAskPrice);
                }
              }
              break;
            } else {
              // availableQty < remainingQty
              remainingQty -= availableQty;
              // the current order can be partially filled - restingOrder is filled
              const fillId = crypto.randomUUID();
              const fill: Fill = {
                fillId,
                symbol,
                price: bestAskPrice,
                qty: availableQty,
                buyOrderId: currentOrderId,
                sellOrderId: restingOrder.orderId,
                createdAt: new Date().getTime(),
              };

              let currentOrder = ORDERS.get(currentOrderId);
              if (!currentOrder) {
                currentOrder = {
                  orderId: currentOrderId,
                  userId,
                  side,
                  type,
                  symbol,
                  price: bestAskPrice,
                  qty: qty,
                  filledQty: availableQty,
                  status: "partially_filled",
                  fills: [fill],
                  createdAt: new Date().getTime(),
                } satisfies OrderRecord;
              } else {
                currentOrder.filledQty += availableQty;
                currentOrder.status = "partially_filled";
                currentOrder.fills.push(fill);
              }
              ORDERS.set(currentOrderId, currentOrder);

              restingOrder.filledQty += availableQty;
              restingOrder.status = "filled";

              const restingOrderRecord = ORDERS.get(restingOrder.orderId);
              if (!restingOrderRecord) {
                // think this will never or should never happen
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrder,
                  fills: [fill],
                });
              } else {
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrderRecord,
                  status: "filled",
                  filledQty: restingOrder.filledQty,
                  fills: [...restingOrderRecord.fills, fill],
                });
              }

              FILLS.push(fill);

              // td:: this is getting repeated in above conditionals 2 times. only fill.qty is different
              // deduct currency & add symbol qty from buyer
              const priceForFilledQty = fill.qty * bestAskPrice;
              userBalance[PRIMARY_CURRENCY] = {
                available: userBalance[PRIMARY_CURRENCY].available,
                locked:
                  userBalance[PRIMARY_CURRENCY].locked - priceForFilledQty,
              };
              userBalance[symbol] = {
                available: Number(userBalance[symbol]?.available) + fill.qty,
                locked: userBalance[symbol]?.locked || 0,
              };

              const sellerUserId = ORDERS.get(restingOrder.orderId)?.userId!;
              const sellerBalance = BALANCES.get(sellerUserId)!;

              // add currency & deduct symbol qty from seller
              sellerBalance[PRIMARY_CURRENCY] = {
                available:
                  Number(sellerBalance[PRIMARY_CURRENCY]?.available) +
                  priceForFilledQty,
                locked: sellerBalance[PRIMARY_CURRENCY]?.locked || 0,
              };
              sellerBalance[symbol] = {
                available: Number(sellerBalance[symbol]?.available),
                locked: sellerBalance[symbol]?.locked! - fill.qty,
              };

              // move filled restingOrder out of orderbooks when they are filled
              if (restingOrder.status === "filled") {
                ordersAtPrice.splice(i, 1);
                if (ordersAtPrice.length <= 0) {
                  orderbook.asks.delete(bestAskPrice);
                }
              }
            }
          }

          // get the next bestAskPrice
          bestAskPrice = getNextBestAskPrice(symbol, bestAskPrice);
        }

        if (remainingQty > 0 && !bestAskPrice) {
          // there is nothing available, so cancel the order
          let currentOrder = ORDERS.get(currentOrderId);
          if (!currentOrder) {
            currentOrder = {
              orderId: currentOrderId,
              userId,
              side,
              type,
              symbol,
              price: 0,
              qty: remainingQty,
              filledQty: 0,
              status: "cancelled",
              fills: [],
              createdAt: new Date().getTime(),
            } satisfies OrderRecord;
          } else {
            currentOrder.status = "cancelled";
          }
          ORDERS.set(currentOrderId, currentOrder);
        }
      } else if (side === "sell") {
        if (
          !userBalance[symbol] ||
          Number(userBalance[symbol]?.available) < qty
        ) {
          throw new Error("User has insufficient balance");
        }
        userBalance[symbol] = {
          available: userBalance[symbol].available - qty,
          locked: userBalance[symbol].locked + qty,
        };

        let remainingQty = qty;
        let bestBidPrice = getNextBestBidPrice(symbol);

        while (remainingQty > 0 && bestBidPrice) {
          const ordersAtPrice = orderbook.bids.get(
            bestBidPrice,
          ) as RestingOrder[];

          for (let i = ordersAtPrice.length - 1; i >= 0; i--) {
            const restingOrder = ordersAtPrice[i]!;
            const availableQty = restingOrder.qty - restingOrder.filledQty;

            if (availableQty > remainingQty) {
              // the current order can be filled - restingOrder is partially filled
              const fillId = crypto.randomUUID();
              const fill: Fill = {
                fillId,
                symbol,
                price: bestBidPrice,
                qty: remainingQty,
                buyOrderId: restingOrder.orderId,
                sellOrderId: currentOrderId,
                createdAt: new Date().getTime(),
              };

              let currentOrder = ORDERS.get(currentOrderId);
              if (!currentOrder) {
                currentOrder = {
                  orderId: currentOrderId,
                  userId,
                  side,
                  type,
                  symbol,
                  price: bestBidPrice,
                  qty: remainingQty,
                  filledQty: remainingQty,
                  status: "filled",
                  fills: [fill],
                  createdAt: new Date().getTime(),
                } satisfies OrderRecord;
              } else {
                currentOrder.filledQty += remainingQty;
                currentOrder.status = "filled";
                currentOrder.fills.push(fill);
              }
              ORDERS.set(currentOrderId, currentOrder);

              restingOrder.filledQty += remainingQty;
              restingOrder.status = "partially_filled";

              const restingOrderRecord = ORDERS.get(restingOrder.orderId);
              if (!restingOrderRecord) {
                // think this will never or should never happen
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrder,
                  fills: [fill],
                });
              } else {
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrderRecord,
                  status: "partially_filled",
                  filledQty: restingOrder.filledQty,
                  fills: [...restingOrderRecord.fills, fill],
                });
              }

              FILLS.push(fill);

              // add currency & deduct symbol qty from seller
              const priceForFilledQty = fill.qty * bestBidPrice;
              userBalance[PRIMARY_CURRENCY] = {
                available:
                  Number(userBalance[PRIMARY_CURRENCY]?.available) +
                  priceForFilledQty,
                locked: userBalance[PRIMARY_CURRENCY]?.locked || 0,
              };
              userBalance[symbol] = {
                available: Number(userBalance[symbol].available),
                locked: userBalance[symbol].locked - fill.qty,
              };

              const buyerUserId = ORDERS.get(restingOrder.orderId)?.userId!;
              const buyerBalance = BALANCES.get(buyerUserId)!;
              // td:: how / if to handle if buyerUserId or buyerBalance is missing

              // deduct currency & add symbol qty from buyer
              buyerBalance[PRIMARY_CURRENCY] = {
                available: Number(buyerBalance[PRIMARY_CURRENCY]?.available),
                locked:
                  Number(buyerBalance[PRIMARY_CURRENCY]?.locked) -
                  priceForFilledQty,
              };
              buyerBalance[symbol] = {
                available: Number(buyerBalance[symbol]?.available) + fill.qty,
                locked: buyerBalance[symbol]?.locked || 0,
              };

              remainingQty = 0;
              break;
            } else if (availableQty === remainingQty) {
              // the current order can be filled - restingOrder is filled
              const fillId = crypto.randomUUID();
              const fill: Fill = {
                fillId,
                symbol,
                price: bestBidPrice,
                qty: remainingQty,
                buyOrderId: restingOrder.orderId,
                sellOrderId: currentOrderId,
                createdAt: new Date().getTime(),
              };

              let currentOrder = ORDERS.get(currentOrderId);
              if (!currentOrder) {
                currentOrder = {
                  orderId: currentOrderId,
                  userId,
                  side,
                  type,
                  symbol,
                  price: bestBidPrice,
                  qty: remainingQty,
                  filledQty: remainingQty,
                  status: "filled",
                  fills: [fill],
                  createdAt: new Date().getTime(),
                } satisfies OrderRecord;
              } else {
                currentOrder.filledQty += remainingQty;
                currentOrder.status = "filled";
                currentOrder.fills.push(fill);
              }
              ORDERS.set(currentOrderId, currentOrder);

              restingOrder.filledQty += remainingQty;
              restingOrder.status = "filled";

              const restingOrderRecord = ORDERS.get(restingOrder.orderId);
              if (!restingOrderRecord) {
                // think this will never or should never happen
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrder,
                  fills: [fill],
                });
              } else {
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrderRecord,
                  status: "filled",
                  filledQty: restingOrder.filledQty,
                  fills: [...restingOrderRecord.fills, fill],
                });
              }

              FILLS.push(fill);

              // add currency & deduct symbol qty from seller
              const priceForFilledQty = fill.qty * bestBidPrice;
              userBalance[PRIMARY_CURRENCY] = {
                available:
                  Number(userBalance[PRIMARY_CURRENCY]?.available) +
                  priceForFilledQty,
                locked: userBalance[PRIMARY_CURRENCY]?.locked || 0,
              };
              userBalance[symbol] = {
                available: Number(userBalance[symbol].available),
                locked: userBalance[symbol].locked - fill.qty,
              };

              const buyerUserId = ORDERS.get(restingOrder.orderId)?.userId!;
              const buyerBalance = BALANCES.get(buyerUserId)!;
              // td:: how / if to handle if buyerUserId or buyerBalance is missing

              // deduct currency & add symbol qty from buyer
              buyerBalance[PRIMARY_CURRENCY] = {
                available: Number(buyerBalance[PRIMARY_CURRENCY]?.available),
                locked:
                  Number(buyerBalance[PRIMARY_CURRENCY]?.locked) -
                  priceForFilledQty,
              };
              buyerBalance[symbol] = {
                available: Number(buyerBalance[symbol]?.available) + fill.qty,
                locked: buyerBalance[symbol]?.locked || 0,
              };

              remainingQty = 0;

              // move filled restingOrder out of orderbooks when they are filled
              if (restingOrder.status === "filled") {
                ordersAtPrice.splice(i, 1);
                if (ordersAtPrice.length <= 0) {
                  orderbook.bids.delete(bestBidPrice);
                }
              }
              break;
            } else {
              // availableQty < remainingQty
              remainingQty -= availableQty;
              // the current order can be partially filled - restingOrder is filled
              const fillId = crypto.randomUUID();
              const fill: Fill = {
                fillId,
                symbol,
                price: bestBidPrice,
                qty: availableQty,
                buyOrderId: restingOrder.orderId,
                sellOrderId: currentOrderId,
                createdAt: new Date().getTime(),
              };

              let currentOrder = ORDERS.get(currentOrderId);
              if (!currentOrder) {
                currentOrder = {
                  orderId: currentOrderId,
                  userId,
                  side,
                  type,
                  symbol,
                  price: bestBidPrice,
                  qty: qty,
                  filledQty: availableQty,
                  status: "partially_filled",
                  fills: [fill],
                  createdAt: new Date().getTime(),
                } satisfies OrderRecord;
              } else {
                currentOrder.filledQty += availableQty;
                currentOrder.status = "partially_filled";
                currentOrder.fills.push(fill);
              }
              ORDERS.set(currentOrderId, currentOrder);

              restingOrder.filledQty += availableQty;
              restingOrder.status = "filled";

              const restingOrderRecord = ORDERS.get(restingOrder.orderId);
              if (!restingOrderRecord) {
                // think this will never or should never happen
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrder,
                  fills: [fill],
                });
              } else {
                ORDERS.set(restingOrder.orderId, {
                  ...restingOrderRecord,
                  status: "filled",
                  filledQty: restingOrder.filledQty,
                  fills: [...restingOrderRecord.fills, fill],
                });
              }

              FILLS.push(fill);

              // td:: this is getting repeated in above conditionals 2 times. only fill.qty is different
              // add currency & deduct symbol qty from seller
              const priceForFilledQty = fill.qty * bestBidPrice;
              userBalance[PRIMARY_CURRENCY] = {
                available:
                  Number(userBalance[PRIMARY_CURRENCY]?.available) +
                  priceForFilledQty,
                locked: userBalance[PRIMARY_CURRENCY]?.locked || 0,
              };
              userBalance[symbol] = {
                available: Number(userBalance[symbol].available),
                locked: userBalance[symbol].locked - fill.qty,
              };

              const buyerUserId = ORDERS.get(restingOrder.orderId)?.userId!;
              const buyerBalance = BALANCES.get(buyerUserId)!;
              // td:: how / if to handle if buyerUserId or buyerBalance is missing

              // deduct currency & add symbol qty from buyer
              buyerBalance[PRIMARY_CURRENCY] = {
                available: Number(buyerBalance[PRIMARY_CURRENCY]?.available),
                locked:
                  Number(buyerBalance[PRIMARY_CURRENCY]?.locked) -
                  priceForFilledQty,
              };
              buyerBalance[symbol] = {
                available: Number(buyerBalance[symbol]?.available) + fill.qty,
                locked: buyerBalance[symbol]?.locked || 0,
              };

              // move filled restingOrder out of orderbooks when they are filled
              if (restingOrder.status === "filled") {
                ordersAtPrice.splice(i, 1);
                if (ordersAtPrice.length <= 0) {
                  orderbook.bids.delete(bestBidPrice);
                }
              }
            }
          }

          // get the next bestBidPrice
          bestBidPrice = getNextBestBidPrice(symbol, bestBidPrice);
        }

        if (remainingQty > 0 && !bestBidPrice) {
          // there is nothing available, so cancel the order
          let currentOrder = ORDERS.get(currentOrderId);
          if (!currentOrder) {
            currentOrder = {
              orderId: currentOrderId,
              userId,
              side,
              type,
              symbol,
              price: 0,
              qty: remainingQty,
              filledQty: 0,
              status: "cancelled",
              fills: [],
              createdAt: new Date().getTime(),
            } satisfies OrderRecord;
          } else {
            currentOrder.status = "cancelled";
          }
          ORDERS.set(currentOrderId, currentOrder);
        }
      }
    }

    console.dir({ BALANCES, ORDERBOOKS, ORDERS }, { depth: 5 });

    let currentOrder = ORDERS.get(currentOrderId);
    if (!currentOrder) {
      throw new Error(`Unable to create order`);
    }
    let totalCost = 0;
    const fills = currentOrder.fills.map((f) => {
      totalCost = totalCost + f.price * f.qty;
      return {
        fillId: f.fillId,
        symbol: f.symbol,
        price: f.price,
        qty: f.qty,
        buyOrderId: f.buyOrderId,
        sellOrderId: f.sellOrderId,
      };
    });
    return {
      orderId: currentOrderId,
      status: currentOrder.status,
      filledQty: currentOrder.filledQty,
      averagePrice: +(totalCost / currentOrder.filledQty).toFixed(2),
      fills,
    };
  }
  if (message.type === "get_depth") {
    const { symbol } = message.payload as { symbol: string };
    const orderbook = ORDERBOOKS.get(symbol);
    if (!orderbook) {
      throw new Error(`${symbol} is not supported`);
    }

    const maxDepthAllowed = 20;
    const res: DepthResponse = {
      symbol,
      bids: [],
      asks: [],
    };
    const askPriceArray: number[] = [];
    for (const price of orderbook.asks.keys()) {
      askPriceArray.push(price);
    }
    askPriceArray.sort((a, b) => a - b);
    for (let i = 0; i < askPriceArray.length; i++) {
      if (i === maxDepthAllowed) break;
      const currentPrice = askPriceArray[i]!;
      const orderRecords = orderbook.asks.get(currentPrice)!;
      let totalQty = 0;
      for (const order of orderRecords) {
        totalQty += order.qty - order.filledQty;
      }
      res.asks.push({
        price: askPriceArray[i]!,
        qty: totalQty,
      });
    }

    const bidPriceArray: number[] = [];
    for (const price of orderbook.bids.keys()) {
      bidPriceArray.push(price);
    }
    bidPriceArray.sort((a, b) => b - a);
    for (let i = 0; i < bidPriceArray.length; i++) {
      if (i === maxDepthAllowed) break;
      const currentPrice = bidPriceArray[i]!;
      const orderRecords = orderbook.bids.get(currentPrice)!;
      let totalQty = 0;
      for (const order of orderRecords) {
        totalQty += order.qty - order.filledQty;
      }
      res.bids.push({
        price: bidPriceArray[i]!,
        qty: totalQty,
      });
    }

    return res;
  }
  if (message.type === "get_user_balance") {
    const { userId } = message.payload as { userId: string };
    const userBalance = BALANCES.get(userId);
    if (!userBalance) {
      throw new Error(`${userId} has no balance`);
    }

    return userBalance;
  }
  if (message.type === "get_order") {
    const { userId, orderId } = message.payload as {
      userId: string;
      orderId: string;
    };
    const order = ORDERS.get(orderId);
    if (!orderId || !order) {
      throw new Error(`order: ${orderId} does not exist`);
    }
    if (order.userId !== userId) {
      throw new Error(`order: ${orderId} does not belong to user: ${userId}`);
    }
    return order;
  }
  if (message.type === "cancel_order") {
    const { userId, orderId } = message.payload as {
      userId: string;
      orderId: string;
    };
    const cancellableOrder = ORDERS.get(orderId);
    if (!orderId || !cancellableOrder) {
      throw new Error(`order: ${orderId} does not exist`);
    }
    if (cancellableOrder.userId !== userId) {
      throw new Error(`order: ${orderId} does not belong to user: ${userId}`);
    }
    if (
      cancellableOrder.status === "filled" ||
      cancellableOrder.status === "cancelled"
    ) {
      throw new Error(`order: ${orderId} cannot be cancelled`);
    }

    const orderbook = ORDERBOOKS.get(cancellableOrder.symbol);
    if (!orderbook) {
      throw new Error(`order: ${orderId} cannot be found in orderbook`);
    }
    let orderbookSide: "asks" | "bids" = "asks";
    if (cancellableOrder.side === "buy") {
      orderbookSide = "bids";
    }
    const ordersForCancellablePrice = orderbook[orderbookSide].get(
      cancellableOrder.price!,
    );
    if (!ordersForCancellablePrice) {
      throw new Error(`order: ${orderId} cannot be found in orderbook`);
    }

    for (const [index, order] of ordersForCancellablePrice.entries()) {
      if (order.orderId === orderId) {
        // cancel this order, i.e. remove it from orderbook
        ordersForCancellablePrice.splice(index, 1);
      }
    }

    if (ordersForCancellablePrice.length <= 0) {
      orderbook[orderbookSide].delete(cancellableOrder.price!);
    }

    cancellableOrder.status = "cancelled";

    // unlock the cancelled balance
    const userBalance = BALANCES.get(cancellableOrder.userId)!;
    const remainingQty = cancellableOrder.qty - cancellableOrder.filledQty;

    if (cancellableOrder.side === "buy") {
      const refundTotal = remainingQty * Number(cancellableOrder.price);
      const userCurrencyBalance = userBalance[PRIMARY_CURRENCY]!;
      userCurrencyBalance.available += refundTotal;
      userCurrencyBalance.locked -= refundTotal;
    } else {
      const refundTotal = remainingQty;
      const userSymbolBalance = userBalance[cancellableOrder.symbol]!;
      userSymbolBalance.available += refundTotal;
      userSymbolBalance.locked -= refundTotal;
    }

    console.dir({ BALANCES, ORDERBOOKS, ORDERS }, { depth: 5 });
    return cancellableOrder;
  }

  throw new Error("Unsupported request type");
}

console.log(`Engine listening on Redis queue: ${env.incomingQueue}`);

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
    const data = handleEngineRequest(message);
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
