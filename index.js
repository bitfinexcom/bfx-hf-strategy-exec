'use strict'

const debug = require('debug')('bfx:hf:strategy-exec')
const { subscribe } = require('bfx-api-node-core')
const { padCandles } = require('bfx-api-node-util')
const { candleWidth } = require('bfx-hf-util')
const _isEmpty = require('lodash/isEmpty')
const _reverse = require('lodash/reverse')
const _debounce = require('lodash/debounce')
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
 * @param {Object} strategy - as created by define() from bfx-hf-strategy
 * @param {Object} wsManager - WSv2 pool instance from bfx-api-node-core
 * @param {Object} rest - restv2 instance
 * @param {Object} args - execution parameters
 * @param {string} args.symbol - market to execute on
 * @param {string} args.tf - time frame to execute on
 * @param {boolean} args.includeTrades - if true, trade data is subscribed to and processed
 * @param {number} args.seedCandleCount - size of indicator candle seed window, before which trading is disabled
 * @param {Object} conn - optional event emitter object to emit required events
 */
const exec = async (strategy = {}, wsManager = {}, rest = {}, args = {}, conn) => {
  const { symbol, tf, includeTrades, seedCandleCount = 5000 } = args
  const candleKey = `trade:${tf}:${symbol}`
  const messages = []

  let strategyState = strategy
  let lastCandle = null
  let lastTrade = null
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
      rest.candles.bind(rest, ({
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
        debug('error processing: %s', err)

        if (conn) {
          conn.emit('error', err)
        }
      })
    }
  }

  const _debouncedEnqueue = _debounce(enqueMessage, 100)

  const processMessage = async (msg) => {
    const { type, data } = msg

    switch (type) {
      case 'trade': {
        if (lastTrade && lastTrade.id >= data.id) {
          break
        }

        data.symbol = symbol
        debug('recv trade: %j', data)
        strategyState = await onTrade(strategyState, data)
        lastTrade = data

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

      enqueMessage('trade', trades)
    })
  }

  wsManager.onWS('candles', { key: candleKey }, async (candles) => {
    if (candles.length > 1) { // seeding happens at start via RESTv2
      return
    }
    
    const [candle] = candles
    candle.symbol = symbol
    candle.tf = tf
    
    _debouncedEnqueue('candle', candle)
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
