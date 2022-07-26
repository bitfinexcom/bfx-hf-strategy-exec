'use strict'

const _isEmpty = require('lodash/isEmpty')
const _isFinite = require('lodash/isFinite')
const _isFunction = require('lodash/isFunction')

const { candleWidth } = require('bfx-hf-util')
const { subscribe } = require('bfx-api-node-core')
const PromiseThrottle = require('promise-throttle')
const debug = require('debug')('bfx:hf:strategy-exec')
const {
  onSeedCandle, onCandle, onTrade, closeOpenPositions,
  getPosition, positionPl
} = require('bfx-hf-strategy')
const _generateStrategyResults = require('bfx-hf-strategy/lib/util/generate_strategy_results')

const EventEmitter = require('events')

const CANDLE_FETCH_LIMIT = 1000
const pt = new PromiseThrottle({
  requestsPerSecond: 10.0 / 60.0, // taken from docs
  promiseImplementation: Promise
})

class LiveStrategyExecution extends EventEmitter {
  /**
   * @param {object} args
   * @param {object} args.strategy - as created by define() from bfx-hf-strategy
   * @param {object} args.ws2Manager - WSv2 pool instance from bfx-api-node-core
   * @param {object} args.rest - restv2 instance
   * @param {object} args.strategyOptions - execution parameters
   * @param {string} args.strategyOptions.symbol - market to execute on
   * @param {string} args.strategyOptions.timeframe - time frame to execute on
   * @param {boolean} args.strategyOptions.trades - if true, trade data is subscribed to and processed
   * @param {number} args.strategyOptions.candleSeed - size of indicator candle seed window, before which trading is disabled
   * @param {object} args.priceFeed
   * @param {object} args.perfManager
   */
  constructor (args) {
    super()

    const { strategy = {}, ws2Manager, rest, strategyOptions, priceFeed, perfManager } = args

    this.strategyState = {
      ...strategy,
      emit: this.emit.bind(this)
    }

    this.ws2Manager = ws2Manager || {}
    this.rest = rest || {}
    this.strategyOptions = strategyOptions || {}
    this.priceFeed = priceFeed
    this.perfManager = perfManager

    const { candlePrice = 'close' } = strategy
    this.candlePrice = candlePrice

    this.lastCandle = null
    this.lastTrade = null
    this.processing = false
    this.stopped = false
    this.messages = []

    this.paused = false
    this.pausedMts = {}

    this._registerManagerEventListeners()
  }

  _padCandles (candles, candleWidth) {
    const paddedCandles = [...candles]
    for (let i = 0; i < candles.length - 1; i += 1) {
      const candle = candles[i]
      const nextCandle = candles[i + 1]
      const candlesToFill = ((nextCandle.mts - candle.mts) / candleWidth) - 1

      if (candlesToFill > 0) {
        const fillerCandles = Array.apply(null, Array(candlesToFill)).map((c, i) => {
          return {
            ...candle,
            mts: candle.mts + (candleWidth * (i + 1)),
            open: candle.close,
            close: candle.close,
            high: candle.close,
            low: candle.close,
            volume: 0
          }
        })

        paddedCandles.splice(i + 1, 0, ...fillerCandles)
      }
    }

    return paddedCandles
  }

  async invoke (strategyHandler) {
    this.strategyState = await strategyHandler(this.strategyState)
  }

