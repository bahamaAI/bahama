import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import Logo from '../components/Logo'
import ProductIcon from '../components/ProductIcon'
import { api, type Product } from '../lib/api'

function fmtPrice(cents: number) {
  return `$${(cents / 100).toFixed(2)}`
}

export default function OrderForm() {
  const navigate = useNavigate()
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null)
  const [quantity, setQuantity] = useState(1)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [fulfillment, setFulfillment] = useState<'pickup' | 'shipping'>('shipping')
  const [payment, setPayment] = useState<'unpaid' | 'paid' | 'invoice'>('unpaid')

  useEffect(() => {
    api.getProducts()
      .then(p => { setProducts(p); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const total = selectedProduct ? selectedProduct.price_cents * quantity : 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedProduct) { setError('Please select a product.'); return }
    if (!name.trim()) { setError('Please enter your name.'); return }
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Please enter a valid email.'); return }
    setError('')
    setSubmitting(true)
    try {
      const result = await api.createOrder({
        customer_name: name,
        customer_email: email,
        fulfillment_type: fulfillment,
        payment_status: payment,
        items: [{ product_id: selectedProduct.id, quantity }],
      })
      navigate(`/order/${result.order_id}`, {
        state: { product: selectedProduct.name, quantity, total, fulfillment, payment, email },
      })
    } catch (err) {
      setError((err as Error).message)
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="loading-page page-wrap">
        <div className="spinner" />
        <span className="text-muted text-sm">Loading products…</span>
      </div>
    )
  }

  return (
    <div className="page-wrap">
      <header className="order-header">
        <div className="order-header-inner">
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <Link to="/" className="btn btn-secondary btn-sm" style={{ gap: 6 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 5l-7 7 7 7"/>
              </svg>
              Dashboard
            </Link>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-subtle)', fontSize: 13 }}>
              <span>/</span>
              <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>New Order</span>
            </div>
          </div>
          <Logo size={30} />
        </div>
      </header>

      <main className="order-body">
        <div className="container-sm">
          <div className="order-hero">
            <h1>Place an Order</h1>
            <p>Choose a product, fill in your details, and we'll take care of the rest.</p>
          </div>

          <form onSubmit={handleSubmit}>
            {/* Product selection */}
            <div className="card card-lg" style={{ marginBottom: 20 }}>
              <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)' }}>
                <h3 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-muted)', fontWeight: 700 }}>
                  1 · Select a Product
                </h3>
              </div>
              <div style={{ padding: '20px 24px' }}>
                <div className="product-grid">
                  {products.map(p => {
                    const outOfStock = p.stock === 0
                    const lowStock = p.stock > 0 && p.stock <= 5
                    const isSelected = selectedProduct?.id === p.id
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className={`product-card${isSelected ? ' selected' : ''}${outOfStock ? ' out-of-stock' : ''}`}
                        onClick={() => { if (!outOfStock) { setSelectedProduct(p); setQuantity(1) } }}
                        disabled={outOfStock}
                      >
                        {isSelected && (
                          <div className="product-check">✓</div>
                        )}
                        <div className="product-icon-wrap">
                          <ProductIcon sku={p.sku} size={52} />
                        </div>
                        <div className="product-name">{p.name}</div>
                        <div className="product-price">{fmtPrice(p.price_cents)}</div>
                        <div className={`product-stock${lowStock ? ' low' : ''}`}>
                          {outOfStock ? '⚠ Out of stock' : lowStock ? `⚠ Only ${p.stock} left` : `${p.stock} in stock`}
                        </div>
                      </button>
                    )
                  })}
                </div>

                {selectedProduct && (
                  <div style={{ marginTop: 20, padding: '14px 16px', background: 'var(--bg-warm)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>
                      Quantity
                    </div>
                    <div className="qty-control">
                      <button
                        type="button"
                        className="qty-btn"
                        onClick={() => setQuantity(q => Math.max(1, q - 1))}
                        disabled={quantity <= 1}
                      >−</button>
                      <span className="qty-val">{quantity}</span>
                      <button
                        type="button"
                        className="qty-btn"
                        onClick={() => setQuantity(q => Math.min(selectedProduct.stock, q + 1))}
                        disabled={quantity >= selectedProduct.stock}
                      >+</button>
                    </div>
                    <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-subtle)' }}>
                      {selectedProduct.description}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Customer info */}
            <div className="card card-lg" style={{ marginBottom: 20 }}>
              <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)' }}>
                <h3 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-muted)', fontWeight: 700 }}>
                  2 · Your Details
                </h3>
              </div>
              <div style={{ padding: '20px 24px' }}>
                <div className="order-form-grid">
                  <div className="form-group">
                    <label className="form-label">Name</label>
                    <input
                      className="form-input"
                      type="text"
                      placeholder="Your full name"
                      value={name}
                      onChange={e => setName(e.target.value)}
                      autoComplete="name"
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Email</label>
                    <input
                      className="form-input"
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      autoComplete="email"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Fulfillment & payment */}
            <div className="card card-lg" style={{ marginBottom: 20 }}>
              <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)' }}>
                <h3 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-muted)', fontWeight: 700 }}>
                  3 · Delivery & Payment
                </h3>
              </div>
              <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
                <div className="form-group">
                  <label className="form-label">Fulfillment</label>
                  <div className="pill-group">
                    {(['shipping', 'pickup'] as const).map(f => (
                      <button
                        key={f}
                        type="button"
                        className={`pill-btn${fulfillment === f ? ' active' : ''}`}
                        onClick={() => setFulfillment(f)}
                      >
                        {f === 'shipping' ? '📦 Shipping' : '🏪 Local Pickup'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Payment Status</label>
                  <div className="pill-group">
                    {([
                      ['unpaid', '💳 Pay Later'],
                      ['paid', '✅ Already Paid'],
                      ['invoice', '🧾 Request Invoice'],
                    ] as const).map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        className={`pill-btn${payment === val ? ' active' : ''}`}
                        onClick={() => setPayment(val)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Order summary + submit */}
            {selectedProduct && (
              <div style={{ marginBottom: 20 }}>
                <div className="order-summary">
                  <div>
                    <div className="order-total-label">
                      {quantity}× {selectedProduct.name}
                    </div>
                    <div className="order-total-val">
                      {fmtPrice(total)}
                      <span style={{ marginLeft: 6 }}>
                        {payment === 'paid' ? '· Paid' : payment === 'invoice' ? '· Invoice' : '· Due on receipt'}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-subtle)' }}>
                    {fulfillment === 'shipping' ? '📦 Ships to you' : '🏪 Pickup'}
                  </div>
                </div>
              </div>
            )}

            {error && <p className="form-error" style={{ marginBottom: 12 }}>{error}</p>}

            <button
              type="submit"
              className="btn btn-primary btn-lg btn-full"
              disabled={submitting || !selectedProduct}
            >
              {submitting ? (
                <><span className="spinner" style={{ width: 16, height: 16, borderWidth: 2, borderTopColor: '#fff' }} /> Placing order…</>
              ) : (
                `Place Order${selectedProduct ? ` · ${fmtPrice(total)}` : ''}`
              )}
            </button>

            <p style={{ textAlign: 'center', marginTop: 12, fontSize: 12, color: 'var(--text-subtle)' }}>
              Your order is stored in a real database. Inventory updates immediately.
            </p>
          </form>
        </div>
      </main>
    </div>
  )
}
