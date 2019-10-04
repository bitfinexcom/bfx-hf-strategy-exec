<a name="exec"></a>

## exec(strategy, wsManager, args)
Execute a strategy on a live market

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| strategy | <code>Object</code> | as created by define() from bfx-hf-strategy |
| wsManager | <code>Object</code> | WSv2 pool instance from bfx-api-node-core |
| args | <code>Object</code> | execution parameters |
| args.symbol | <code>string</code> | market to execute on |
| args.tf | <code>string</code> | time frame to execute on |
| args.includeTrades | <code>boolean</code> | if true, trade data is subscribed to and processed |
| args.seedCandleCount | <code>number</code> | size of indicator candle seed window, before which trading is disabled |

