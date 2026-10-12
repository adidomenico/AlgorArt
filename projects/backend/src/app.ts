import algosdk from 'algosdk'
import Fastify from 'fastify'
import { authenticate, createChallenge, verifyChallenge } from './auth.js'
import { PinningError, pinImage, pinJson } from './uploads.js'

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

/**
 * Build the Fastify application with all routes. Exported for inject-based tests.
 *
 * @returns The configured Fastify instance (not yet listening).
 */
export function buildApp() {
  const app = Fastify({ logger: true })

  // Browsers call the API cross-origin (frontend :5173 -> backend :3001). Auth rides on Bearer headers, not
  // cookies, so a wildcard origin is sufficient - no credentials mode involved.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('access-control-allow-origin', '*')
    reply.header('access-control-allow-methods', 'GET, POST, OPTIONS')
    reply.header('access-control-allow-headers', 'authorization, content-type')
    return payload
  })

  app.options('/*', (_request, reply) => {
    reply.code(204).send()
  })

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

  app.post<{ Body: { address: unknown; data: unknown; authenticatorData: unknown; signature: unknown } }>(
    '/auth/verify',
    async (request, reply) => {
      const { address, data, authenticatorData, signature } = request.body
      if (
        typeof address !== 'string' ||
        typeof data !== 'string' ||
        typeof authenticatorData !== 'string' ||
        typeof signature !== 'string'
      ) {
        await reply.code(400).send({ error: 'address, data, authenticatorData, and signature are required' })
        return
      }
      try {
        await reply.send({ token: await verifyChallenge(address, data, authenticatorData, signature) })
      } catch {
        await reply.code(400).send({ error: 'challenge verification failed' })
      }
    },
  )

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
        request.log.error({ err: error }, 'upload failed')
        if (error instanceof PinningError) {
          await reply.code(502).send({ error: 'pinning failed' })
        } else {
          await reply.code(500).send({ error: 'upload failed' })
        }
      }
    },
  )

  // Authenticated: pinning spends the platform's Pinata quota.
  app.post<{ Body: { name: unknown; description: unknown; image: unknown; category: unknown } }>(
    '/uploads/metadata',
    { preHandler: authenticate },
    async (request, reply) => {
      const { name, description, image, category } = request.body
      if (
        typeof name !== 'string' ||
        name === '' ||
        typeof image !== 'string' ||
        image === '' ||
        (description !== undefined && typeof description !== 'string') ||
        (category !== undefined && typeof category !== 'string')
      ) {
        await reply.code(400).send({ error: 'a name and image are required' })
        return
      }
      const metadata: Record<string, string> = { name, image }
      if (description !== undefined && description !== '') metadata.description = description
      if (category !== undefined && category !== '') metadata.category = category
      try {
        await reply.send({ cid: await pinJson(metadata) })
      } catch (error) {
        request.log.error({ err: error }, 'metadata upload failed')
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
