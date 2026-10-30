import type { IconType } from 'react-icons';
import {
	MdAutoAwesome, MdDashboard, MdNotificationsActive, MdBusiness, MdForum, MdChecklist,
	MdInsights, MdAssessment, MdInbox, MdGroup, MdSettings, MdHistory, MdToday, MdRequestQuote, MdGroups,
} from 'react-icons/md';

export interface MenuItem {
	id: string;
	text: string;
	path: string;
	icon: IconType;
	minRole?: 'viewer' | 'analyst' | 'manager' | 'admin';
	badge?: 'alerts' | 'critical' | 'myday';
	/** other paths that highlight this item */
	also?: string[];
}

export const menu: { section: string; items: MenuItem[] }[] = [
	{
		section: 'My work',
		items: [
			{ id: 'myday', text: 'My day', path: '/my-day', icon: MdToday, badge: 'myday' },
			{ id: 'sage', text: 'Mail Sage', path: '/mail-sage', icon: MdAutoAwesome },
		],
	},
	{
		section: 'Management',
		items: [
			{ id: 'overview', text: 'Overview', path: '/overview', icon: MdDashboard },
			{ id: 'email', text: 'Email', path: '/all-email', also: ['/critical', '/conversations'], icon: MdForum, badge: 'critical' },
			{ id: 'customers', text: 'Customers and accounts', path: '/customers', icon: MdBusiness },
			{ id: 'proposals', text: 'Proposals and quotes', path: '/proposals', icon: MdRequestQuote },
			{ id: 'actions', text: 'Actions and commitments', path: '/actions', icon: MdChecklist },
			{ id: 'alerts', text: 'Alerts', path: '/alerts', icon: MdNotificationsActive, badge: 'alerts' },
		],
	},
	{
		section: 'Insight',
		items: [
			{ id: 'insights', text: 'Trends and insights', path: '/insights', icon: MdInsights },
			{ id: 'team', text: 'Team performance', path: '/team', icon: MdGroups, minRole: 'manager' },
			{ id: 'reports', text: 'Reports', path: '/reports', icon: MdAssessment },
		],
	},
	{
		section: 'Admin',
		items: [
			{ id: 'mailboxes', text: 'Mailboxes', path: '/admin/mailboxes', icon: MdInbox, minRole: 'analyst' },
			{ id: 'users', text: 'Users and access', path: '/admin/users', icon: MdGroup, minRole: 'manager' },
			{ id: 'settings', text: 'Settings', path: '/admin/settings', icon: MdSettings, minRole: 'manager' },
			{ id: 'audit', text: 'Audit log', path: '/admin/audit', icon: MdHistory, minRole: 'admin' },
		],
	},
];

export const titleFor = (path: string) => {
	for (const s of menu) for (const i of s.items) if ([i.path, ...(i.also || [])].some((p) => path.startsWith(p))) return i.text;
	if (path.startsWith('/profile')) return 'My profile';
	return 'remail';
};
