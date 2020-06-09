'use strict'

const debug = require('debug')('bfx:hf:strategy-exec')
const { subscribe } = require('bfx-api-node-core')
const { padCandles } = require('bfx-api-node-util')
const { candleWidth } = require('bfx-hf-util')
const _isEmpty = require('lodash/isEmpty')
const _reverse = require('lodash/reverse')
const PromiseThrottle = require('promise-throttle')

const {
  onSeedCandle, onCandle, onCandleUpdate, onTrade
} = require('bfx-hf-strategy')

const CANDLE_FETCH_LIMIT = 1000
const pt = new PromiseThrottle({
  requestsPerSecond: 10.0 / 60.0, // taken from docs
  promiseImplementation: Promise
})

/**
 * Execute a strategy on a live market
 *
 * @module bfx-hf-strategy-exec
 * @license Apache-2.0
 * @function
 *
 * @param {bfx-hf-strategy.StrategyState} strategy - as created by define()
 *   from bfx-hf-strategy
 * @param {bfx-api-node-core.Manager} wsManager - WSv2 pool instance
 * @param {object} args - execution parameters
 * @param {string} args.symbol - market to execute on
 * @param {string} args.tf - time frame to execute on
 * @param {boolean} args.includeTrades - if true, trade data is subscribed to
 *   and processed
 * @param {number} [args.seedCandleCount=5000] - size of indicator candle seed
 *   window, before which trading is disabled
 *
 * @example
 * const debug = require('debug')('bfx:hf:strategy-exec:example:exec')
 * const { SYMBOLS, TIME_FRAMES } = require('bfx-hf-util')
 * const { Manager } = require('bfx-api-node-core')
 * const EMACrossStrategy = require('./ema_cross_strategy')
 * const exec = require('bfx-hf-strategy-exec')
 *
 * const API_KEY = '...'
 * const API_SECRET = '...'
 *
 * const ws2Manager = new Manager({
 *   apiKey: API_KEY,
 *   apiSecret: API_SECRET,
 *   transform: true
 * })
 *
 * const strategy = await EMACrossStrategy({
 *   symbol: SYMBOLS.EOS_USD,
 *   tf: TIME_FRAMES.ONE_DAY,
 *   amount: 1,
 *   margin: true
 * })
 *
 * ws2Manager.onWS('open', {}, (state = {}) => debug('connected to ws2 API'))
 * ws2Manager.onceWS('event:auth:success', {}, async (authEvent, ws) => {
 *   debug('authenticated')
 *   debug('executing strategy...')
 *
 *   strategy.ws = ws
 *
 *   await exec(strategy, ws2Manager, {
 *     symbol: SYMBOLS.EOS_USD,
 *     tf: TIME_FRAMES.ONE_DAY,
 *     includeTrades: true,
 *     seedCandleCount: 5000
 *   })
 * })
 *
 * debug('opening socket...')
 * ws2Manager.openWS()
 */
const exec = async (strategy = {}, wsManager = {}, args = {}) => {
  const { symbol, tf, includeTrades, seedCandleCount = 5000 } = args
  const candleKey = `trade:${tf}:${symbol}`
  const messages = []
  let strategyState = strategy
  let lastCandle = null
  let processing = false

  debug('seeding with last ~%d candles...', seedCandleCount)

  const cWidth = candleWidth(tf)
  const now = Date.now()
  const seedStart = now - (seedCandleCount * cWidth)

  for (let i = 0; i < Math.ceil(seedCandleCount / CANDLE_FETCH_LIMIT); i += 1) {
    let seededCandles = 0
    let candle

    const start = seedStart + (i * 1000 * cWidth)
    const end = Math.min(seedStart + ((i + 1) * 1000 * cWidth), now)

    const candleResponse = await pt.add(
      wsManager.rest.candles.bind(wsManager.rest, ({
        symbol,
        timeframe: tf,
        query: {
          limit: CANDLE_FETCH_LIMIT,
          start,
          end
        }
      }))
    )

    const candles = _reverse(padCandles(candleResponse, cWidth))

    for (let i = 0; i < candles.length; i += 1) {
      candle = candles[i]

      if (lastCandle && lastCandle.mts >= candle.mts) {
        continue
      }

      candle.tf = tf
      candle.symbol = symbol

      strategyState = await onSeedCandle(strategyState, candle)
      lastCandle = candle
      seededCandles += 1
    }

    debug(
      'seeded with %d candles from %s - %s',
      seededCandles, new Date(start).toLocaleString(), new Date(end).toLocaleString()
    )
  }

  const enqueMessage = (type, data) => {
    debug('enqueue %s', type)

    messages.push({ type, data })

    if (!processing) {
      processMessages().catch((err) => {
        debug('error processing: %s', err.stack)
      })
    }
  }

  const processMessage = async (msg) => {
    const { type, data } = msg

    switch (type) {
      case 'trade': {
        debug('recv trade: %j', data)
        strategyState = await onTrade(strategyState, data)
        break
      }

      case 'candle': {
        if (lastCandle === null || lastCandle.mts < data.mts) {
          debug('recv candle %j', data)
          strategyState = await onCandle(strategyState, data)
          lastCandle = data
        } else if (lastCandle.mts === data.mts) {
          debug('updated candle %j', data)
          strategyState = await onCandleUpdate(strategyState, data)
        }

        break
      }

      default: {
        debug('unknown message type: %s', type)
      }
    }
  }

  const processMessages = async () => {
    processing = true

    while (!_isEmpty(messages)) {
      const [msg] = messages.splice(0, 1)

      await processMessage(msg)
    }

    processing = false
  }

  if (includeTrades) {
    wsManager.onWS('trades', { symbol }, async (trades) => {
      if (trades.length > 1) { // we don't pass snapshots through
        return
      }

      const [trade] = trades
      enqueMessage('trade', trade)
    })
  }

  wsManager.onWS('candles', { key: candleKey }, async (candles) => {
    if (candles.length > 1) { // seeding happens at start via RESTv2
      return
    }

    const [candle] = candles
    candle.symbol = symbol
    candle.tf = tf

    enqueMessage('candle', candle)
  })

  wsManager.withSocket((socket) => {
    let nextSocket = subscribe(socket, 'candles', { key: candleKey })

    if (includeTrades) {
      nextSocket = subscribe(nextSocket, 'trades', { symbol })
    }

    return nextSocket
  })
}

module.exports = exec
