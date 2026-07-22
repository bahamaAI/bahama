import { neon } from '@neondatabase/serverless'
import { Hono, type Context } from 'hono'

type Env = {
  Bindings: {
    DATABASE_URL?: string
  }
}

interface ProductRow {
  id: number
  name: string
  sku: string
  description: string
  price_cents: number
  stock: number
  reorder_threshold: number
}

interface OrderInput {
  name: string
  email: string
  status: string
  fulfillment: string
  payment: string
  items: [sku: string, quantity: number][]
  hoursAgo: number
}

const app = new Hono<Env>()

const STOCK_LEVELS: Record<string, number> = {
  'COFFEE-001': 45,
  'MUG-001': 20,
  'TOTE-001': 30,
  'NB-001': 15,
  'GIFT-001': 10,
}

const DEMO_ORDERS: OrderInput[] = [
  { name: 'Maya Chen', email: 'maya@example.com', status: 'new', fulfillment: 'shipping', payment: 'paid', items: [['COFFEE-001', 2], ['TOTE-001', 1]], hoursAgo: 2 },
  { name: 'James Okafor', email: 'james@example.com', status: 'packed', fulfillment: 'pickup', payment: 'paid', items: [['MUG-001', 3]], hoursAgo: 5 },
  { name: 'Sofia Martinez', email: 'sofia@example.com', status: 'shipped', fulfillment: 'shipping', payment: 'invoice', items: [['COFFEE-001', 5], ['NB-001', 3]], hoursAgo: 26 },
  { name: 'Priya Sharma', email: 'priya@example.com', status: 'completed', fulfillment: 'pickup', payment: 'paid', items: [['GIFT-001', 1], ['MUG-001', 1]], hoursAgo: 50 },
  { name: 'Tom Whitfield', email: 'tom@example.com', status: 'ready_for_pickup', fulfillment: 'pickup', payment: 'unpaid', items: [['NB-001', 10]], hoursAgo: 3 },
  { name: 'Alice Johnson', email: 'alice@example.com', status: 'new', fulfillment: 'shipping', payment: 'unpaid', items: [['GIFT-001', 2], ['COFFEE-001', 1]], hoursAgo: 1 },
  { name: 'Ben Torres', email: 'ben@example.com', status: 'cancelled', fulfillment: 'pickup', payment: 'unpaid', items: [['TOTE-001', 4]], hoursAgo: 48 },
  { name: 'Carlos Ruiz', email: 'carlos@example.com', status: 'new', fulfillment: 'shipping', payment: 'paid', items: [['MUG-001', 1], ['NB-001', 1]], hoursAgo: 0.5 },
]

function getDb(c: Context<Env>) {
  const connectionString = c.env?.DATABASE_URL || process.env.DATABASE_URL
  if (!connectionString || !/^postgres(?:ql)?:\/\//.test(connectionString)) {
    throw new Error('DATABASE_URL is not configured')
  }
  return neon(connectionString)
}

function toInt(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0)
}

async function seedOrders(c: Context<Env>) {
  const sql = getDb(c)
  const products = await sql`SELECT id, sku, price_cents FROM products`
  const bySku = new Map(
    products.map((product) => [String(product.sku), {
      id: toInt(product.id),
      price_cents: toInt(product.price_cents),
    }]),
  )

  for (const sku of Object.keys(STOCK_LEVELS)) {
    if (!bySku.has(sku)) throw new Error(`Seed product ${sku} is missing`)
  }

  const queries = [
    sql`TRUNCATE order_items, orders RESTART IDENTITY`,
    ...Object.entries(STOCK_LEVELS).map(([sku, stock]) =>
      sql`UPDATE products SET stock = ${stock} WHERE sku = ${sku}`,
    ),
  ]

  DEMO_ORDERS.forEach((order, index) => {
    const orderId = index + 1
    const createdAt = new Date(Date.now() - order.hoursAgo * 3_600_000)
    const totalCents = order.items.reduce((total, [sku, quantity]) => {
      return total + bySku.get(sku)!.price_cents * quantity
    }, 0)

    queries.push(sql`
      INSERT INTO orders (
        id, customer_name, customer_email, status, fulfillment_type,
        payment_status, total_cents, created_at, updated_at
      ) VALUES (
        ${orderId}, ${order.name}, ${order.email}, ${order.status}, ${order.fulfillment},
        ${order.payment}, ${totalCents}, ${createdAt}, ${createdAt}
      )
    `)

    for (const [sku, quantity] of order.items) {
      const product = bySku.get(sku)!
      queries.push(sql`
        INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
        VALUES (${orderId}, ${product.id}, ${quantity}, ${product.price_cents})
      `)
      if (order.status !== 'cancelled') {
        queries.push(sql`
          UPDATE products SET stock = stock - ${quantity} WHERE id = ${product.id}
        `)
      }
    }
  })

  queries.push(sql`
    SELECT setval(pg_get_serial_sequence('orders', 'id'), ${DEMO_ORDERS.length}, true)
  `)
  await sql.transaction(queries)
}

