import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './contexts/AuthContext';
import Layout from './layout/Layout';
import Login from './pages/auth/Login';
import ForgotPassword from './pages/auth/ForgotPassword';
import ResetPassword from './pages/auth/ResetPassword';
import Overview from './pages/Overview';
import Conversations, { CriticalIssues } from './pages/Conversations';
import ConversationDetail from './pages/ConversationDetail';
import Customers, { CustomerDetail } from './pages/Customers';
import Actions from './pages/Actions';
import Insights from './pages/Insights';
import MailSage from './pages/MailSage';
import Alerts from './pages/Alerts';
import Reports from './pages/Reports';
import Mailboxes from './pages/admin/Mailboxes';
import Users from './pages/admin/Users';
import Settings from './pages/admin/Settings';
import Audit from './pages/admin/Audit';
import Profile from './pages/Profile';
import { Loader } from './components/ui';

function Protected({ children, min }: { children: ReactNode; min?: 'viewer' | 'analyst' | 'manager' | 'admin' }) {
	const { user, loading, can } = useAuth();
	const loc = useLocation();
	if (loading) return <Loader text="Loading remail" />;
	if (!user) return <Navigate to="/auth/login" replace state={{ from: loc.pathname + loc.search }} />;
	if (min && !can(min)) return <Navigate to="/overview" replace />;
	return <>{children}</>;
}

export default function App() {
	const { user, loading } = useAuth();
	return (
		<Routes>
			<Route path="/auth/login" element={!loading && user ? <Navigate to="/overview" replace /> : <Login />} />
			<Route path="/auth/forgot-password" element={<ForgotPassword />} />
			<Route path="/auth/reset-password" element={<ResetPassword />} />
			<Route element={<Protected><Layout /></Protected>}>
				<Route path="/" element={<Navigate to="/overview" replace />} />
				<Route path="/overview" element={<Overview />} />
				<Route path="/critical" element={<CriticalIssues />} />
				<Route path="/conversations" element={<Conversations />} />
				<Route path="/conversations/:id" element={<ConversationDetail />} />
				<Route path="/customers" element={<Customers />} />
				<Route path="/customers/:id" element={<CustomerDetail />} />
				<Route path="/actions" element={<Actions />} />
				<Route path="/insights" element={<Insights />} />
				<Route path="/mail-sage" element={<MailSage />} />
				<Route path="/alerts" element={<Alerts />} />
				<Route path="/reports" element={<Reports />} />
				<Route path="/profile" element={<Profile />} />
				<Route path="/admin/mailboxes" element={<Protected min="manager"><Mailboxes /></Protected>} />
				<Route path="/admin/users" element={<Protected min="manager"><Users /></Protected>} />
				<Route path="/admin/settings" element={<Protected min="manager"><Settings /></Protected>} />
				<Route path="/admin/audit" element={<Protected min="admin"><Audit /></Protected>} />
				<Route path="*" element={<Navigate to="/overview" replace />} />
			</Route>
		</Routes>
	);
}
