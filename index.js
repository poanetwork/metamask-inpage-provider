const pump = require('pump')
const RpcEngine = require('json-rpc-engine')
const createErrorMiddleware = require('./createErrorMiddleware')
const createIdRemapMiddleware = require('json-rpc-engine/src/idRemapMiddleware')
const createJsonRpcStream = require('json-rpc-middleware-stream')
const LocalStorageStore = require('obs-store')
const asStream = require('obs-store/lib/asStream')
const ObjectMultiplex = require('obj-multiplex')
const util = require('util')
const SafeEventEmitter = require('safe-event-emitter')

module.exports = class MetamaskInpageProvider extends SafeEventEmitter {


  constructor (connectionStream, shouldSendMetadata = true) {
    super()

    this.isMetaMask = true
    this.isNiftyWallet = true

    // setup connectionStream multiplexing
    const mux = this.mux = new ObjectMultiplex()
    pump(
      connectionStream,
      mux,
      connectionStream,
      logStreamDisconnectWarning.bind(this, 'MetaMask')
    )

    // subscribe to metamask public config (one-way)
    this.publicConfigStore = new LocalStorageStore({ storageKey: 'MetaMask-Config' })

    pump(
      mux.createStream('publicConfig'),
      asStream(this.publicConfigStore),
      logStreamDisconnectWarning.bind(this, 'MetaMask PublicConfigStore')
    )

    // ignore phishing warning message (handled elsewhere)
    mux.ignoreStream('phishing')

    // connect to async provider
    const jsonRpcConnection = createJsonRpcStream()
    pump(
      jsonRpcConnection.stream,
      mux.createStream('provider'),
      jsonRpcConnection.stream,
      logStreamDisconnectWarning.bind(this, 'MetaMask RpcProvider')
    )

    // handle sendAsync requests via dapp-side rpc engine
    const rpcEngine = new RpcEngine()
    rpcEngine.push(createIdRemapMiddleware())
    rpcEngine.push(createErrorMiddleware())
    rpcEngine.push(jsonRpcConnection.middleware)
    this.rpcEngine = rpcEngine

    // forward json rpc notifications
    jsonRpcConnection.events.on('notification', function(payload) {
      this.emit('data', null, payload)
    })

    // Work around for https://github.com/metamask/metamask-extension/issues/5459
    // drizzle accidently breaking the `this` reference
    this.send = this.send.bind(this)
    this.sendAsync = this.sendAsync.bind(this)
  }

// Web3 1.0 provider uses `send` with a callback for async queries
send (payload, callback) {
  const self = this

  if (callback) {
    self.sendAsync(payload, callback)
  } else {
    return self._sendSync(payload)
  }
}

// handle sendAsync requests via asyncProvider
// also remap ids inbound and outbound
sendAsync (payload, cb) {
  const self = this

  if (payload.method === 'eth_signTypedData') {
    console.warn('MetaMask: This experimental version of eth_signTypedData will be deprecated in the next release in favor of the standard as defined in EIP-712. See https://git.io/fNzPl for more information on the new standard.')
  }

  self.rpcEngine.handle(payload, cb)
}

_sendSync (payload) {
  const self = this

  let selectedAddress
  let result = null
  switch (payload.method) {

    case 'eth_accounts':
      // read from localStorage
      selectedAddress = self.publicConfigStore.getState().selectedAddress
      result = selectedAddress ? [selectedAddress] : []
      break

    case 'eth_coinbase':
      // read from localStorage
      selectedAddress = self.publicConfigStore.getState().selectedAddress
      result = selectedAddress || null
      break

    case 'eth_uninstallFilter':
      self.sendAsync(payload, noop)
      result = true
      break

    case 'net_version':
      const networkVersion = self.publicConfigStore.getState().networkVersion
      result = networkVersion || null
      break

    // throw not-supported Error
    default:
      var link = 'https://github.com/MetaMask/faq/blob/master/DEVELOPERS.md#dizzy-all-async---think-of-metamask-as-a-light-client'
      var message = `The MetaMask Web3 object does not support synchronous methods like ${payload.method} without a callback parameter. See ${link} for details.`
      throw new Error(message)

  }

  // return the result
  return {
    id: payload.id,
    jsonrpc: payload.jsonrpc,
    result: result,
  }
}

isConnected () {
  return true
}

}

// util

function logStreamDisconnectWarning (remoteLabel, err) {
  let warningMsg = `MetamaskInpageProvider - lost connection to ${remoteLabel}`
  if (err) warningMsg += '\n' + err.stack
  console.warn(warningMsg)
  const listeners = this.listenerCount('error')
  if (listeners > 0) {
    this.emit('error', warningMsg)
  }
}

function noop () {}