app.onError((error, c) => {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined
  console.error('Sunset Supply Co API request failed', code ? { code } : { name: error.name })
  return c.json({ error: 'The server could not complete this request.' }, 500)
})

app.get('/api/health', async (c) => {
  const sql = getDb(c)
  await sql`SELECT 1`
  return c.json({ ok: true })
})

app.post('/api/admin/seed', async (c) => {
  await seedOrders(c)
  return c.json({ ok: true })
})

app.get('/api/products', async (c) => {
  const sql = getDb(c)
  const products = await sql`
    SELECT id, name, sku, description, price_cents, stock
    FROM products
    WHERE active = true
    ORDER BY id
  `
  return c.json({ products })
})

app.post('/api/orders', async (c) => {
  const sql = getDb(c)
  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: 'Invalid request body' }, 400)

  const { customer_name, customer_email, fulfillment_type, payment_status, items } = body

  if (typeof customer_name !== 'string' || customer_name.trim().length < 2 || customer_name.length > 100) {
    return c.json({ error: 'Customer name must be 2–100 characters' }, 400)
  }
  if (typeof customer_email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer_email)) {
    return c.json({ error: 'Invalid email address' }, 400)
  }
  if (!['pickup', 'shipping'].includes(fulfillment_type)) {
    return c.json({ error: 'Invalid fulfillment type' }, 400)
  }
  if (!['unpaid', 'paid', 'invoice'].includes(payment_status)) {
    return c.json({ error: 'Invalid payment status' }, 400)
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > 5) {
    return c.json({ error: 'Must include 1–5 items' }, 400)
  }

  const requested = new Map<number, number>()
  for (const item of items) {
    const productId = Number.parseInt(item?.product_id, 10)
    const quantity = Number.parseInt(item?.quantity, 10)
    if (!Number.isInteger(productId) || !Number.isInteger(quantity) || quantity < 1) {
      return c.json({ error: 'Invalid item data' }, 400)
    }
    const combinedQuantity = (requested.get(productId) ?? 0) + quantity
    if (combinedQuantity > 20) return c.json({ error: 'Item quantity must be 1–20' }, 400)
    requested.set(productId, combinedQuantity)
  }

  let totalCents = 0
  const validated: { product: ProductRow; quantity: number }[] = []
  for (const [productId, quantity] of requested) {
    const rows = await sql`
      SELECT id, name, sku, description, price_cents, stock, reorder_threshold
      FROM products
      WHERE id = ${productId} AND active = true
    `
    const product = rows[0] as ProductRow | undefined
    if (!product) return c.json({ error: 'Product not found' }, 400)
    if (toInt(product.stock) < quantity) {
      return c.json({ error: `Not enough stock for "${product.name}"` }, 400)
    }
    product.id = toInt(product.id)
    product.price_cents = toInt(product.price_cents)
    product.stock = toInt(product.stock)
    totalCents += product.price_cents * quantity
    validated.push({ product, quantity })
  }

  const idRows = await sql`SELECT nextval(pg_get_serial_sequence('orders', 'id'))::int AS id`
  const orderId = toInt(idRows[0]?.id)
  const now = new Date()
  const queries = [sql`
    INSERT INTO orders (
      id, customer_name, customer_email, status, fulfillment_type,
      payment_status, total_cents, created_at, updated_at
    ) VALUES (
      ${orderId}, ${customer_name.trim()}, ${customer_email.trim().toLowerCase()}, 'new',
      ${fulfillment_type}, ${payment_status}, ${totalCents}, ${now}, ${now}
    )
  `]

  for (const { product, quantity } of validated) {
    queries.push(sql`
      WITH updated AS (
        UPDATE products
        SET stock = stock - ${quantity}
        WHERE id = ${product.id} AND stock >= ${quantity}
        RETURNING id, price_cents
      )
      INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
      SELECT ${orderId}, id, ${quantity}, price_cents FROM updated
    `)
  }
  queries.push(sql`
    SELECT 1 / CASE WHEN COUNT(*) = ${validated.length} THEN 1 ELSE 0 END
    FROM order_items
    WHERE order_id = ${orderId}
  `)

  try {
    await sql.transaction(queries)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '22012') {
      return c.json({ error: 'Inventory changed while the order was submitted. Please try again.' }, 409)
    }
    throw error
  }

  return c.json({ ok: true, order_id: orderId })
})