  /**
   * @private
   */
  _registerManagerEventListeners () {
    if (_isEmpty(this.ws2Manager)) {
      throw new Error('WS2 manager not available')
    }

    const { trades, symbol, timeframe } = this.strategyOptions
    const candleKey = `trade:${timeframe}:${symbol}`
    let lastUpdate = 0

    if (trades) {
      this.ws2Manager.onWS('trades', { symbol }, async (trades) => {
        if (trades.length > 1) { // we don't pass snapshots through
          return
        }

        if (trades.mts > lastUpdate) {
          this.priceFeed.update(trades.price)
          lastUpdate = trades.mts
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
      candle.tf = timeframe

      if (candle.mts > lastUpdate) {
        this.priceFeed.update(candle[this.candlePrice])
        lastUpdate = candle.mts
      }

      this._enqueueMessage('candle', candle)
    })

    this.ws2Manager.onWS('open', {}, this._onWSOpen.bind(this))
    this.ws2Manager.onWS('close', {}, this._onWSClose.bind(this))
  }

  /**
   * @private
   */
  _onWSClose () {
    if (this.paused) {
      return
    }
    this.pausedMts.pausedOn = Date.now()
    this.paused = true
  }

  /**
   * @private
   */
  async _onWSOpen () {
    if (!this.paused) return

    this.pausedMts.resumedOn = Date.now()

    // fetching and processing candles for paused duration
    const candles = await this._fetchCandlesForPausedDuration()
    while (!_isEmpty(candles)) {
      const candleData = candles.shift()

      await this._processCandleData(candleData)
    }

    this.paused = false
    this.pausedMts = {}
  }

  /**
   * @private
   */
  async _fetchCandlesForPausedDuration () {
    const { pausedOn: start, resumedOn: end } = this.pausedMts
    if (!_isFinite(start) || !_isFinite(end)) {
      return []
    }

    const { timeframe, symbol } = this.strategyOptions
    const cWidth = candleWidth(timeframe)
    const candles = await this._fetchCandles({
      symbol,
      timeframe,
      query: {
        start: start - (120 * 1000), // 2 min threshold
        end,
        sort: 1
      }
    }, cWidth)

    return candles
  }

  /**
   * @private
   */
  async _fetchCandles (candleOpts, cWidth) {
    const candleResponse = await pt.add(
      this.rest.candles.bind(this.rest, candleOpts)
    )

    const candles = this._padCandles(candleResponse, cWidth)

    return candles
  }

  /**
   * @private
   */
  async _seedCandles () {
    const { candleSeed, timeframe, symbol } = this.strategyOptions

    debug('seeding with last ~%d candles...', candleSeed)

    const cWidth = candleWidth(timeframe)
    const now = Date.now()
    const seedStart = now - (candleSeed * cWidth)

    for (let i = 0; i < Math.ceil(candleSeed / CANDLE_FETCH_LIMIT); i += 1) {
      let seededCandles = 0
      let candle

      const start = seedStart + (i * 1000 * cWidth)
      const end = Math.min(seedStart + ((i + 1) * 1000 * cWidth), now)

      const candles = await this._fetchCandles({
        symbol,
        timeframe,
        query: {
          limit: CANDLE_FETCH_LIMIT,
          start,
          end,
          sort: 1
        }
      }, cWidth)

      for (let i = 0; i < candles.length; i += 1) {
        candle = candles[i]

        if (this.lastCandle && this.lastCandle.mts >= candle.mts) {
          continue
        }

        candle.tf = timeframe
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
  _enqueueMessage (type, data) {
    if (this.stopped) {
      return
    }

    this.messages.push({ type, data })

    if (!this.processing || !this.paused) {
      this._processMessages().catch((err) => {
        debug('error processing: %s', err)

        this.emit('error', err)
      })
    }
  }

  /**
   * @private
   */
  async _processMessages () {
    this.processing = true

    while (!_isEmpty(this.messages)) {
      const msg = this.messages.shift()

      await this._processMessage(msg)
    }

    this.processing = false
  }

  _emitStrategyExecutionResults (type = 'candle', data) {
    const { symbol } = this.strategyOptions
    const { candlePrice } = this.strategyState
    const price = type === 'candle' ? data[candlePrice] : data.price

    const openPosition = getPosition(this.strategyState, symbol)
    if (openPosition && price) {
      openPosition.pl = positionPl(this.strategyState, symbol, price)
      this.emit('opened_position_data', openPosition)
    }

    this.emit('rt_execution_results', this.generateResults(openPosition))
  }

  /**
   * @private
   */
  async _processTradeData (data) {
    if (this.lastTrade && this.lastTrade.id >= data.id) {
      return
    }

    const { symbol } = this.strategyState
    data.symbol = symbol
    debug('recv trade: %j', data)
    this.strategyState = await onTrade(this.strategyState, data)
    this.lastTrade = data

    this._emitStrategyExecutionResults('trade', data)
  }

  /**
   * @private
   */
  async _processCandleData (data) {
    if (this.lastCandle === null || this.lastCandle.mts === data.mts) {
      // in case of first candle received or candle update event
      this.lastCandle = data
      this._emitStrategyExecutionResults('candle', data)
    } else if (this.lastCandle.mts < data.mts) {
      debug('recv candle %j', data)
      debug('closed candle %j', this.lastCandle)
      this.strategyState = await onCandle(this.strategyState, this.lastCandle) // send closed candle data
      this.lastCandle = data // save new candle data
      this._emitStrategyExecutionResults('candle', data)
    }
  }

  /**
   * @private
   */
  async _processMessage (msg) {
    const { type, data } = msg

    switch (type) {
      case 'trade': {
        await this._processTradeData(data)
        break
      }

      case 'candle': {
        await this._processCandleData(data)
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
  _subscribeCandleAndTradeEvents () {
    const { trades, symbol, timeframe } = this.strategyOptions
    const candleKey = `trade:${timeframe}:${symbol}`

    this.ws2Manager.withSocket((socket) => {
      let nextSocket = subscribe(socket, 'candles', { key: candleKey })

      if (trades) {
        nextSocket = subscribe(nextSocket, 'trades', { symbol })
      }

      return nextSocket
    })
  }

  /**
   * @public
   */
  async execute () {
    await this._seedCandles()

    this._subscribeCandleAndTradeEvents()

    this.perfManager.on('update', () => this._emitStrategyExecutionResults('perf', { price: this.priceFeed.price.toNumber() }))
  }

  /**
   * @public
   */
  async stopExecution () {
    const { onEnd } = this.strategyState

    if (_isFunction(onEnd)) {
      this.strategyState = await onEnd(this.strategyState)
    }

    const openPosition = getPosition(this.strategyState)
    if (openPosition) {
      this.strategyState = await closeOpenPositions(this.strategyState)
    }

    this.stopped = true
  }

  /**
   * @public
   * @returns {object}
   */
  generateResults (openPosition = null) {
    return _generateStrategyResults(this.perfManager, this.strategyState, openPosition)
  }
}

module.exports = LiveStrategyExecution
