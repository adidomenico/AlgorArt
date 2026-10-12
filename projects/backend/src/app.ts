import algosdk from 'algosdk'
import Fastify from 'fastify'
import { authenticate, createChallenge, verifyChallenge } from './auth.js'
import { PinningError, pinImage } from './uploads.js'

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

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

  // Raw image bytes (no multipart parser needed); anything else 400s below.
  app.addContentTypeParser(/^image\//, { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body)
  })

  // Authenticated: pinning spends the platform's Pinata quota.
  // The image/* parser above only runs when that content-type is present, so both generics hold at runtime.
  app.post<{ Body: Uint8Array<ArrayBuffer>; Headers: { 'content-type': string } }>(
    '/uploads',
    { preHandler: authenticate, bodyLimit: MAX_UPLOAD_BYTES },
    async (request, reply) => {
      if (!(request.body instanceof Uint8Array)) {
        await reply.code(400).send({ error: 'an image body is required' })
        return
      }
      try {
        await reply.send({ cid: await pinImage(request.body, request.headers['content-type']) })
      } catch (error) {
        if (error instanceof PinningError) {
          await reply.code(502).send({ error: 'pinning failed' })
        } else {
          await reply.code(500).send({ error: 'upload failed' })
        }
      }
    },
  )

  return app
}
