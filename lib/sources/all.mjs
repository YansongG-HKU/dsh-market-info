/**
 * Aggregated adapter registry. Each module owns its own sources; this file only
 * concatenates them so the service has one list to hand to the runner.
 */
import { adapters as cnDisclosure } from './cn-disclosure.mjs'
import { adapters as usDisclosure } from './us-disclosure.mjs'
import { adapters as globalMacro } from './global-macro.mjs'
import { adapters as cnMacro } from './cn-macro.mjs'
import { adapters as flows } from './flows.mjs'
import { adapters as terminals } from './terminals.mjs'
import { adapters as marketFlow } from './market-flow.mjs'
import { adapters as futures } from './futures.mjs'
import { adapters as prediction } from './prediction.mjs'
import { adapters as shipping } from './shipping.mjs'
import { adapters as world } from './world.mjs'
import { adapters as rates } from './rates.mjs'
import { adapters as fx } from './fx.mjs'
import { adapters as corporate } from './corporate.mjs'
import { adapters as bond } from './bond.mjs'
import { adapters as options } from './options.mjs'
import { adapters as money } from './money.mjs'

export const adapters = [
  ...cnDisclosure,
  ...usDisclosure,
  ...globalMacro,
  ...cnMacro,
  ...flows,
  ...terminals,
  ...marketFlow,
  ...futures,
  ...prediction,
  ...shipping,
  ...world,
  ...rates,
  ...fx,
  ...corporate,
  ...bond,
  ...options,
  ...money,
]
