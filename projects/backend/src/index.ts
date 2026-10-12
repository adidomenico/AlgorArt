import { buildApp } from './app.js'

const PORT = Number(process.env.PORT ?? '3001')

const app = buildApp()

await app.listen({ port: PORT, host: '127.0.0.1' })
