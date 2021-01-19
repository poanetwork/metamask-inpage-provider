const MetaMaskInpageProvider = require('./src/MetaMaskInpageProvider')
const { initializeProvider, setGlobalProvider } = require('./src/initializeProvider')

module.exports = {
  initializeProvider,
  MetaMaskInpageProvider,
  setGlobalProvider,
}
