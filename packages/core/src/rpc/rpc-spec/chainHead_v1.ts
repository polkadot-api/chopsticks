import { Block } from '../../blockchain/block.js'
import { Handler, SubscriptionManager } from '../shared.js'
import { HexString } from '@polkadot/util/types'
import { defaultLogger } from '../../logger.js'

const logger = defaultLogger.child({ name: 'rpc-chainHead_v1' })

const callbacks = new Map<string, (data: any) => void>()

async function afterResponse(fn: () => void) {
  await Promise.resolve()
  fn()
}

export const chainHead_v1_follow: Handler<[boolean], string> = async (
  context,
  [withRuntime],
  { subscribe }: SubscriptionManager,
) => {
  const update = async (block: Block) => {
    logger.trace({ hash: block.hash }, 'chainHead_v1_follow')

    const getNewRuntime = async () => {
      const [runtime, previousRuntime] = await Promise.all([
        block.runtimeVersion,
        block.parentBlock.then((b) => b?.runtimeVersion),
      ])
      const hasNewRuntime =
        runtime.implVersion !== previousRuntime?.implVersion || runtime.specVersion !== previousRuntime.specVersion
      return hasNewRuntime ? runtime : null
    }
    const newRuntime = withRuntime ? await getNewRuntime() : null

    callback({
      event: 'newBlock',
      blockHash: block.hash,
      parentBlockHash: block.parentBlock,
      newRuntime,
    })
    callback({
      event: 'bestBlockChanged',
      bestBlockHash: block.hash,
    })
    callback({
      event: 'finalized',
      finalizedBlockHashes: [block.hash],
      prunedBlockHashes: [],
    })
  }

  const id = context.chain.headState.subscribeHead(update)

  const cleanup = () => {
    context.chain.headState.unsubscribeHead(id)
    callbacks.delete(id)
  }
  const callback = subscribe('chainHead_v1_followEvent', id, cleanup)

  callbacks.set(id, callback)

  afterResponse(async () => {
    callback({
      event: 'initialized',
      finalizedBlockHashes: [context.chain.head.hash],
      finalizedBlockRuntime: withRuntime ? await context.chain.head.runtimeVersion : null,
    })
  })

  return id
}

export const chainHead_v1_unfollow: Handler<[string], null> = async (_, [followSubscription], { unsubscribe }) => {
  unsubscribe(followSubscription)

  return null
}

export const chainHead_v1_header: Handler<[string, HexString], HexString | null> = async (
  context,
  [followSubscription, hash],
) => {
  if (!callbacks.has(followSubscription)) return null
  const block = await context.chain.getBlock(hash)

  return block ? (await block.header).toHex() : null
}

type OperationStarted = {
  result: 'started'
  operationId: string
}
const operationStarted = (operationId: string): OperationStarted => ({ result: 'started', operationId })
const randomId = () => Math.random().toString(36).substring(2)

export const chainHead_v1_call: Handler<[string, HexString, string, HexString], OperationStarted> = async (
  context,
  [followSubscription, hash, method, callParameters],
) => {
  const operationId = randomId()

  afterResponse(async () => {
    const block = await context.chain.getBlock(hash)

    if (!block) {
      callbacks.get(followSubscription)?.({
        event: 'operationError',
        operationId,
        error: `Block ${hash} not found`,
      })
    } else {
      const resp = await block.call(method, [callParameters])
      callbacks.get(followSubscription)?.({
        event: 'operationCallDone',
        operationId,
        output: resp.result,
      })
    }
  })

  return operationStarted(operationId)
}
