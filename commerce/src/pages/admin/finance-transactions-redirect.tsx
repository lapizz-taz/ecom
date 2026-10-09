import { Navigate, useLocation } from 'react-router'

/** /admin/finance/income and /admin/finance/expenses now live in Income & Expense. */
export default function FinanceTransactionsRedirect() {
  const { pathname, search } = useLocation()
  const params = new URLSearchParams(search)
  params.set('tab', pathname.endsWith('/income') ? 'income' : 'expense')
  return <Navigate to={`/admin/finance/income-expense?${params}`} replace />
}
