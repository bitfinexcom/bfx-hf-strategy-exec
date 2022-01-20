'use strict'

process.env.DEBUG = '*'

const { RESTv2 } = require('bfx-api-node-rest')
const debug = require('debug')('bfx:hf:strategy-exec:example:exec')
const { SYMBOLS, TIME_FRAMES } = require('bfx-hf-util')
const { Manager } = require('bfx-api-node-core')
const WDPlugin = require('bfx-api-node-plugin-wd')

const EMACrossStrategy = require('./ema_cross_strategy')
const LiveStrategyExecution = require('../')

const API_KEY = '...'
const API_SECRET = '...'

const rest = new RESTv2({ url: 'https://api.bitfinex.com', transform: true })

const ws2Manager = new Manager({
  apiKey: API_KEY,
  apiSecret: API_SECRET,
  transform: true,

  plugins: [WDPlugin({
    autoReconnect: true, // if false, the connection will only be closed
    reconnectDelay: 5000, // wait 5 seconds before reconnecting
    packetWDDelay: 10000 // set the watch-dog to a 10s delay
  })]
})

const run = async () => {
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

    const strategyOpts = {
      symbol: SYMBOLS.EOS_USD,
      tf: TIME_FRAMES.ONE_DAY,
      includeTrades: true,
      seedCandleCount: 5000
    }

    const liveExecutor = new LiveStrategyExecution({ strategy, ws2Manager, rest, strategyOpts })

    liveExecutor.on('error', (err) => {
      // handle errors
      console.error(err)
    })
    
    await liveExecutor.execute()
  })

  debug('opening socket...')
  ws2Manager.openWS()
}

try {
  run()
} catch (err) {
  debug('error: %s', err.stack)
}
