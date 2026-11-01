import type { IconType } from 'react-icons';
import {
	MdAutoAwesome, MdDashboard, MdNotificationsActive, MdBusiness, MdForum, MdChecklist,
	MdInsights, MdAssessment, MdInbox, MdGroup, MdSettings, MdHistory, MdToday, MdDrafts, MdRequestQuote, MdGroups, MdHelpOutline, MdSync, MdContacts,
} from 'react-icons/md';

export interface MenuItem {
	id: string;
	text: string;
	path: string;
	icon: IconType;
	minRole?: 'viewer' | 'analyst' | 'manager' | 'admin';
	badge?: 'alerts' | 'critical' | 'myday' | 'drafts';
	/** other paths that highlight this item */
	also?: string[];
}

export const menu: { section: string; items: MenuItem[] }[] = [
	{
		section: 'My work',
		items: [
			{ id: 'myday', text: 'My day', path: '/my-day', icon: MdToday, badge: 'myday' },
			{ id: 'drafts', text: 'Replies to send', path: '/replies', icon: MdDrafts, badge: 'drafts' },
			{ id: 'sage', text: 'Mail Sage', path: '/mail-sage', icon: MdAutoAwesome },
		],
	},
	{
		section: 'Management',
		items: [
			{ id: 'overview', text: 'Overview', path: '/overview', icon: MdDashboard },
			{ id: 'email', text: 'Email', path: '/all-email', also: ['/critical', '/conversations', '/category-report'], icon: MdForum, badge: 'critical' },
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
			{ id: 'customerdb', text: 'Customer database', path: '/admin/customers', icon: MdContacts, minRole: 'analyst' },
			{ id: 'processing', text: 'Processing status', path: '/admin/processing', icon: MdSync, minRole: 'analyst' },
			{ id: 'mailboxes', text: 'Mailboxes', path: '/admin/mailboxes', icon: MdInbox, minRole: 'analyst' },
			{ id: 'users', text: 'Users and access', path: '/admin/users', icon: MdGroup, minRole: 'manager' },
			{ id: 'settings', text: 'Settings', path: '/admin/settings', icon: MdSettings, minRole: 'manager' },
			{ id: 'audit', text: 'Audit log', path: '/admin/audit', icon: MdHistory, minRole: 'admin' },
			{ id: 'help', text: 'Help and templates', path: '/help', icon: MdHelpOutline },
		],
	},
];

export const titleFor = (path: string) => {
	for (const s of menu) for (const i of s.items) if ([i.path, ...(i.also || [])].some((p) => path.startsWith(p))) return i.text;
	if (path.startsWith('/profile')) return 'My profile';
	if (path.startsWith('/category-report')) return 'Category report';
	return 'remail';
};
