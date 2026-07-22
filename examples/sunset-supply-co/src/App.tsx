import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import DemoBanner from './components/DemoBanner'
import OrderForm from './pages/OrderForm'
import Confirmation from './pages/Confirmation'
import AdminDashboard from './pages/AdminDashboard'

export default function App() {
  return (
    <BrowserRouter>
      <DemoBanner />
      <Routes>
        <Route path="/" element={<AdminDashboard />} />
        <Route path="/new-order" element={<OrderForm />} />
        <Route path="/order/:id" element={<Confirmation />} />
        <Route path="/admin" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
