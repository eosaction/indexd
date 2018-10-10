let debug = require('./debug')('indexd:blockchain')
let parallel = require('run-parallel')
let types = require('./types')
let rpcUtil = require('./rpc')

function Blockchain (emitter, db, rpc) {
  this.emitter = emitter
  this.db = db
  this.rpc = rpc
}

Blockchain.prototype.connect = function (blockId, height, callback) {
  const events = []
  rpcUtil.block(this.rpc, blockId, (err, block) => {
    if (err) return callback(err)
    if (height !== block.height) return callback(new Error('Height mismatch')) // TODO: necessary?

    let atomic = this.db.atomic()
    let { transactions } = block

    transactions.forEach((tx) => {
      let { txId, txBuffer, ins, outs } = tx

      ins.forEach((input, vin) => {
        if (input.coinbase) return

        let { prevTxId, vout } = input
        atomic.put(types.spentIndex, { txId: prevTxId, vout }, { txId, vin })
        events.push(['spent', `${prevTxId}:${vout}`, txId])
      })

      outs.forEach(({ scId, script, value, vout }) => {
        atomic.put(types.scIndex, { scId, height, txId, vout }, null)
        atomic.put(types.txoIndex, { txId, vout }, { value, script })
        events.push(['script', scId, txId, txBuffer])
      })

      atomic.put(types.txIndex, { txId }, { height })
      events.push(['transaction', txId, txBuffer, blockId])
    })

    // non-blocking, for events only
    events.push(['block', blockId, height])

    debug(`Putting ${blockId} @ ${height} - ${transactions.length} transactions`)
    atomic.put(types.tip, {}, { blockId, height })
    atomic.write((err) => {
      if (err) return callback(err)

      this.connect2ndOrder(blockId, block, (err) => {
        callback(err, block.nextblockhash)
        setTimeout(() => {
          for (const args of events) this.emitter.emit(...args)
        })
      })
    })
  })
}

function box (data) {
  if (data.length === 0) return { q1: 0, median: 0, q3: 0 }
  let quarter = (data.length / 4) | 0
  let midpoint = (data.length / 2) | 0

  return {
    q1: data[quarter],
    median: data[midpoint],
    q3: data[midpoint + quarter]
  }
}

Blockchain.prototype.connect2ndOrder = function (blockId, block, callback) {
  let feeRates = []
  let tasks = []
  let { height, transactions } = block

  transactions.forEach(({ ins, outs, vsize }) => {
    let inAccum = 0
    let outAccum = 0
    let subTasks = []
    let coinbase = false

    ins.forEach((input, vin) => {
      if (input.coinbase) {
        coinbase = true
        return
      }

      let { prevTxId, vout } = input
      subTasks.push((next) => {
        this.db.get(types.txoIndex, { txId: prevTxId, vout }, (err, txo) => {
          if (err) return next(err)
          if (!txo) return next(new Error(`Missing ${prevTxId}:${vout}`))

          inAccum += txo.value
          next()
        })
      })
    })

    outs.forEach(({ value }, vout) => {
      outAccum += value
    })

    tasks.push((next) => {
      if (coinbase) {
        feeRates.push(0)
        return next()
      }

      parallel(subTasks, (err) => {
        if (err) return next(err)
        let fee = inAccum - outAccum
        let feeRate = Math.floor(fee / vsize)

        feeRates.push(feeRate)
        next()
      })
    })
  })

  debug(`Putting Order2 data ${blockId} @ ${height}`)
  parallel(tasks, (err) => {
    if (err) return callback(err)

    let atomic = this.db.atomic()
    feeRates = feeRates.sort((a, b) => a - b)

    atomic.put(types.feeIndex, { height }, { fees: box(feeRates), size: block.size })
    atomic.write(callback)
  })
}

Blockchain.prototype.disconnect = function (blockId, callback) {
  rpcUtil.block(this.rpc, blockId, (err, block) => {
    if (err) return callback(err)

    let atomic = this.db.atomic()
    let { height, transactions } = block

    transactions.forEach(({ txId, ins, outs }) => {
      ins.forEach((input) => {
        if (input.coinbase) return
        let { prevTxId, vout } = input

        atomic.del(types.spentIndex, { txId: prevTxId, vout })
      })

      outs.forEach(({ scId }, vout) => {
        atomic.del(types.scIndex, { scId, height, txId, vout })
        atomic.del(types.txoIndex, { txId, vout })
      })

      atomic.del(types.txIndex, { txId }, { height })
    })

    debug(`Deleting ${blockId} @ ${height} - ${transactions.length} transactions`)
    atomic.put(types.tip, {}, { blockId: block.previousblockhash, height })
    atomic.write(callback)
  })
}

