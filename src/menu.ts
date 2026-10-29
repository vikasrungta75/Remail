import type { IconType } from 'react-icons';
import {
	MdAutoAwesome, MdDashboard, MdPriorityHigh, MdNotificationsActive, MdBusiness, MdForum, MdChecklist,
	MdInsights, MdAssessment, MdInbox, MdGroup, MdSettings, MdHistory,
} from 'react-icons/md';

export interface MenuItem {
	id: string;
	text: string;
	path: string;
	icon: IconType;
	minRole?: 'viewer' | 'analyst' | 'manager' | 'admin';
	badge?: 'alerts' | 'critical';
}

export const menu: { section: string; items: MenuItem[] }[] = [
	{ section: 'Artificial intelligence', items: [{ id: 'sage', text: 'Mail Sage', path: '/mail-sage', icon: MdAutoAwesome }] },
	{
		section: 'Monitor',
		items: [
			{ id: 'overview', text: 'Overview', path: '/overview', icon: MdDashboard },
			{ id: 'critical', text: 'Critical issues', path: '/critical', icon: MdPriorityHigh, badge: 'critical' },
			{ id: 'alerts', text: 'Alerts', path: '/alerts', icon: MdNotificationsActive, badge: 'alerts' },
		],
	},
	{
		section: 'Customers',
		items: [
			{ id: 'customers', text: 'Customer health', path: '/customers', icon: MdBusiness },
			{ id: 'conversations', text: 'Conversations', path: '/conversations', icon: MdForum },
			{ id: 'actions', text: 'Actions and commitments', path: '/actions', icon: MdChecklist },
			{ id: 'insights', text: 'Trends and insights', path: '/insights', icon: MdInsights },
		],
	},
	{ section: 'Reporting', items: [{ id: 'reports', text: 'Reports', path: '/reports', icon: MdAssessment }] },
	{
		section: 'Admin',
		items: [
			{ id: 'mailboxes', text: 'Mailboxes', path: '/admin/mailboxes', icon: MdInbox, minRole: 'manager' },
			{ id: 'users', text: 'Users and access', path: '/admin/users', icon: MdGroup, minRole: 'manager' },
			{ id: 'settings', text: 'Settings', path: '/admin/settings', icon: MdSettings, minRole: 'manager' },
			{ id: 'audit', text: 'Audit log', path: '/admin/audit', icon: MdHistory, minRole: 'admin' },
		],
	},
];

export const titleFor = (path: string) => {
	for (const s of menu) for (const i of s.items) if (path.startsWith(i.path)) return i.text;
	if (path.startsWith('/profile')) return 'My profile';
	return 'remail';
};
