export interface Product {
  id: number
  name: string
  sku: string
  description: string
  price_cents: number
  stock: number
  reorder_threshold?: number
}

export interface Order {
  id: number
  customer_name: string
  customer_email: string
  status: OrderStatus
  fulfillment_type: 'pickup' | 'shipping'
  payment_status: 'paid' | 'unpaid' | 'invoice'
  total_cents: number
  created_at: string
  items_summary?: string
}

export type OrderStatus = 'new' | 'packed' | 'shipped' | 'ready_for_pickup' | 'completed' | 'cancelled'

export interface AdminStats {
  open_orders: number
  today_revenue_cents: number
  low_stock_count: number
  inventory_value_cents: number
}

const BASE = ''

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Request failed')
  return data as T
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Request failed')
  return data as T
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  const data = await res.json()
  if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Request failed')
  return data as T
}

export const api = {
  getProducts: () => get<{ products: Product[] }>('/api/products').then(d => d.products),

  createOrder: (payload: {
    customer_name: string
    customer_email: string
    fulfillment_type: string
    payment_status: string
    items: { product_id: number; quantity: number }[]
  }) => post<{ ok: boolean; order_id: number }>('/api/orders', payload),

  adminSeed: () => post<{ ok: boolean }>('/api/admin/seed', {}),

  adminStats: () => get<AdminStats>('/api/admin/stats'),
  adminOrders: (params?: { status?: string; search?: string }) => {
    const qs = new URLSearchParams()
    if (params?.status) qs.set('status', params.status)
    if (params?.search) qs.set('search', params.search)
    const q = qs.toString()
    return get<{ orders: Order[] }>(`/api/admin/orders${q ? '?' + q : ''}`).then(d => d.orders)
  },
  adminUpdateOrderStatus: (id: number, status: OrderStatus) =>
    patch<{ ok: boolean }>(`/api/admin/orders/${id}/status`, { status }),

  adminProducts: () => get<{ products: Product[] }>('/api/admin/products').then(d => d.products),
  adminRestock: (id: number, amount: number) =>
    patch<{ ok: boolean }>(`/api/admin/products/${id}/restock`, { amount }),
}
