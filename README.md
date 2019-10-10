## Bitfinex Honey Framework Trading Strategy Live Execution Module for Node.JS

[![Build Status](https://travis-ci.org/bitfinexcom/bfx-hf-strategy-exec.svg?branch=master)](https://travis-ci.org/bitfinexcom/bfx-hf-strategy-exec)

This module can execute strategies built with `bfx-hf-strategy` on a live data stream from Bitfinex via v2 of the WS API. Strategy indicators are initially seeded with the last 1000 candles by default, but this is configurably with the `seedCandleCount` argument. Trade data can be included on the stream by passing `includeTrades: true` when calling `exec()`.

### Features

* Cross-compatible with `bfx-hf-backtest` allowing the same strategy to be both backtested and executed seamlessly
* Execute trading strategies on the live Bitfinex markets
* Utilizes a multiplexing websocket connection manager to scale with channel subscriptions

### Installation

```bash
npm i --save bfx-hf-strategy-exec
```

### Quickstart & Example
```js
const { SYMBOLS, TIME_FRAMES } = require('bfx-hf-util')
const { Manager } = require('bfx-api-node-core')
const exec = require('bfx-hf-stratey-exec')
const CustomTradingStrategy = require('./somewhere')

const ws2Manager = new Manager({ /*...*/ }) // see bfx-api-node-core docs
const strategy = await CustomTradingStrategy({ /* optionally pass args */ })

ws2Manager.onceWS('event:auth:success', {}, async (authEvent, ws) => {
  strategy.ws = ws

  await exec(strategy, ws2Manager, {
    symbol: SYMBOLS.EOS_USD, // data stream symbol
    tf: TIME_FRAMES.ONE_DAY, // candle data stream time frame
    includeTrades: true,
    seedCandleCount: 5000    // indicator candle seed window
  })
})

ws2Manager.openWS()
```

### Docs

For executable examples refer to the [`examples/`](/examples) folder. JSDoc generated API documentation can be found [within `docs/api.md`](/docs/api.md).

### Contributing

1. Fork it
2. Create your feature branch (`git checkout -b my-new-feature`)
3. Commit your changes (`git commit -am 'Add some feature'`)
4. Push to the branch (`git push origin my-new-feature`)
5. Create a new Pull Request
