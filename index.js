'use strict'

const _isEmpty = require('lodash/isEmpty')
const _reverse = require('lodash/reverse')
const _debounce = require('lodash/debounce')
const { candleWidth } = require('bfx-hf-util')
const { subscribe } = require('bfx-api-node-core')
const { padCandles } = require('bfx-api-node-util')
const PromiseThrottle = require('promise-throttle')
const debug = require('debug')('bfx:hf:strategy-exec')

const {
  onSeedCandle, onCandle, onCandleUpdate, onTrade
} = require('bfx-hf-strategy')

const EventEmitter = require('events')

const CANDLE_FETCH_LIMIT = 1000
const DEBOUNCE_PERIOD_MS = 100
const pt = new PromiseThrottle({
  requestsPerSecond: 10.0 / 60.0, // taken from docs
  promiseImplementation: Promise
})

class LiveStrategyExecution extends EventEmitter {
  /**
   * @param {Object} args
   * @param {Object} args.strategy - as created by define() from bfx-hf-strategy
   * @param {Object} args.ws2Manager - WSv2 pool instance from bfx-api-node-core
   * @param {Object} args.rest - restv2 instance
   * @param {Object} args.strategyOpts - execution parameters
   * @param {string} args.strategyOpts.symbol - market to execute on
   * @param {string} args.strategyOpts.tf - time frame to execute on
   * @param {boolean} args.strategyOpts.includeTrades - if true, trade data is subscribed to and processed
   * @param {number} args.strategyOpts.seedCandleCount - size of indicator candle seed window, before which trading is disabled
   */
  constructor(args) {
    super()

    const { strategy, ws2Manager, rest, strategyOpts } = args

    this.strategyState = strategy || {}
    this.ws2Manager = ws2Manager || {}
    this.rest = rest || {}
    this.strategyOpts = strategyOpts || {}

    this.lastCandle = null
    this.lastTrade = null
    this.processing = false
    this.messages = []

    this._debouncedEnqueue = _debounce(this._enqueueMessage.bind(this), DEBOUNCE_PERIOD_MS)

    this._registerManagerEventListeners()
  }

  /**
   * @private
   */
  _registerManagerEventListeners() {
    if (_isEmpty(this.ws2Manager)) {
      throw new Error('WS2 manager not available')
    }
    
    const { includeTrades, symbol, tf } = this.strategyOpts
    const candleKey = `trade:${tf}:${symbol}`
    
    if (includeTrades) {
      this.ws2Manager.onWS('trades', { symbol }, async (trades) => {
        if (trades.length > 1) { // we don't pass snapshots through
          return
        }
  
        this._enqueueMessage('trade', trades)
      })
    }
  
    this.ws2Manager.onWS('candles', { key: candleKey }, async (candles) => {
      if (candles.length > 1) { // seeding happens at start via RESTv2
        return
      }
  
      const [candle] = candles
      candle.symbol = symbol
      candle.tf = tf
  
      this._debouncedEnqueue('candle', candle)
    })
  }
  
  /**
   * @private
   */
  async _seedCandles() {
    const { seedCandleCount, tf, symbol } = this.strategyOpts
    
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
        this.rest.candles.bind(this.rest, ({
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
  
        if (this.lastCandle && this.lastCandle.mts >= candle.mts) {
          continue
        }
  
        candle.tf = tf
        candle.symbol = symbol
  
        this.strategyState = await onSeedCandle(this.strategyState, candle)
        this.lastCandle = candle
        seededCandles += 1
      }
  
      debug(
        'seeded with %d candles from %s - %s',
        seededCandles, new Date(start).toLocaleString(), new Date(end).toLocaleString()
      )
    }
  }

  /**
   * @private
   */
  _enqueueMessage(type, data) {
    debug('enqueue %s', type)

    this.messages.push({ type, data })

    if (!this.processing) {
      this._processMessages().catch((err) => {
        debug('error processing: %s', err)

        this.emit('error', err)
      })
    }
  }

  /**
   * @private
   */
  async _processMessages() {
    this.processing = true

    while (!_isEmpty(this.messages)) {
      const [msg] = this.messages.splice(0, 1)

      await this._processMessage(msg)
    }

    this.processing = false
  }

  /**
   * @private
   */
  async _processMessage(msg) {
    const { type, data } = msg

    switch (type) {
      case 'trade': {
        if (this.lastTrade && this.lastTrade.id >= data.id) {
          break
        }

        const { symbol } = this.strategyState
        data.symbol = symbol
        debug('recv trade: %j', data)
        this.strategyState = await onTrade(this.strategyState, data)
        this.lastTrade = data

        break
      }

      case 'candle': {
        if (this.lastCandle === null || this.lastCandle.mts < data.mts) {
          debug('recv candle %j', data)
          this.strategyState = await onCandle(this.strategyState, data)
          this.lastCandle = data
        } else if (this.lastCandle.mts === data.mts) {
          debug('updated candle %j', data)
          this.strategyState = await onCandleUpdate(this.strategyState, data)
        }

        break
      }

      default: {
        debug('unknown message type: %s', type)
      }
    }
  }

  /**
   * @private
   */
  _subscribeCandleAndTradeEvents() {
    const { includeTrades, symbol, tf } = this.strategyOpts
    const candleKey = `trade:${tf}:${symbol}`

    this.ws2Manager.withSocket((socket) => {
      let nextSocket = subscribe(socket, 'candles', { key: candleKey })
  
      if (includeTrades) {
        nextSocket = subscribe(nextSocket, 'trades', { symbol })
      }
  
      return nextSocket
    })
  }

  /**
   * @public
   */
  async execute() {
    await this._seedCandles()

    this._subscribeCandleAndTradeEvents()
  }
}

module.exports = LiveStrategyExecution