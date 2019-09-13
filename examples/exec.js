'use strict'

process.env.DEBUG = '*'

const debug = require('debug')('bfx:hf:strategy-exec:example:exec')
const { SYMBOLS, TIME_FRAMES } = require('bfx-hf-util')
const { Manager } = require('bfx-api-node-core')
const EMACrossStrategy = require('./ema_cross_strategy')
const exec = require('../')

const API_KEY = '...'
const API_SECRET = '...'

const ws2Manager = new Manager({
  apiKey: API_KEY,
  apiSecret: API_SECRET,
  transform: true
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

    await exec(strategy, ws2Manager, {
      symbol: SYMBOLS.EOS_USD,
      tf: TIME_FRAMES.ONE_DAY,
      includeTrades: true,
      seedCandleCount: 5000
    })
  })

  debug('opening socket...')
  ws2Manager.openWS()
}

try {
  run()
} catch (err) {
  debug('error: %s', err.stack)
}
