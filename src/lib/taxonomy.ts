import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export interface Subgroup { key: string; label: string; description: string; replies: boolean }
export interface Group { key: string; label: string; description: string; subgroups: Subgroup[] }

/** Email groups (headings) and subgroups (subheadings), from the server. */
export function useTaxonomy() {
	const { data } = useQuery<{ groups: Group[] }>({ queryKey: ['taxonomy'], queryFn: () => api('/taxonomy'), staleTime: 3600_000 });
	const groups = data?.groups || [];
	const subLabel = (group?: string | null, key?: string | null) =>
		(key && groups.find((g) => g.key === group)?.subgroups.find((s) => s.key === key)?.label) || '';
	return { groups, subLabel };
}
