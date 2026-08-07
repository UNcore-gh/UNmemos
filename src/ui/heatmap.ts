import { cssProps } from '../css-props';

/** Structural type for Obsidian's global moment() — only the methods we
 * use, so we never touch the untyped `window.moment` directly. */
interface MomentLike {
	format(f: string): string;
	clone(): MomentLike;
	subtract(n: number, unit: 'month'): MomentLike;
	add(n: number, unit: 'month'): MomentLike;
	startOf(unit: string): MomentLike;
	endOf(unit: string): MomentLike;
	day(): number;
	date(): number;
	date(d: number): MomentLike;
	isAfter(other: MomentLike, unit: string): boolean;
}

function getMoment(): () => MomentLike {
	return (window as unknown as { moment: () => MomentLike }).moment;
}

export class Heatmap {
	private container!: HTMLElement;
	private currentMonth: MomentLike;
	private onDateClick: (date: string | null) => void;
	/** Render-skip signature inputs — with the ViewStore's memoized date
	 * counts the map ref is stable until memo data/frame changes, so
	 * unrelated store notifications rebuild no calendar. */
	private lastCounts: Map<string, number> | null = null;
	private lastSig = '';

	constructor(onDateClick: (date: string | null) => void) {
		this.currentMonth = getMoment()().startOf('month');
		this.onDateClick = onDateClick;
	}

	build(parent: HTMLElement): void {
		this.container = parent.createDiv({ cls: 'memos-activity-section' });
	}

	private createChevronButton(
		parent: HTMLElement,
		dir: 'prev' | 'next',
		size = 14,
	): HTMLElement {
		const btn = parent.createEl('button', {
			cls: 'memos-calendar-nav',
			attr: {
				'aria-label': dir === 'prev' ? 'Previous month' : 'Next month',
			},
		});
		const svg = createSvg('svg');
		svg.setAttribute('width', String(size));
		svg.setAttribute('height', String(size));
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '2');
		svg.setAttribute('stroke-linecap', 'round');
		svg.setAttribute('stroke-linejoin', 'round');
		cssProps(svg, { width: `${size}px`, height: `${size}px` });
		const path = createSvg('path');
		path.setAttribute(
			'd',
			dir === 'prev' ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6',
		);
		svg.appendChild(path);
		btn.appendChild(svg);
		return btn;
	}

	render(dateCounts: Map<string, number>, activeDate: string | null): void {
		const month = this.currentMonth.format('YYYY-MM');
		const sig = `${activeDate ?? ''}|${month}`;
		if (sig === this.lastSig && dateCounts === this.lastCounts) return;
		this.lastSig = sig;
		this.lastCounts = dateCounts;
		this.container.empty();
		this.container.createDiv({
			cls: 'memos-lite-sidebar-title',
			text: 'Activity',
		});

		const header = this.container.createDiv({ cls: 'memos-calendar-header' });
		this.createChevronButton(header, 'prev', 18).addEventListener('click', () => {
			this.currentMonth = this.currentMonth.clone().subtract(1, 'month');
			this.render(dateCounts, activeDate);
		});
		header.createDiv({
			cls: 'memos-calendar-month',
			text: this.currentMonth.format('MMMM YYYY'),
		});
		this.createChevronButton(header, 'next', 18).addEventListener('click', () => {
			this.currentMonth = this.currentMonth.clone().add(1, 'month');
			this.render(dateCounts, activeDate);
		});

		const weekdays = this.container.createDiv({
			cls: 'memos-calendar-weekdays',
		});
		for (const d of ['S', 'M', 'T', 'W', 'T', 'F', 'S']) {
			weekdays.createDiv({ cls: 'memos-calendar-weekday', text: d });
		}

		const grid = this.container.createDiv({ cls: 'memos-calendar-grid' });
		const start = this.currentMonth.clone().startOf('month');
		const end = this.currentMonth.clone().endOf('month');
		const startDow = start.day();
		const daysInMonth = end.date();

		for (let i = 0; i < startDow; i++) {
			grid.createDiv({ cls: 'memos-calendar-cell empty' });
		}

		const moment = getMoment();
		const today = moment().format('YYYY-MM-DD');

		for (let day = 1; day <= daysInMonth; day++) {
			const date = this.currentMonth.clone().date(day);
			const key = date.format('YYYY-MM-DD');
			const count = dateCounts.get(key) || 0;
			const level = this.getLevel(count);
			const isToday = key === today;
			const isActive = key === activeDate;
			const isFuture = date.isAfter(moment(), 'day');
			const cell = grid.createDiv({
				cls:
					'memos-calendar-cell' +
					(level > 0 ? ` level-${level}` : '') +
					(isToday ? ' today' : '') +
					(isActive ? ' active' : '') +
					(isFuture ? ' future' : ''),
				text: String(day),
			});
			cell.setAttribute(
				'title',
				`${count} memo${count !== 1 ? 's' : ''} on ${key}`,
			);
			cell.addEventListener('click', () => {
				this.onDateClick(isActive ? null : key);
			});
		}

		const trailing = 7 - ((startDow + daysInMonth) % 7);
		if (trailing < 7) {
			for (let i = 0; i < trailing; i++) {
				grid.createDiv({ cls: 'memos-calendar-cell empty' });
			}
		}
		this.enforceSvgSizes();
	}

	private enforceSvgSizes(): void {
		const apply = () => {
			this.container.querySelectorAll('.memos-calendar-nav').forEach((btn) => {
				const svg = btn.querySelector('svg');
				if (svg) {
					svg.setAttribute('width', '14');
					svg.setAttribute('height', '14');
					cssProps(svg, {
						width: '14px',
						height: '14px',
					});
				}
				cssProps(btn, { width: '14px', height: '14px' });
			});
		};
		window.requestAnimationFrame(() => {
			apply();
			window.setTimeout(apply, 200);
		});
	}

	private getLevel(count: number): number {
		if (count === 0) return 0;
		if (count <= 2) return 1;
		if (count <= 5) return 2;
		if (count <= 10) return 3;
		return 4;
	}
}
