<a name="bfx-hf-strategy-exec"></a>

## bfx-hf-strategy-exec(strategy, wsManager, args)
Execute a strategy on a live market

**Kind**: global function  
**License**: Apache-2.0  

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| strategy | <code>bfx-hf-strategy.StrategyState</code> |  | as created by define()   from bfx-hf-strategy |
| wsManager | <code>bfx-api-node-core.Manager</code> |  | WSv2 pool instance |
| args | <code>object</code> |  | execution parameters |
| args.symbol | <code>string</code> |  | market to execute on |
| args.tf | <code>string</code> |  | time frame to execute on |
| args.includeTrades | <code>boolean</code> |  | if true, trade data is subscribed to   and processed |
| [args.seedCandleCount] | <code>number</code> | <code>5000</code> | size of indicator candle seed   window, before which trading is disabled |

**Example**  
```js
const debug = require('debug')('bfx:hf:strategy-exec:example:exec')
const { SYMBOLS, TIME_FRAMES } = require('bfx-hf-util')
const { Manager } = require('bfx-api-node-core')
const EMACrossStrategy = require('./ema_cross_strategy')
const exec = require('bfx-hf-strategy-exec')

const API_KEY = '...'
const API_SECRET = '...'

const ws2Manager = new Manager({
  apiKey: API_KEY,
  apiSecret: API_SECRET,
  transform: true
})

const strategy = await EMACrossStrategy({
  symbol: SYMBOLS.EOS_USD,
  tf: TIME_FRAMES.ONE_DAY,
  amount: 1,
  margin: true
})

ws2Manager.onWS('open', {}, (state = {}) => debug('connected to ws2 API'))
ws2Manager.onceWS('event:auth:success', {}, async (authEvent, ws) => {
  debug('authenticated')
  debug('executing strategy...')

  strategy.ws = ws

  await exec(strategy, ws2Manager, {
    symbol: SYMBOLS.EOS_USD,
    tf: TIME_FRAMES.ONE_DAY,
    includeTrades: true,
    seedCandleCount: 5000
  })
})

debug('opening socket...')
ws2Manager.openWS()
```
