import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';

const base: ApexOptions = {
	chart: {
		fontFamily: "'Nunito Sans Variable', 'Nunito Sans', system-ui, sans-serif",
		toolbar: { show: false },
		zoom: { enabled: false },
		animations: { enabled: true, speed: 350 },
		foreColor: '#4a5072',
	},
	grid: { borderColor: '#eef0f6', strokeDashArray: 3, padding: { left: 8, right: 8 } },
	dataLabels: { enabled: false },
	legend: { position: 'top', horizontalAlign: 'left', fontWeight: 600, markers: { size: 6 } as any },
	tooltip: { theme: 'light' },
	xaxis: { axisBorder: { show: false }, axisTicks: { show: false }, labels: { style: { fontSize: '11px' } } },
	yaxis: { labels: { style: { fontSize: '11px' } } },
};

function merge(a: any, b: any): any {
	const out = { ...a };
	for (const k of Object.keys(b || {})) {
		out[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) ? merge(a?.[k] || {}, b[k]) : b[k];
	}
	return out;
}

export default function Chart({ type, series, options, height = 280 }: { type: any; series: any; options?: ApexOptions; height?: number }) {
	return <ReactApexChart type={type} series={series} options={merge(base, options || {})} height={height} />;
}
