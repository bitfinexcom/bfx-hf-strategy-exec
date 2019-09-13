'use strict'

const HFS = require('bfx-hf-strategy')

module.exports = async (state = {}, update = {}) => {
  const { price, mts } = update
  const i = HFS.indicators(state)
  const iv = HFS.indicatorValues(state)
  const { emaS } = i
  const l = iv.emaL
  const s = iv.emaS

  if (emaS.crossed(l)) {
    if (s > l) {
      return HFS.openLongPositionMarket(state, {
        mtsCreate: mts,
        amount: 1,
        price
      })
    } else {
      return HFS.openShortPositionMarket(state, {
        mtsCreate: mts,
        amount: 1,
        price
      })
    }
  }

  return state
}
