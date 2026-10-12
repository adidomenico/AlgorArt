import algosdk from 'algosdk'
import Fastify from 'fastify'
import { authenticate, createChallenge, verifyChallenge } from './auth.js'

/**
 * Build the Fastify application with all routes. Exported for inject-based tests.
 *
 * @returns The configured Fastify instance (not yet listening).
 */
export function buildApp() {
  const app = Fastify({ logger: true })

  app.get('/health', () => {
    return { status: 'ok' }
  })

  app.post<{ Body: { address: unknown } }>('/auth/challenge', async (request, reply) => {
    if (typeof request.body.address !== 'string' || !algosdk.isValidAddress(request.body.address)) {
      await reply.code(400).send({ error: 'a valid address is required' })
      return
    }
    await reply.send(await createChallenge(request.body.address))
  })

  app.post<{ Body: { address: unknown; message: unknown; signature: unknown } }>('/auth/verify', async (request, reply) => {
    const { address, message, signature } = request.body
    if (typeof address !== 'string' || typeof message !== 'string' || typeof signature !== 'string') {
      await reply.code(400).send({ error: 'address, message, and signature are required' })
      return
    }
    try {
      await reply.send({ token: await verifyChallenge(address, message, signature) })
    } catch {
      await reply.code(400).send({ error: 'challenge verification failed' })
    }
  })

  app.get('/me', { preHandler: authenticate }, (request) => {
    return { address: request.address }
  })

  return app
}
