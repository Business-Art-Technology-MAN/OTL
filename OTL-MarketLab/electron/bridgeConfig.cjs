/** Must stay aligned with `host/include/mlab/BridgeConstants.h` */
const path = require("path");
const { env } = process;

function getBridgeConnectOptions() {
  if (process.platform === "win32") {
    return { path: "\\\\.\\pipe\\OTL_MarketLab_CommBridge" };
  }
  return { path: env.MARKET_LAB_SOCKET || "/tmp/OTL_MarketLab_CommBridge.sock" };
}

module.exports = { getBridgeConnectOptions };
