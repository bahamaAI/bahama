import { useParams, useLocation, Link } from 'react-router-dom'
import Logo from '../components/Logo'

function fmtPrice(cents: number) {
  return `$${(cents / 100).toFixed(2)}`
}

export default function Confirmation() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const state = location.state as {
    product?: string
    quantity?: number
    total?: number
    fulfillment?: string
    payment?: string
    email?: string
  } | null

  return (
    <div className="confirm-page">
      <div className="card card-lg confirm-card">
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
          <Logo size={32} />
        </div>

        <div className="confirm-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>

        <div className="confirm-order-num">Order #{id}</div>
        <p className="confirm-subtitle">
          Your order is confirmed and saved to the database.
        </p>

        {state && (
          <div className="confirm-details card" style={{ padding: '4px 16px' }}>
            {state.product && (
              <div className="confirm-detail-row">
                <span className="confirm-detail-label">Item</span>
                <span className="confirm-detail-val">{state.quantity}× {state.product}</span>
              </div>
            )}
            {state.total !== undefined && (
              <div className="confirm-detail-row">
                <span className="confirm-detail-label">Total</span>
                <span className="confirm-detail-val">{fmtPrice(state.total)}</span>
              </div>
            )}
            {state.fulfillment && (
              <div className="confirm-detail-row">
                <span className="confirm-detail-label">Fulfillment</span>
                <span className="confirm-detail-val" style={{ textTransform: 'capitalize' }}>
                  {state.fulfillment === 'pickup' ? '🏪 Local Pickup' : '📦 Shipping'}
                </span>
              </div>
            )}
            {state.payment && (
              <div className="confirm-detail-row">
                <span className="confirm-detail-label">Payment</span>
                <span className="confirm-detail-val" style={{ textTransform: 'capitalize' }}>
                  {state.payment === 'paid' ? '✅ Paid' : state.payment === 'invoice' ? '🧾 Invoice' : '💳 Pay later'}
                </span>
              </div>
            )}
            {state.email && (
              <div className="confirm-detail-row">
                <span className="confirm-detail-label">Email</span>
                <span className="confirm-detail-val">{state.email}</span>
              </div>
            )}
          </div>
        )}

        <div style={{ background: 'var(--bg-warm)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '12px 14px', marginBottom: 24, fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          ✦ This order is persisted in a real cloud database. Head to the dashboard to see it appear with status <strong>New</strong>, and watch inventory decrement in real time.
        </div>

        <div className="confirm-actions">
          <Link to="/new-order" className="btn btn-secondary">← Place Another</Link>
          <Link to="/" className="btn btn-primary">View in Dashboard →</Link>
        </div>
      </div>
    </div>
  )
}
