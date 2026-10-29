/**
 * Explainable traffic-light (RAG) and priority scoring. The AI proposes, these rules decide —
 * so every rating can be explained to a customer service lead.
 */
import type { Analysis } from './ai/types';

export interface ScoreInput {
	analysis: Analysis;
	awaitingReply: boolean;
	hoursWaiting: number;
	slaHours: number;
	tier: string;
	inboundCount: number;
}

export interface ScoreOutput {
	rag: 'red' | 'amber' | 'green';
	reasons: string[];
	priority: number;
	customerState: Analysis['customer_state'];
}

export function score(i: ScoreInput): ScoreOutput {
	const a = i.analysis;
	const reasons: string[] = [];
	const highIssue = a.issues.some((x) => x.severity === 'high' || x.severity === 'critical');
	const negative = a.sentiment === 'negative';
	const slaBreached = i.awaitingReply && i.hoursWaiting > i.slaHours;

	let rag: ScoreOutput['rag'] = 'green';
	if (a.legal_or_churn_signal) { rag = 'red'; reasons.push('Legal, cancellation or churn language detected'); }
	if (negative && (a.urgency === 'critical' || a.urgency === 'high')) { rag = 'red'; reasons.push(`Negative sentiment with ${a.urgency} urgency`); }
	if (negative && a.escalation_risk >= 70) { rag = 'red'; reasons.push(`Escalation risk ${a.escalation_risk}/100`); }
	if (negative && highIssue && i.tier !== 'standard') { rag = 'red'; reasons.push(`High-severity issue for a ${i.tier} customer`); }
	if (negative && slaBreached && i.hoursWaiting > i.slaHours * 2) { rag = 'red'; reasons.push(`Unhappy customer waiting ${Math.round(i.hoursWaiting)}h for a reply`); }

	if (rag !== 'red') {
		if (negative) { rag = 'amber'; reasons.push('Negative customer sentiment'); }
		if (highIssue) { rag = 'amber'; reasons.push('Open high-severity issue'); }
		if (a.issues.some((x) => x.severity === 'medium')) { rag = 'amber'; reasons.push('Open service concern'); }
		if (slaBreached) { rag = 'amber'; reasons.push(`Awaiting reply for ${Math.round(i.hoursWaiting)}h (SLA ${i.slaHours}h)`); }
		if (a.urgency === 'high' || a.urgency === 'critical') { rag = 'amber'; reasons.push(`${a.urgency[0].toUpperCase()}${a.urgency.slice(1)} urgency request`); }
		if (a.rag_suggestion === 'red' && rag === 'green') { rag = 'amber'; reasons.push('AI flagged elevated risk'); }
	}
	if (rag === 'green') reasons.push(a.sentiment === 'positive' ? 'Positive interaction' : 'Routine interaction with no open concerns');

	let priority = rag === 'red' ? 60 : rag === 'amber' ? 30 : 0;
	priority += Math.round(a.escalation_risk * 0.2);
	priority += i.tier === 'strategic' ? 12 : i.tier === 'key' ? 6 : 0;
	priority += a.urgency === 'critical' ? 10 : a.urgency === 'high' ? 5 : 0;
	if (i.awaitingReply) priority += Math.min(10, Math.round(i.hoursWaiting / Math.max(1, i.slaHours)) * 3);
	priority = Math.max(0, Math.min(100, priority));

	let customerState = a.customer_state;
	if (rag === 'red' && negative) customerState = 'dissatisfied';
	else if (rag === 'amber' && negative && customerState === 'neutral') customerState = 'at_risk';

	return { rag, reasons: [...new Set(reasons)], priority, customerState };
}

/** 0–100 health score for a customer, from the last N days of activity. */
export function healthScore(m: {
	avgSentiment: number; // -1..1, inbound emails
	red: number;
	amber: number;
	overdueActions: number;
	slaBreaches: number;
	positiveConversations: number;
	conversations: number;
}): number {
	if (m.conversations === 0) return 75;
	let s = 76 + m.avgSentiment * 25;
	s -= Math.min(30, m.red * 10);
	s -= Math.min(12, m.amber * 3);
	s -= Math.min(10, m.overdueActions * 2.5);
	s -= Math.min(9, m.slaBreaches * 3);
	s += Math.min(8, m.positiveConversations * 2);
	return Math.max(5, Math.min(100, Math.round(s)));
}

export function healthStatus(score: number): 'satisfied' | 'neutral' | 'at_risk' | 'dissatisfied' {
	if (score >= 70) return 'satisfied';
	if (score >= 55) return 'neutral';
	if (score >= 35) return 'at_risk';
	return 'dissatisfied';
}
