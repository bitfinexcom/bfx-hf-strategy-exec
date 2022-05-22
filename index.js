'use strict'

const { std } = require('mathjs')
const _sum = require('lodash/sum')
const _min = require('lodash/min')
const _max = require('lodash/max')
const _isNil = require('lodash/isNil')
const _isEmpty = require('lodash/isEmpty')
const _reverse = require('lodash/reverse')
const _isFunction = require('lodash/isFunction')
const _isPlainObject = require('lodash/isPlainObject')
const BigNumber = require('bignumber.js')

const { candleWidth } = require('bfx-hf-util')
const { subscribe } = require('bfx-api-node-core')
const { padCandles } = require('bfx-api-node-util')
const PromiseThrottle = require('promise-throttle')
const debug = require('debug')('bfx:hf:strategy-exec')

const {
  onSeedCandle, onCandle, onTrade, closeOpenPositions,
  getPosition, positionPl
} = require('bfx-hf-strategy')

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
   * @param {object} args.strategyOpts - execution parameters
   * @param {string} args.strategyOpts.symbol - market to execute on
   * @param {string} args.strategyOpts.tf - time frame to execute on
   * @param {boolean} args.strategyOpts.includeTrades - if true, trade data is subscribed to and processed
   * @param {number} args.strategyOpts.seedCandleCount - size of indicator candle seed window, before which trading is disabled
   * @param {object} args.priceFeed
   * @param {object} args.perfManager
   */
  constructor (args) {
    super()

    const { strategy, ws2Manager, rest, strategyOpts, priceFeed, perfManager } = args

    this.strategyState = {
      ...(strategy || {}),
      emit: this.emit.bind(this)
    }

    this.ws2Manager = ws2Manager || {}
    this.rest = rest || {}
    this.strategyOpts = strategyOpts || {}
    this.priceFeed = priceFeed
    this.perfManager = perfManager

    this.lastCandle = null
    this.lastTrade = null
    this.processing = false
    this.stopped = false
    this.messages = []

    this._registerManagerEventListeners()
  }

  /**
   * @private
   */
  _registerManagerEventListeners () {
    if (_isEmpty(this.ws2Manager)) {
      throw new Error('WS2 manager not available')
    }

    const { includeTrades, symbol, tf } = this.strategyOpts
    const candleKey = `trade:${tf}:${symbol}`
    let lastUpdate = 0

    if (includeTrades) {
      this.ws2Manager.onWS('trades', { symbol }, async (trades) => {
        if (trades.length > 1) { // we don't pass snapshots through
          return
        }

        if (trades.mts > lastUpdate) {
          this.priceFeed.update(new BigNumber(trades.price))
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
      candle.tf = tf

      if (candle.mts > lastUpdate) {
        this.priceFeed.update(new BigNumber(candle.close))
        lastUpdate = candle.mts
      }

      this._enqueueMessage('candle', candle)
    })
  }

  /**
   * @private
   */
  async _seedCandles () {
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
  _enqueueMessage (type, data) {
    if (this.stopped) {
      return
    }

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
  async _processMessages () {
    this.processing = true

    while (!_isEmpty(this.messages)) {
      const msg = this.messages.shift()

      await this._processMessage(msg)
    }

    this.processing = false
  }

  _emitStrategyExecutionResults (type = 'candle', data) {
    const { symbol } = this.strategyOpts
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
  async execute () {
    await this._seedCandles()

    this._subscribeCandleAndTradeEvents()

    this.perfManager.on('update', () => this._emitStrategyExecutionResults('perf', this.priceFeed))
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
    const { symbol, tf } = this.strategyOpts
    const { trades: strategyTrades = [], marketData = {} } = this.strategyState

    if (_isPlainObject(openPosition)) {
      const openOrder = strategyTrades.find(st => st.position_id === openPosition.id)
      if (openOrder) {
        openOrder.pl = openPosition.pl
      }
    }

    const candles = marketData[`candles-${symbol}-${tf}`] || []
    const trades = marketData[`trades-${symbol}`] || []

    const nCandles = candles.length
    const nTrades = trades.length

    const nStrategyTrades = strategyTrades.length
    const pls = strategyTrades.map(t => t.pl)
    const gains = pls.filter(pl => pl > 0)
    const losses = pls.filter(pl => pl < 0)
    const nOpens = pls.filter(pl => pl === 0).length
    const vol = _sum(strategyTrades.map(t => Math.abs(t.price * t.amount)))
    const fees = _sum(strategyTrades.map(t => t.fee))
    const totalGain = _sum(gains)
    const totalLoss = _sum(losses)
    const pf = totalGain / Math.abs(totalLoss)
    const pl = _sum(pls)
    const minPL = _min(pls)
    const maxPL = _max(pls)
    const accumulatedPLs = strategyTrades.map(x => x.pl)
    const stdDeviation = std(accumulatedPLs.length > 0 ? accumulatedPLs : [0])
    const avgPL = _sum(accumulatedPLs) / accumulatedPLs.length
    const allocation = this.perfManager.allocation
    const positionSize = this.perfManager.positionSize()
    const currentAllocation = this.perfManager.currentAllocation()
    const availableFunds = this.perfManager.availableFunds
    const equityCurve = this.perfManager.equityCurve()
    const ret = this.perfManager.return()
    const retPerc = this.perfManager.returnPerc()
    const drawdown = this.perfManager.drawdown()

    return {
      vol,
      fees,
      candles,
      trades: trades.map(t => ({
        ...t,
        date: new Date(t.mts)
      })),

      nTrades,
      nCandles,
      nStrategyTrades,
      nOpens,
      nGains: gains.length,
      nLosses: losses.length,

      stdDeviation,
      pl,
      pf: isNaN(pf) ? 0 : pf,
      avgPL: isNaN(avgPL) ? 0 : avgPL,
      minPL: _isNil(minPL) ? 0 : minPL,
      maxPL: _isNil(maxPL) ? 0 : maxPL,

      allocation,
      positionSize,
      currentAllocation,
      availableFunds,
      equityCurve,
      return: ret,
      returnPerc: retPerc,
      drawdown,

      strategy: {
        trades: strategyTrades.map(t => ({
          ...t,
          date: new Date(t.mts)
        }))
      }
    }
  }
}

module.exports = LiveStrategyExecution
