import Fastify from 'fastify'

const PORT = Number(process.env.PORT ?? '3001')

const app = Fastify({ logger: true })

app.get('/health', () => {
  return { status: 'ok' }
})

await app.listen({ port: PORT, host: '127.0.0.1' })
