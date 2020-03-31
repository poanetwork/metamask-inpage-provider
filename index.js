const pump = require('pump')
const RpcEngine = require('json-rpc-engine')
const createIdRemapMiddleware = require('json-rpc-engine/src/idRemapMiddleware')
const createJsonRpcStream = require('json-rpc-middleware-stream')
const ObservableStore = require('obs-store')
const asStream = require('obs-store/lib/asStream')
const ObjectMultiplex = require('obj-multiplex')
const SafeEventEmitter = require('safe-event-emitter')
const dequal = require('fast-deep-equal')
const { ethErrors } = require('eth-json-rpc-errors')
const log = require('loglevel')
const util = require('util')

const messages = require('./src/messages')
const {
  createErrorMiddleware,
  logStreamDisconnectWarning,
  makeThenable,
} = require('./src/utils')

// resolve response.result, reject errors
const getRpcPromiseCallback = (resolve, reject) => (error, response) => {
  error || response.error
    ? reject(error || response.error)
    : Array.isArray(response)
      ? resolve(response)
      : resolve(response.result)
}

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

    this._metamask = getExperimentalApi(this)

    // public state
    this.selectedAddress = null
    this.networkVersion = undefined
    this.chainId = undefined

    // Work around for https://github.com/metamask/metamask-extension/issues/5459
    // drizzle accidently breaking the `this` reference
    this.send = this.send.bind(this)
    this.sendAsync = this.sendAsync.bind(this)
    this._handleDisconnect = this._handleDisconnect.bind(this)
    this._sendAsync = this._sendAsync.bind(this)

    // setup connectionStream multiplexing
    const mux = this.mux = new ObjectMultiplex()
    pump(
      connectionStream,
      mux,
      connectionStream,
      this._handleDisconnect.bind(this, 'MetaMask'),
    )

    // subscribe to metamask public config (one-way)
    this.publicConfigStore = new ObservableStore({ storageKey: 'MetaMask-Config' })

    this.publicConfigStore.subscribe(state => {
      // Emit chainChanged event on chain change
      if ('chainId' in state && state.chainId !== this.chainId) {
        this.chainId = state.chainId
        this.emit('chainChanged', this.chainId)
        this.emit('chainIdChanged', this.chainId) // TODO:deprecate:2020-Q1
      }

      // Emit networkChanged event on network change
      if ('networkVersion' in state && state.networkVersion !== this.networkVersion) {
        this.networkVersion = state.networkVersion
        this.emit('networkChanged', this.networkVersion)
      }
    })

    pump(
      mux.createStream('publicConfig'),
      asStream(this.publicConfigStore),
      logStreamDisconnectWarning.bind(this, 'MetaMask PublicConfigStore'),
    )

    // ignore phishing warning message (handled elsewhere)
    mux.ignoreStream('phishing')

    // EIP-1193 connect
    this.on('connect', () => {
      this._state.isConnected = true
    })

    // connect to async provider
    const jsonRpcConnection = createJsonRpcStream()
    pump(
      jsonRpcConnection.stream,
      mux.createStream('provider'),
      jsonRpcConnection.stream,
      this._handleDisconnect.bind(this, 'MetaMask RpcProvider'),
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

    // indicate that we've connected, for EIP-1193 compliance
    setTimeout(() => this.emit('connect'))

    // TODO:deprecate:2020-Q1
    this._web3Ref = undefined
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
        self.sendAsync(payload, () => {})
        result = true
        break

      case 'net_version':
        result = this.networkVersion || null
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
   * Internal RPC method. Forwards requests to background via the RPC engine.
   * Also remap ids inbound and outbound.
   *
   * @param {Object} payload - The RPC request object.
   * @param {Function} userCallback - The caller's callback.
   * @param {boolean} isInternal - Whether the request is internal.
   */
  _sendAsync (payload, userCallback, isInternal = false) {

    let cb = userCallback

    if (!Array.isArray(payload)) {

      if (!payload.jsonrpc) {
        payload.jsonrpc = '2.0'
      }

      if (
        payload.method === 'eth_accounts' ||
        payload.method === 'eth_requestAccounts'
      ) {

        // handle accounts changing
        cb = (err, res) => {
          this._handleAccountsChanged(
            res.result || [],
            payload.method === 'eth_accounts',
            isInternal,
          )
          userCallback(err, res)
        }
      }
    }

    this.rpcEngine.handle(payload, cb)
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

/**
 * Gets experimental _metamask API as Proxy.
 */
function getExperimentalApi (instance) {
  return new Proxy(
    {

      /**
       * Determines if MetaMask is unlocked by the user.
       *
       * @returns {Promise<boolean>} - Promise resolving to true if MetaMask is currently unlocked
       */
      isUnlocked: async () => {
        if (instance._state.isUnlocked === undefined) {
          await new Promise(
            (resolve) => instance.publicConfigStore.once('update', () => resolve()),
          )
        }
        return instance._state.isUnlocked
      },

      /**
       * Make a batch request.
       */
      sendBatch: async (requests) => {

        // basic input validation
        if (!Array.isArray(requests)) {
          throw ethErrors.rpc.invalidRequest({
            message: 'Batch requests must be made with an array of request objects.',
            data: requests,
          })
        }

        return new Promise((resolve, reject) => {
          try {
            instance._sendAsync(
              requests,
              getRpcPromiseCallback(resolve, reject),
            )
          } catch (error) {
            reject(error)
          }
        })
      },

      // TODO:deprecate:2020-Q1 isEnabled, isApproved
      /**
       * Deprecated. Will be removed in Q1 2020.
       * Synchronously determines if this domain is currently enabled, with a potential false negative if called to soon
       *
       * @returns {boolean} - returns true if this domain is currently enabled
       */
      isEnabled: () => {
        return Array.isArray(instance._state.accounts) && instance._state.accounts.length > 0
      },

      /**
       * Deprecated. Will be removed in Q1 2020.
       * Asynchronously determines if this domain is currently enabled
       *
       * @returns {Promise<boolean>} - Promise resolving to true if this domain is currently enabled
       */
      isApproved: async () => {
        if (instance._state.accounts === undefined) {
          await new Promise(
            (resolve) => instance.once('accountsChanged', () => resolve()),
          )
        }
        return Array.isArray(instance._state.accounts) && instance._state.accounts.length > 0
      },
    },
    {
      get: (obj, prop) => {

        if (!instance._state.sentWarnings.experimentalMethods) {
          log.warn(messages.warnings.experimentalMethods)
          instance._state.sentWarnings.experimentalMethods = true
        }
        return obj[prop]
      },
    },
  )
}
