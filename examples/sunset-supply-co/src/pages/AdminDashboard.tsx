import {useState, useEffect, useCallback} from "react";
import {Link} from "react-router-dom";
import Logo from "../components/Logo";
import {
  api,
  type Order,
  type OrderStatus,
  type Product,
  type AdminStats,
} from "../lib/api";

function fmtPrice(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return "just now";
}

const STATUS_LABELS: Record<OrderStatus, string> = {
  new: "New",
  packed: "Packed",
  shipped: "Shipped",
  ready_for_pickup: "Ready for Pickup",
  completed: "Completed",
  cancelled: "Cancelled",
};

const ALL_STATUSES = Object.keys(STATUS_LABELS) as OrderStatus[];

function Toast({
  message,
  type,
  onDone,
}: {
  message: string;
  type: "success" | "error" | "info";
  onDone: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDone, 3000);
    return () => clearTimeout(t);
  }, [onDone]);
  return <div className={`toast ${type}`}>{message}</div>;
}

interface ToastState {
  message: string;
  type: "success" | "error" | "info";
}

export default function AdminDashboard() {
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState<ToastState | null>(null);
  const [restockAmounts, setRestockAmounts] = useState<Record<number, string>>(
    {},
  );
  const [restocking, setRestocking] = useState<Record<number, boolean>>({});

  function showToast(message: string, type: ToastState["type"] = "success") {
    setToast({message, type});
  }

  const loadAll = useCallback(async () => {
    try {
      const [s, o, p] = await Promise.all([
        api.adminStats(),
        api.adminOrders({
          status: statusFilter !== "all" ? statusFilter : undefined,
          search: search || undefined,
        }),
        api.adminProducts(),
      ]);
      setStats(s);
      setOrders(o);
      setProducts(p);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  async function handleSeed() {
    setSeeding(true);
    try {
      await api.adminSeed();
      showToast("Demo data reset successfully ✓");
      setStatusFilter("all");
      setSearch("");
      await loadAll();
    } catch (err) {
      showToast((err as Error).message, "error");
    } finally {
      setSeeding(false);
    }
  }

  async function handleStatusChange(orderId: number, status: OrderStatus) {
    setOrders((prev) =>
      prev.map((o) => (o.id === orderId ? {...o, status} : o)),
    );
    try {
      await api.adminUpdateOrderStatus(orderId, status);
      showToast(`Order #${orderId} → ${STATUS_LABELS[status]}`);
      setStats(await api.adminStats());
    } catch (err) {
      showToast((err as Error).message, "error");
      loadAll();
    }
  }

  async function handleRestock(product: Product) {
    const amount = parseInt(restockAmounts[product.id] || "10");
    if (isNaN(amount) || amount < 1) {
      showToast("Enter a valid quantity", "error");
      return;
    }
    setRestocking((r) => ({...r, [product.id]: true}));
    try {
      await api.adminRestock(product.id, amount);
      showToast(`Restocked ${product.name} +${amount}`);
      setRestockAmounts((a) => ({...a, [product.id]: ""}));
      setProducts(await api.adminProducts());
      setStats(await api.adminStats());
    } catch (err) {
      showToast((err as Error).message, "error");
    } finally {
      setRestocking((r) => ({...r, [product.id]: false}));
    }
  }

  if (!loading && loadError) {
    return (
      <div className='admin-page'>
        <div className='init-screen'>
          <div className='card card-lg init-card'>
            <div className='init-logo-wrap'>
              <Logo size={48} />
            </div>
            <h1>Sunset Supply Co is not connected yet</h1>
            <p>
              The dashboard could not reach its Neon database. Apply the
              Bahama plan to provision and migrate Neon, then try again.
            </p>
            <div className='init-tech-list'>
              {[
                {
                  icon: "🗄️",
                  color: "#eff6ff",
                  text: "Neon stores products, orders, and inventory",
                },
                {
                  icon: "▲",
                  color: "#f0fdf4",
                  text: "Vercel runs the frontend and Hono API",
                },
                {
                  icon: "🌴",
                  color: "#fff7ed",
                  text: "Bahama provisions, connects, and verifies the stack",
                },
              ].map((item, i) => (
                <div key={i} className='init-tech-item'>
                  <div
                    className='init-tech-icon'
                    style={{background: item.color, fontSize: 16}}
                  >
                    {item.icon}
                  </div>
                  {item.text}
                </div>
              ))}
            </div>
            <button
              className='btn btn-primary btn-lg btn-full'
              onClick={loadAll}
            >
              Try Again
            </button>
            <p className='text-muted text-sm' style={{marginTop: 12}}>{loadError}</p>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className='admin-page loading-page'>
        <div className='spinner' />
        <span className='text-muted text-sm'>Loading dashboard…</span>
      </div>
    );
  }

  const lowStockProducts = products.filter(
    (p) => p.stock <= (p.reorder_threshold ?? 5),
  );

  // ── Dashboard ─────────────────────────────────────────────────────────────
  return (
    <div className='admin-page'>
      {/* Nav */}
      <nav className='admin-nav'>
        <div className='admin-nav-inner'>
          <div className='admin-nav-title'>
            <Logo size={28} />
            <div className='admin-nav-pill'>Dashboard</div>
          </div>
          <div className='admin-nav-actions'>
            <button
              className='btn btn-ghost btn-sm'
              onClick={loadAll}
              title='Refresh data'
            >
              <svg
                width='14'
                height='14'
                viewBox='0 0 24 24'
                fill='none'
                stroke='currentColor'
                strokeWidth='2.5'
                strokeLinecap='round'
                strokeLinejoin='round'
              >
                <path d='M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16' />
              </svg>
              Refresh
            </button>
            <Link to='/new-order' className='btn btn-primary'>
              <svg
                width='15'
                height='15'
                viewBox='0 0 24 24'
                fill='none'
                stroke='currentColor'
                strokeWidth='2.5'
                strokeLinecap='round'
                strokeLinejoin='round'
              >
                <line x1='12' y1='5' x2='12' y2='19' />
                <line x1='5' y1='12' x2='19' y2='12' />
              </svg>
              New Order
            </Link>
          </div>
        </div>
      </nav>

      <div className='admin-content'>
        {/* Stats */}
        <div className='stats-grid'>
          <div className='stat-card'>
            <div className='stat-card-header'>
              <span className='stat-label'>Open Orders</span>
              <div className='stat-icon orange'>
                <svg
                  width='18'
                  height='18'
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='2'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                >
                  <path d='M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z' />
                  <line x1='3' y1='6' x2='21' y2='6' />
                  <path d='M16 10a4 4 0 0 1-8 0' />
                </svg>
              </div>
            </div>
            <div className='stat-value'>{stats?.open_orders ?? 0}</div>
            <div className='stat-sub'>Active in pipeline</div>
          </div>

          <div className='stat-card'>
            <div className='stat-card-header'>
              <span className='stat-label'>Today's Revenue</span>
              <div className='stat-icon green'>
                <svg
                  width='18'
                  height='18'
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='2'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                >
                  <line x1='12' y1='1' x2='12' y2='23' />
                  <path d='M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6' />
                </svg>
              </div>
            </div>
            <div className='stat-value'>
              {fmtPrice(stats?.today_revenue_cents ?? 0)}
            </div>
            <div className='stat-sub'>Non-cancelled orders</div>
          </div>

          <div className='stat-card'>
            <div className='stat-card-header'>
              <span className='stat-label'>Low Stock</span>
              <div
                className={`stat-icon ${(stats?.low_stock_count ?? 0) > 0 ? "red" : "green"}`}
              >
                <svg
                  width='18'
                  height='18'
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='2'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                >
                  <path d='M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z' />
                  <line x1='12' y1='9' x2='12' y2='13' />
                  <line x1='12' y1='17' x2='12.01' y2='17' />
                </svg>
              </div>
            </div>
            <div
              className='stat-value'
              style={{
                color:
                  (stats?.low_stock_count ?? 0) > 0
                    ? "var(--danger)"
                    : undefined,
              }}
            >
              {stats?.low_stock_count ?? 0}
            </div>
            <div className='stat-sub'>Products need restock</div>
          </div>

          <div className='stat-card'>
            <div className='stat-card-header'>
              <span className='stat-label'>Inventory Value</span>
              <div className='stat-icon blue'>
                <svg
                  width='18'
                  height='18'
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='2'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                >
                  <rect x='1' y='3' width='15' height='13' />
                  <polygon points='16 8 20 8 23 11 23 16 16 16 16 8' />
                  <circle cx='5.5' cy='18.5' r='2.5' />
                  <circle cx='18.5' cy='18.5' r='2.5' />
                </svg>
              </div>
            </div>
            <div className='stat-value'>
              {fmtPrice(stats?.inventory_value_cents ?? 0)}
            </div>
            <div className='stat-sub'>At current prices</div>
          </div>
        </div>

        {/* Bahama explainer */}
        <div className='bahama-explainer'>
          <div className='bahama-explainer-header'>
            <div className='bahama-explainer-badge'>Built with Bahama</div>
            <div className='bahama-explainer-tech'>
              <span className='bahama-tech-tag green'>✓ Live Database</span>
              <span className='bahama-tech-tag green'>✓ Serverless API</span>
              <span className='bahama-tech-tag green'>
                ✓ Vercel + Neon
              </span>
            </div>
          </div>
          <h2 className='bahama-explainer-headline'>
            A custom order system deployed to the cloud in under a minute.
          </h2>
          <p className='bahama-explainer-sub'>
            An AI coding agent wrote this app: the order form, this dashboard,
            the inventory logic, the backend API, and the database schema.
            Bahama handled the infrastructure workflow: a Vercel deployment,
            Neon Postgres, checked-in migrations, and the sealed database
            connection between them.
          </p>
        </div>

        {/* Main grid */}
        <div className='admin-main-grid'>
          {/* Orders panel */}
          <div className='panel'>
            <div className='panel-header'>
              <span className='panel-title'>
                <svg
                  width='16'
                  height='16'
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='2'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                >
                  <path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' />
                  <polyline points='14 2 14 8 20 8' />
                  <line x1='16' y1='13' x2='8' y2='13' />
                  <line x1='16' y1='17' x2='8' y2='17' />
                  <polyline points='10 9 9 9 8 9' />
                </svg>
                Orders
              </span>
              <span style={{fontSize: 12, color: "var(--text-subtle)"}}>
                {orders.length} shown
              </span>
            </div>

            <div className='panel-body'>
              {/* Filters */}
              <div className='filter-bar'>
                <button
                  className={`filter-chip${statusFilter === "all" ? " active" : ""}`}
                  onClick={() => setStatusFilter("all")}
                >
                  All
                </button>
                {ALL_STATUSES.map((s) => (
                  <button
                    key={s}
                    className={`filter-chip${statusFilter === s ? " active" : ""}`}
                    onClick={() => setStatusFilter(s)}
                  >
                    {STATUS_LABELS[s]}
                  </button>
                ))}
              </div>

              <input
                className='filter-search'
                type='text'
                placeholder='Search customer or email…'
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{marginBottom: 16, display: "block", width: "100%"}}
              />

              {orders.length === 0 ? (
                <div className='empty-state'>
                  <svg
                    width='48'
                    height='48'
                    viewBox='0 0 24 24'
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='1.5'
                  >
                    <path d='M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z' />
                    <line x1='3' y1='6' x2='21' y2='6' />
                  </svg>
                  <p>
                    {statusFilter === "all" && !search
                      ? "No demo orders yet."
                      : "No orders match your filters."}
                  </p>
                  {statusFilter === "all" && !search && (
                    <button
                      className='btn btn-secondary btn-sm'
                      onClick={handleSeed}
                      disabled={seeding}
                    >
                      {seeding ? "Loading demo data…" : "Load demo orders"}
                    </button>
                  )}
                </div>
              ) : (
                <div style={{overflowX: "auto"}}>
                  <table className='orders-table'>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Customer</th>
                        <th>Items</th>
                        <th>Total</th>
                        <th>Payment</th>
                        <th>Status</th>
                        <th>Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orders.map((order) => (
                        <tr key={order.id}>
                          <td>
                            <span className='order-id'>#{order.id}</span>
                          </td>
                          <td>
                            <div className='order-customer'>
                              {order.customer_name}
                            </div>
                            <div className='order-email'>
                              {order.customer_email}
                            </div>
                          </td>
                          <td>
                            <div
                              className='order-items-sum'
                              title={order.items_summary ?? ""}
                            >
                              {order.items_summary || "—"}
                            </div>
                            <div
                              style={{
                                fontSize: 11,
                                color: "var(--text-subtle)",
                                marginTop: 2,
                              }}
                            >
                              {order.fulfillment_type === "pickup"
                                ? "🏪 Pickup"
                                : "📦 Ship"}
                            </div>
                          </td>
                          <td>
                            <span className='order-total'>
                              {fmtPrice(order.total_cents)}
                            </span>
                          </td>
                          <td>
                            <span
                              className={`badge badge-${order.payment_status}`}
                            >
                              {order.payment_status === "invoice"
                                ? "Invoice"
                                : order.payment_status === "paid"
                                  ? "Paid"
                                  : "Unpaid"}
                            </span>
                          </td>
                          <td>
                            <select
                              className={`status-select s-${order.status}`}
                              value={order.status}
                              onChange={(e) =>
                                handleStatusChange(
                                  order.id,
                                  e.target.value as OrderStatus,
                                )
                              }
                            >
                              {ALL_STATUSES.map((s) => (
                                <option key={s} value={s}>
                                  {STATUS_LABELS[s]}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <span className='order-date'>
                              {timeAgo(order.created_at)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Inventory panel */}
          <div>
            <div className='panel'>
              <div className='panel-header'>
                <span className='panel-title'>
                  <svg
                    width='16'
                    height='16'
                    viewBox='0 0 24 24'
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='2'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                  >
                    <rect x='2' y='7' width='20' height='14' rx='2' ry='2' />
                    <path d='M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16' />
                  </svg>
                  Inventory
                </span>
                {lowStockProducts.length > 0 && (
                  <span className='badge badge-critical'>
                    ⚠ {lowStockProducts.length} low
                  </span>
                )}
              </div>

              <div className='panel-body'>
                <div className='inventory-list'>
                  {products.map((p) => {
                    const threshold = p.reorder_threshold ?? 5;
                    const maxForBar = Math.max(threshold * 3, p.stock);
                    const pct = Math.min(100, (p.stock / maxForBar) * 100);
                    const isLow = p.stock <= threshold;
                    const isCritical = p.stock <= Math.floor(threshold / 2);
                    const barClass = isCritical
                      ? "low"
                      : isLow
                        ? "medium"
                        : "high";

                    return (
                      <div key={p.id} className='inventory-item'>
                        <div className='inventory-item-header'>
                          <div>
                            <div className='inventory-item-name'>{p.name}</div>
                            <div className='inventory-item-sku'>{p.sku}</div>
                          </div>
                          {isLow && (
                            <span
                              className={`badge ${isCritical ? "badge-critical" : "badge-low"}`}
                            >
                              {isCritical ? "⚠ Critical" : "↓ Low"}
                            </span>
                          )}
                        </div>

                        <div className='inventory-stock-row'>
                          <div>
                            <div className='inventory-stock-count'>
                              {p.stock}
                            </div>
                            <div className='inventory-stock-label'>
                              in stock
                            </div>
                          </div>
                          <div
                            style={{
                              textAlign: "right",
                              fontSize: 11,
                              color: "var(--text-subtle)",
                            }}
                          >
                            reorder at {threshold}
                          </div>
                        </div>

                        <div className='stock-bar-wrap'>
                          <div
                            className={`stock-bar ${barClass}`}
                            style={{width: `${pct}%`}}
                          />
                        </div>

                        <div className='restock-row'>
                          <input
                            className='restock-input'
                            type='number'
                            min={1}
                            max={500}
                            placeholder='Qty'
                            value={restockAmounts[p.id] ?? ""}
                            onChange={(e) =>
                              setRestockAmounts((a) => ({
                                ...a,
                                [p.id]: e.target.value,
                              }))
                            }
                          />
                          <button
                            className='btn btn-secondary btn-sm'
                            style={{flex: 1}}
                            disabled={restocking[p.id]}
                            onClick={() => handleRestock(p)}
                          >
                            {restocking[p.id] ? (
                              <span
                                className='spinner'
                                style={{width: 13, height: 13, borderWidth: 2}}
                              />
                            ) : (
                              "+  Restock"
                            )}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Admin footer with subtle reset */}
        <div className='admin-footer'>
          <p style={{marginBottom: 8}}>
            Sunset Supply Co · Order Management Dashboard
          </p>
          <p>
            Custom-built by Claude using{" "}
            <a
              href='https://bahama.ai'
              target='_blank'
              rel='noopener noreferrer'
            >
              Bahama
            </a>{" "}
            ·{" "}
            <a
              href='#'
              onClick={(e) => {
                e.preventDefault();
                if (confirm("Reset all demo data?")) handleSeed();
              }}
              style={{opacity: 0.4}}
            >
              reset demo
            </a>
          </p>
        </div>
      </div>

      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onDone={() => setToast(null)}
        />
      )}
    </div>
  );
}