app.get('/api/admin/stats', async (c) => {
  const sql = getDb(c)
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const [openOrders, todayRevenue, lowStock, inventoryValue] = await sql.transaction([
    sql`SELECT COUNT(*)::int AS count FROM orders WHERE status NOT IN ('completed', 'cancelled')`,
    sql`SELECT COALESCE(SUM(total_cents), 0)::bigint AS total FROM orders WHERE created_at >= ${today} AND status != 'cancelled'`,
    sql`SELECT COUNT(*)::int AS count FROM products WHERE stock <= reorder_threshold AND active = true`,
    sql`SELECT COALESCE(SUM(stock * price_cents), 0)::bigint AS total FROM products WHERE active = true`,
  ], { readOnly: true })

  return c.json({
    open_orders: toInt(openOrders[0]?.count),
    today_revenue_cents: toInt(todayRevenue[0]?.total),
    low_stock_count: toInt(lowStock[0]?.count),
    inventory_value_cents: toInt(inventoryValue[0]?.total),
  })
})

app.get('/api/admin/orders', async (c) => {
  const sql = getDb(c)
  const status = c.req.query('status') || null
  const search = c.req.query('search')?.trim() || null
  const searchPattern = search ? `%${search}%` : null

  const orders = await sql`
    SELECT
      o.id, o.customer_name, o.customer_email, o.status, o.fulfillment_type,
      o.payment_status, o.total_cents, o.created_at,
      STRING_AGG(p.name || ' ×' || oi.quantity, ' · ' ORDER BY oi.id) AS items_summary
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE (${status}::text IS NULL OR o.status = ${status})
      AND (${searchPattern}::text IS NULL OR o.customer_name ILIKE ${searchPattern} OR o.customer_email ILIKE ${searchPattern})
    GROUP BY o.id
    ORDER BY o.created_at DESC
    LIMIT 100
  `
  return c.json({ orders })
})

app.patch('/api/admin/orders/:id/status', async (c) => {
  const sql = getDb(c)
  const id = Number.parseInt(c.req.param('id'), 10)
  const body = await c.req.json().catch(() => null)
  const validStatuses = ['new', 'packed', 'shipped', 'ready_for_pickup', 'completed', 'cancelled']
  if (!Number.isInteger(id) || !body || !validStatuses.includes(body.status)) {
    return c.json({ error: 'Invalid order status' }, 400)
  }

  const updated = await sql`
    UPDATE orders SET status = ${body.status}, updated_at = NOW()
    WHERE id = ${id}
    RETURNING id
  `
  if (updated.length === 0) return c.json({ error: 'Order not found' }, 404)
  return c.json({ ok: true })
})

app.get('/api/admin/products', async (c) => {
  const sql = getDb(c)
  const products = await sql`
    SELECT id, name, sku, description, price_cents, stock, reorder_threshold
    FROM products
    WHERE active = true
    ORDER BY id
  `
  return c.json({ products })
})

app.patch('/api/admin/products/:id/restock', async (c) => {
  const sql = getDb(c)
  const id = Number.parseInt(c.req.param('id'), 10)
  const body = await c.req.json().catch(() => null)
  const amount = Number.parseInt(body?.amount, 10)
  if (!Number.isInteger(id) || !Number.isInteger(amount) || amount < 1 || amount > 500) {
    return c.json({ error: 'Amount must be 1–500' }, 400)
  }

  const updated = await sql`
    UPDATE products SET stock = stock + ${amount}
    WHERE id = ${id}
    RETURNING id
  `
  if (updated.length === 0) return c.json({ error: 'Product not found' }, 404)
  return c.json({ ok: true })
})

export default app
