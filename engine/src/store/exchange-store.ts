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

export const PRIMARY_CURRENCY = "INR";
export const SUPPORTED_SYMBOLS = ["BTC", "SOL"];
const intialOrderBook = SUPPORTED_SYMBOLS.map((s) => ({
  symbol: s,
  bids: new Map(),
  asks: new Map(),
}));
export const BALANCES = new Map<string, Record<string, Balance>>();
export const ORDERBOOKS = new Map<string, OrderBook>(
  intialOrderBook.map((entry) => [
    entry.symbol,
    { bids: entry.bids, asks: entry.asks },
  ]),
);
/*
[
  ["BTC", { bids: new Map(), asks: new Map() }],
  ["SOL", { bids: new Map(), asks: new Map() }],
  ["ABC", { bids: new Map(), asks: new Map() }],
]
*/
export const ORDERS = new Map<string, OrderRecord>();
export const FILLS: Fill[] = [];
