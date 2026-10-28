// dsh-vpn engine — public façade.
//
// Pure Node ESM engine layer for the dsh-vpn plugin: mihomo lifecycle
// management, subscription fetching/parsing and proxy probing. No external
// dependencies, only node: built-ins.
//
// Typical host usage:
//   const { binaryPath, dataDir } = resolvePaths({ profileDir })
//   const sub = await fetchSubscription(subscriptionUrl)
//   const yaml = buildRuntimeConfig({ yaml: sub.clashYaml, mixedPort, controllerPort, secret, mode })
//   const engine = new MihomoEngine({ binaryPath, dataDir, log })
//   await engine.start(yaml)

import {
  buildRuntimeConfig,
  pickFreePort,
  PLUGIN_ROOT,
  resolvePaths,
} from './config.mjs'
import { DEFAULT_PROBE_URL, MihomoEngine } from './mihomo.mjs'
import { probeThroughProxy } from './probe.mjs'
import {
  fetchSubscription,
  isPseudoNodeName,
  linksToClashYaml,
  parseClashYaml,
  parseShareLinks,
  readCachedSubscription,
  SUBSCRIPTION_UA,
  subscriptionCachePath,
  writeCachedSubscription,
} from './subscription.mjs'
import { parseYaml } from './yaml.mjs'

export {
  buildRuntimeConfig,
  DEFAULT_PROBE_URL,
  fetchSubscription,
  isPseudoNodeName,
  linksToClashYaml,
  MihomoEngine,
  parseClashYaml,
  parseShareLinks,
  parseYaml,
  pickFreePort,
  PLUGIN_ROOT,
  probeThroughProxy,
  readCachedSubscription,
  resolvePaths,
  SUBSCRIPTION_UA,
  subscriptionCachePath,
  writeCachedSubscription,
}

export default {
  buildRuntimeConfig,
  DEFAULT_PROBE_URL,
  fetchSubscription,
  isPseudoNodeName,
  linksToClashYaml,
  MihomoEngine,
  parseClashYaml,
  parseShareLinks,
  parseYaml,
  pickFreePort,
  PLUGIN_ROOT,
  probeThroughProxy,
  readCachedSubscription,
  resolvePaths,
  SUBSCRIPTION_UA,
  subscriptionCachePath,
  writeCachedSubscription,
}
