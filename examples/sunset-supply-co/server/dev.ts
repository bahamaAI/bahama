import { serve } from '@hono/node-server'
import { loadEnv } from 'vite'
import app from './index.js'

const env = loadEnv('development', process.cwd(), '')
process.env.DATABASE_URL ||= env.DATABASE_URL

serve({
  fetch: app.fetch,
  port: 8787,
})

console.log('Sunset Supply Co API listening on http://localhost:8787')
