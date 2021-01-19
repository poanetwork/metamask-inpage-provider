module.exports = {
  errors: {
    disconnected: () => `MetaMask: Lost connection to MetaMask background process.`,
    sendSiteMetadata: () => `MetaMask: Failed to send site metadata. This is an internal error, please report this bug.`,
    unsupportedSync: (method) => `MetaMask: The MetaMask Web3 object does not support synchronous methods like ${method} without a callback parameter.`,
    invalidDuplexStream: () => 'Must provide a Node.js-style duplex stream.',
    invalidOptions: (maxEventListeners, shouldSendMetadata) => `Invalid options. Received: { maxEventListeners: ${maxEventListeners}, shouldSendMetadata: ${shouldSendMetadata} }`,
    invalidRequestArgs: () => `Expected a single, non-array, object argument.`,
    invalidRequestMethod: () => `'args.method' must be a non-empty string.`,
    invalidRequestParams: () => `'args.params' must be an object or array if provided.`,
    invalidLoggerObject: () => `'args.logger' must be an object if provided.`,
    invalidLoggerMethod: (method) => `'args.logger' must include required method '${method}'.`,
  },
  warnings: {
    // TODO:deprecate:2020-Q1
    autoReloadDeprecation: `MetaMask: MetaMask will stop reloading pages on network change in Q1 2020. For more information, see: https://medium.com/metamask/no-longer-reloading-pages-on-network-change-fbf041942b44 \nSet 'ethereum.autoRefreshOnNetworkChange' to 'false' to silence this warning: https://metamask.github.io/metamask-docs/API_Reference/Ethereum_Provider#ethereum.autorefreshonnetworkchange`,
    sendSyncDeprecation: `MetaMask: 'ethereum.send(...)' will return result-resolving Promises for all methods starting in Q1 2020. For more information, see: https://medium.com/metamask/deprecating-synchronous-provider-methods-82f0edbc874b`,
    // deprecated stuff yet to be scheduled for removal
    enableDeprecation: `MetaMask: 'ethereum.enable()' is deprecated and may be removed in the future. Please use "ethereum.send('eth_requestAccounts')" instead. For more information, see: https://eips.ethereum.org/EIPS/eip-1102`,
    isConnectedDeprecation: `MetaMask: 'ethereum.isConnected()' is deprecated and may be removed in the future. Please listen for the relevant events instead. For more information, see: https://eips.ethereum.org/EIPS/eip-1193`,
    sendAsyncDeprecation: `MetaMask: 'ethereum.sendAsync(...)' is deprecated and may be removed in the future. Please use 'ethereum.send(method: string, params: Array<any>)' instead. For more information, see: https://eips.ethereum.org/EIPS/eip-1193`,
    // misc
    experimentalMethods: `MetaMask: 'ethereum._metamask' exposes non-standard, experimental methods. They may be removed or changed without warning.`,
  },
}
