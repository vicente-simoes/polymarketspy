# Polymarket CLOB WebSocket Book Feed - Phase 0 Documentation

## WebSocket Contract Details

This document captures the Polymarket CLOB WebSocket API details for order book subscriptions.

### Endpoint

```
wss://ws-subscriptions-clob.polymarket.com/ws/market
```

- **Public access**: Yes, no authentication required for market channel
- **User channel** (orders, fills) requires auth but we don't need it for books

### Subscription Model

**Subscribe per tokenId** (`asset_id` in Polymarket terminology)

#### Initial subscription (on connect)
```json
{
  "assets_ids": ["109681959945973300464568698402968596289258214226684818748321941747028805721376"],
  "type": "market"
}
```

#### Subscribe to additional tokens (after connected)
```json
{
  "assets_ids": ["<tokenId1>", "<tokenId2>"],
  "operation": "subscribe"
}
```

#### Unsubscribe from tokens
```json
{
  "assets_ids": ["<tokenId>"],
  "operation": "unsubscribe"
}
```

### Message Types

The market channel sends three event types:

1. **`book`** - Order book updates (deltas)
2. **`price_change`** - Price change events
3. **`last_trade_price`** - Last trade price updates

### Book Update Message Schema

Based on the documentation and client examples, book updates use **delta semantics**:

```typescript
interface BookUpdateMessage {
  event_type: "book";
  asset_id: string;
  // Delta format: price -> size (size=0 means remove level)
  bids: Record<string, number> | Array<{ price: string; size: string }>;
  asks: Record<string, number> | Array<{ price: string; size: string }>;
  timestamp?: string;
  hash?: string;
}
```

**Delta application rules:**
- When a price level appears with size > 0: **set** that level
- When a price level appears with size = 0: **remove** that level
- Levels not mentioned: **keep unchanged**

### Connection Management

#### Ping/Pong (Keep-Alive)
- Send `"PING"` every ~10 seconds to maintain connection
- Server responds with `"PONG"` (or similar)

#### Reconnection
- On disconnect: reconnect with exponential backoff
- On reconnect: re-subscribe to all active tokenIds

### Rate Limits (Conservative Estimates)

Not explicitly documented, using conservative defaults:
- **MAX_SUBSCRIPTIONS_PER_CONNECTION**: ~200 (configurable)
- **RECONNECT_BACKOFF_INITIAL_MS**: 1000
- **RECONNECT_BACKOFF_MAX_MS**: 60000
- **PING_INTERVAL_MS**: 10000

### Example Message Flow

```
1. Client connects to wss://ws-subscriptions-clob.polymarket.com/ws/market
2. Client sends: {"assets_ids": ["token123"], "type": "market"}
3. Server sends initial book snapshot (or first delta)
4. Server sends incremental deltas as book changes
5. Client sends "PING" every 10s
6. Server responds "PONG"
7. Client sends: {"assets_ids": ["token456"], "operation": "subscribe"}
8. Server sends book data for token456
9. ... continues
```

### Integration Notes

**How this differs from our Alchemy WS:**
- Alchemy WS = on-chain OrderFilled events (canonical, for detecting fills)
- CLOB WS = off-chain order book state (for simulation/execution decisions)

**What we need from the book:**
- Best bid/ask for spread checks
- Full depth for simulation (consuming levels)
- Fresh data (<2s old) for accurate execution decisions

### Sources

- [WSS Overview](https://docs.polymarket.com/developers/CLOB/websocket/wss-overview)
- [WSS Quickstart](https://docs.polymarket.com/quickstart/websocket/WSS-Quickstart)
- [Data Feeds](https://docs.polymarket.com/developers/market-makers/data-feeds)
- [CLOB Introduction](https://docs.polymarket.com/developers/CLOB/introduction)
