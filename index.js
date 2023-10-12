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
  getPosition, onOrder
} = require('bfx-hf-strategy')
const _generateStrategyResults = require('bfx-hf-strategy/lib/util/generate_strategy_results')
const { calcRealizedPositionPnl, calcUnrealizedPositionPnl } = require('bfx-hf-strategy/lib/pnl')
const { alignRangeMts } = require('bfx-hf-util')

const EventEmitter = require('events')

const CANDLE_FETCH_LIMIT = 1000
const CANDLE_FETCH_SECTION = 'hist'
const pt = new PromiseThrottle({
  requestsPerSecond: 10.0 / 60.0, // taken from docs
  promiseImplementation: Promise
})
const ORDER_CLOSE_EVENT = 'auth:oc'
const WALLET_SNAPSHOT_EVENT = 'auth:ws'
const WALLET_UPDATE_EVENT = 'auth:wu'

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

    const { strategy, ws2Manager, rest, strategyOptions, priceFeed, perfManager } = args

    this.strategyState = {
      ...strategy,
      useMaxLeverage: strategyOptions.useMaxLeverage,
      leverage: strategyOptions.leverage,
      increaseLeverage: strategyOptions.increaseLeverage,
      addStopOrder: strategyOptions.addStopOrder,
      stopOrderPercent: strategyOptions.stopOrderPercent,
      isDerivative: strategyOptions.isDerivative,
      maxLeverage: strategyOptions.maxLeverage,
      baseCurrency: strategyOptions.baseCurrency,
      quoteCurrency: strategyOptions.quoteCurrency,
      emit: this.emit.bind(this)
    }

    this.ws2Manager = ws2Manager
    this.rest = rest
    this.strategyOptions = strategyOptions
    this.priceFeed = priceFeed
    this.perfManager = perfManager

    const { candlePrice = 'close' } = strategy
    this.candlePrice = candlePrice

    this.lastCandle = null
    this.lastTrade = null
    this.processing = false
    this.stopped = false
    this.messages = []
    this.lastPriceFeedUpdate = 0

    this.paused = false
    this.pausedMts = {}

    this._registerManagerEventListeners()
  }

  _padCandles (candles, candleWidth, { start: startTime, end: endTime }) {
    const paddedCandles = [...candles]
    let addedCandlesCount = 0
    for (let i = 0; i < candles.length; i += 1) {
      const candle = candles[i]
      const candleTime = candle.mts

      // if start candles are missing
      if (i === 0 && candleTime >= (startTime + candleWidth)) {
        const candlesToFill = Math.ceil((candleTime - startTime) / candleWidth)
        if (candlesToFill > 0) {
          const fillerCandles = Array.apply(null, Array(candlesToFill)).map((c, i) => {
            return this._copyCandleWithNewTime(candle, candle.mts - (candleWidth * (candlesToFill - i)))
          })

          paddedCandles.splice(0, 0, ...fillerCandles)
          addedCandlesCount += fillerCandles.length
        }
      }

      // if middle or end candles are missing
      const nextCandle = candles[i + 1]
      const nextCandleTime = nextCandle ? nextCandle.mts : endTime
      const candlesToFill = Math.ceil((nextCandleTime - candleTime) / candleWidth) - 1

      if (candlesToFill > 0) {
        const fillerCandles = Array.apply(null, Array(candlesToFill)).map((c, i) => {
          return this._copyCandleWithNewTime(candle, candle.mts + (candleWidth * (i + 1)))
        })

        paddedCandles.splice(i + 1 + addedCandlesCount, 0, ...fillerCandles)
        addedCandlesCount += fillerCandles.length
      }
    }

    return paddedCandles
  }

  _copyCandleWithNewTime (candle, newTime) {
    return {
      ...candle,
      mts: newTime,
      open: candle.close,
      close: candle.close,
      high: candle.close,
      low: candle.close,
      volume: 0
    }
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

    const { trades: includeTrades, symbol, timeframe } = this.strategyOptions
    const candleKey = `trade:${timeframe}:${symbol}`

    this.ws2Manager.onWS('trades', { symbol }, async (trades) => {
      if (trades.length > 1) { // we don't pass snapshots through
        return
      }

      if (includeTrades) {
        this._enqueueMessage('trade', trades)
      }

      if (trades.mts > this.lastPriceFeedUpdate) {
        this.priceFeed.update(trades.price, trades.mts)
        this.lastPriceFeedUpdate = trades.mts
      }
    })

    this.ws2Manager.onWS('candles', { key: candleKey }, async (candles) => {
      if (candles.length > 1) { // seeding happens at start via RESTv2
        return
      }

      const [candle] = candles
      candle.symbol = symbol
      candle.tf = timeframe

      this._enqueueMessage('candle', candle)
    })

    // closed orders
    this.ws2Manager.onWS(ORDER_CLOSE_EVENT, {}, async (data) => {
      this._enqueueMessage(ORDER_CLOSE_EVENT, data)
    })

    this.ws2Manager.onWS(WALLET_SNAPSHOT_EVENT, {}, async (data) => {
      this._enqueueMessage(WALLET_SNAPSHOT_EVENT, data)
    })

    this.ws2Manager.onWS(WALLET_UPDATE_EVENT, {}, async (data) => {
      this._enqueueMessage(WALLET_UPDATE_EVENT, data)
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
    const candleDataMessage = candles.map(candle => {
      return {
        type: 'candle',
        data: candle.toJS()
      }
    })

    this.messages.unshift(...candleDataMessage)
    // preventing wrong processing order incase residual messages were remaining before unshift
    this.messages.sort((a, b) => {
      return a.data.mts - b.data.mts
    })
    this.paused = false
    this.pausedMts = {}

    // set timeout while waiting for next candle
    this._setNextCandleTimeout()
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
      section: CANDLE_FETCH_SECTION,
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

    const candles = this._padCandles(candleResponse, cWidth, candleOpts.query)

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
    // align start time with candle mts range
    const alignedStartTs = alignRangeMts(timeframe, now)
    const seedStart = alignedStartTs - (candleSeed * cWidth)

    for (let i = 0; i < Math.ceil(candleSeed / CANDLE_FETCH_LIMIT); i += 1) {
      let seededCandles = 0
      let candle

      const start = seedStart + (i * 1000 * cWidth)
      const end = Math.min(seedStart + ((i + 1) * 1000 * cWidth), alignedStartTs)

      const candles = await this._fetchCandles({
        symbol,
        timeframe,
        section: CANDLE_FETCH_SECTION,
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

    // set timeout while waiting for next candle
    this._setNextCandleTimeout()
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
      this.emit('opened_position_data', {
        ...openPosition,
        realizedPnl: calcRealizedPositionPnl(openPosition),
        unrealizedPnl: calcUnrealizedPositionPnl(openPosition, price)
      })
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
  async _processWalletData (data, type) {
    if (!this.strategyState) return

    if (type === WALLET_SNAPSHOT_EVENT) {
      this.strategyState.wallets = data._collection ? data._collection.map(wallet => {
        return {
          currency: wallet.currency,
          type: wallet.type,
          balance: wallet.balance,
          balanceAvailable: wallet.balanceAvailable
        }
      }) : []
    } else if (type === WALLET_UPDATE_EVENT && this.strategyState.wallets) {
      this.strategyState.wallets.forEach(wallet => {
        if (wallet.currency === data.currency && wallet.type === data.type) {
          wallet.balance = data.balance || wallet.balance
          wallet.balanceAvailable = data.balanceAvailable || wallet.balanceAvailable
        }
      })
    }
  }

  /**
   * @private
   */
  async _processOrderData (data) {
    this.strategyState = await onOrder(this.strategyState, data)
  }

  /**
   * @private
   */
  async _processCandleData (data) {
    if (data.mts > this.lastPriceFeedUpdate) {
      this.priceFeed.update(data[this.candlePrice], data.mts)
      this.lastPriceFeedUpdate = data.mts
    }

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

    // set timeout while waiting for next candle
    this._setNextCandleTimeout()
  }

  /**
   * @private
   */
  _setNextCandleTimeout () {
    if (this.paused || this.stopped) return

    if (this.nextCandleTimeout) clearTimeout(this.nextCandleTimeout)

    const { timeframe } = this.strategyOptions
    const cWidth = candleWidth(timeframe)
    // use candle duration as additional time to wait for candle
    const timeToWaitForCandle = this._calculateTimeToWaitForCandle(cWidth)
    const sinceLastCandle = Date.now() - this.lastCandle.mts
    const timeout = timeToWaitForCandle - sinceLastCandle

    this.nextCandleTimeout = setTimeout(async () => {
      await this._createNextCandleFromLast(cWidth)
    }, timeout)
  }

  /**
   * @private
   */
  _calculateTimeToWaitForCandle (cWidth) {
    return cWidth * 1.5
  }

  /**
   * @private
   */
  async _createNextCandleFromLast (cWidth) {
    if (this.paused || this.stopped) return

    // if no new candle received during wait time, create new from last candle
    const sinceLastCandle = Date.now() - this.lastCandle.mts
    const timeToWaitForCandle = this._calculateTimeToWaitForCandle(cWidth)
    if (sinceLastCandle >= timeToWaitForCandle) {
      const candle = this.lastCandle
      const newCandle = this._copyCandleWithNewTime(candle, candle.mts + cWidth)
      debug('no candle received, created new candle %j', newCandle)
      await this._processCandleData(newCandle)
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

      case ORDER_CLOSE_EVENT: {
        await this._processOrderData(data)
        break
      }

      case WALLET_SNAPSHOT_EVENT: {
        await this._processWalletData(data, type)
        break
      }

      case WALLET_UPDATE_EVENT: {
        await this._processWalletData(data, type)
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
    const { symbol, timeframe } = this.strategyOptions
    const candleKey = `trade:${timeframe}:${symbol}`

    this.ws2Manager.withSocket((socket) => {
      const nextSocket = subscribe(socket, 'candles', { key: candleKey })
      return subscribe(nextSocket, 'trades', { symbol })
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