// QUERIES
Blockchain.prototype.blockHeightByTransactionId = function (txId, callback) {
  this.db.get(types.txIndex, { txId }, (err, row) => {
    if (err) return callback(err)
    if (!row) return callback()

    callback(null, row.height)
  })
}

Blockchain.prototype.blockIdByTransactionId = function (txId, callback) {
  this.db.get(types.txIndex, { txId }, (err, row) => {
    if (err) return callback(err)
    if (!row) return callback()

    rpcUtil.blockIdAtHeight(this.rpc, row.height, callback)
  })
}

Blockchain.prototype.fees = function (n, callback) {
  this.db.get(types.tip, {}, (err, result) => {
    if (err) return callback(err)

    let maxHeight = result.height
    let fresult = []

    this.db.iterator(types.feeIndex, {
      gte: { height: maxHeight - (n - 1) },
      limit: n
    }, ({ height }, { fees, size }) => {
      fresult.push({ height, fees, size })
    }, (err) => callback(err, fresult))
  })
}

let ZERO64 = '0000000000000000000000000000000000000000000000000000000000000000'
Blockchain.prototype.seenScriptId = function (scId, callback) {
  let result = false

  this.db.iterator(types.scIndex, {
    gte: { scId, height: 0, txId: ZERO64, vout: 0 },
    lt: { scId, height: 0xffffffff, txId: ZERO64, vout: 0 },
    limit: 1
  }, () => {
    result = true
  }, (err) => callback(err, result))
}

Blockchain.prototype.spentFromTxo = function (txo, callback) {
  this.db.get(types.spentIndex, txo, callback)
}

Blockchain.prototype.tip = function (callback) {
  this.db.get(types.tip, {}, (err, tip) => {
    callback(err, tip && tip.blockId)
  })
}

Blockchain.prototype.tipHeight = function (callback) {
  this.db.get(types.tip, {}, (err, tip) => {
    callback(err, tip && tip.height)
  })
}

Blockchain.prototype.transactionIdsByScriptId = function (scId, height, callback, limit) {
  this.__txosListByScriptId(scId, height, (err, txos, position) => {
    if (err) return callback(err)

    let tasks = txos.map((txo) => {
      return (next) => this.spentFromTxo(txo, next)
    })

    parallel(tasks, (err, spents) => {
      if (err) return callback(err)

      let txIdSet = {}

      spents.forEach((spent) => {
        if (!spent) return

        txIdSet[spent.txId] = true
      })

      txos.forEach(({ txId }) => {
        txIdSet[txId] = true
      })

      callback(null, txIdSet, position)
    })
  }, limit)
}

// TODO: public?
Blockchain.prototype.__txosListByScriptId = function (scId, height, callback, limit) {
  let offset = 0
  if (Array.isArray(limit)) {
    offset = limit[0]
    limit = limit[1] - offset
  }
  limit = limit || 10000

  let results = []
  let count = 0
  let maxHeight = height

  this.db.iterator(types.scIndex, {
    gte: { scId, height, txId: ZERO64, vout: 0 },
    lt: { scId, height: 0xffffffff, txId: ZERO64, vout: 0 },
    limit: limit
  }, (txo) => {
    // XXX: O(offset) walk, not great
    ++count
    if (count < offset) return

    let { txId, vout, height } = txo
    if (height > maxHeight) maxHeight = height
    results.push({ txId, vout, scId, height })
  }, (err) => callback(err, results, { height, offset: count }))
}

Blockchain.prototype.txosByScriptId = function (scId, height, callback, limit) {
  limit = limit || 10000
  let resultMap = {}

  this.db.iterator(types.scIndex, {
    gte: { scId, height, txId: ZERO64, vout: 0 },
    lt: { scId, height: 0xffffffff, txId: ZERO64, vout: 0 },
    limit: limit
  }, ({ txId, vout, height }) => {
    resultMap[`${txId}:${vout}`] = { txId, vout, scId, height }
  }, (err) => callback(err, resultMap))
}

Blockchain.prototype.txoByTxo = function (txId, vout, callback) {
  this.db.get(types.txoIndex, { txId, vout }, callback)
}

Blockchain.prototype.addLabel = function (scId, label, callback) {
   //TODO: add label
   let atomic = this.db.atomic()
   atomic.del(types.lbIndex, { scId, label })
   atomic.put(types.lbIndex, { scId, label }, null)
   atomic.write(callback)
}

module.exports = Blockchain
