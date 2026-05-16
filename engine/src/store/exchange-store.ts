export type Side = "buy" | "sell";
export type OrderType = "market" | "limit";
export type OrderStatus = "open" | "partially_filled" | "filled" | "cancelled";

export interface Balance {
  available: number;
  locked: number;
}

export interface RestingOrder {
  orderId: string;
  userId: string;
  side: Side;
  type: "limit";
  symbol: string;
  price: number;
  qty: number;
  filledQty: number;
  status: OrderStatus;
  createdAt: number;
}

export interface OrderRecord {
  orderId: string;
  userId: string;
  side: Side;
  type: OrderType;
  symbol: string;
  price: number | null;
  qty: number;
  filledQty: number;
  status: OrderStatus;
  fills: Fill[];
  createdAt: number;
}

export interface Fill {
  fillId: string;
  symbol: string;
  price: number;
  qty: number;
  buyOrderId: string;
  sellOrderId: string;
  createdAt: number;
}

export interface OrderBook {
  bids: Map<number, RestingOrder[]>;
  asks: Map<number, RestingOrder[]>;
}

export interface CreateOrderInput {
  userId: string;
  type: OrderType;
  side: Side;
  symbol: string;
  price: number | null;
  qty: number;
}

export interface DepthLevel {
  price: number;
  qty: number;
}

export interface DepthResponse {
  symbol: string;
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export interface Store {
  balances: Map<string, Record<string, Balance>>;
  orderbooks: Map<string, OrderBook>;
  orders: Map<string, OrderRecord>;
  fills: Fill[];
}

export const PRIMARY_CURRENCY = "INR";
export const SUPPORTED_SYMBOLS = ["BTC", "SOL"];
export function createExchangeStore(): Store {
  const intialOrderBook = SUPPORTED_SYMBOLS.map((s) => ({
    symbol: s,
    bids: new Map(),
    asks: new Map(),
  }));
  return {
    balances: new Map<string, Record<string, Balance>>(),
    orderbooks: new Map<string, OrderBook>(
      intialOrderBook.map((entry) => [
        entry.symbol,
        { bids: entry.bids, asks: entry.asks },
      ]),
    ),
    orders: new Map<string, OrderRecord>(),
    fills: [],
  };
}
