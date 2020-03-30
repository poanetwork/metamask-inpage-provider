const pump = require('pump')
const RpcEngine = require('json-rpc-engine')
const createIdRemapMiddleware = require('json-rpc-engine/src/idRemapMiddleware')
const createJsonRpcStream = require('json-rpc-middleware-stream')
const ObservableStore = require('obs-store')
const asStream = require('obs-store/lib/asStream')
const ObjectMultiplex = require('obj-multiplex')
const util = require('util')
const SafeEventEmitter = require('safe-event-emitter')
const dequal = require('fast-deep-equal')
const { ethErrors } = require('eth-json-rpc-errors')
const log = require('loglevel')

const messages = require('./src/messages')
const { sendSiteMetadata } = require('./src/siteMetadata')
const {
  createErrorMiddleware,
  logStreamDisconnectWarning,
  makeThenable,
} = require('./src/utils')

module.exports = class MetamaskInpageProvider extends SafeEventEmitter {


  constructor (connectionStream, shouldSendMetadata = true) {
    super()

    this.isMetaMask = true
    this.isNiftyWallet = true

    // private state, kept here in part for use in the _metamask proxy
    this._state = {
      sentWarnings: {
        enable: false,
        experimentalMethods: false,
        isConnected: false,
        sendAsync: false,
        // TODO:deprecate:2020-Q1
        autoReload: false,
        sendSync: false,
      },
      isConnected: undefined,
      accounts: undefined,
      isUnlocked: undefined,
    }

    // public state
    this.selectedAddress = null
    this.networkVersion = undefined
    this.chainId = undefined

    // bind functions (to prevent e.g. web3@1.x from making unbound calls)
    this._handleDisconnect = this._handleDisconnect.bind(this)

    // setup connectionStream multiplexing
    const mux = this.mux = new ObjectMultiplex()
    pump(
      connectionStream,
      mux,
      connectionStream,
      logStreamDisconnectWarning.bind(this, 'MetaMask')
    )

    // subscribe to metamask public config (one-way)
    this.publicConfigStore = new ObservableStore({ storageKey: 'MetaMask-Config' })

    pump(
      mux.createStream('publicConfig'),
      asStream(this.publicConfigStore),
      logStreamDisconnectWarning.bind(this, 'MetaMask PublicConfigStore')
    )

    // EIP-1193 connect
    this.on('connect', () => {
      this._state.isConnected = true
    })

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

  /**
   * Deprecated.
   * Returns whether the inpage provider is connected to MetaMask.
   */
  isConnected () {

    if (!this._state.sentWarnings.isConnected) {
      log.warn(messages.warnings.isConnectedDeprecation)
      this._state.sentWarnings.isConnected = true
    }
    return this._state.isConnected
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
        // read from ObservableStore
        selectedAddress = self.publicConfigStore.getState().selectedAddress
        result = selectedAddress ? [selectedAddress] : []
        break

      case 'eth_coinbase':
        // read from ObservableStore
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

    /**
   * Called when connection is lost to critical streams.
   */
  _handleDisconnect (streamName, err) {

    logStreamDisconnectWarning.bind(this)(streamName, err)
    if (this._state.isConnected) {
      this.emit('close', {
        code: 1011,
        reason: 'MetaMask background communication error.',
      })
    }
    this._state.isConnected = false
  }
}

// util

function noop () {}
