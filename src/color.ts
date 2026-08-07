/**
 * Accent-color theming. The chosen hex is published on <body> as three
 * CSS custom properties (--memos-accent / -rgb / -hover) so EVERY consumer
 * inherits one source of truth — the .memos-view stage, the body-mounted
 * popovers (card menu, filter panel, search suggestions) and the settings
 * tab all read these vars. Setting them on body (not on .memos-view) is
 * what lets the body-mounted popovers, which live OUTSIDE the view, pick
 * up the accent too. A live change therefore re-themes open views with
 * zero view code — the var() references simply re-resolve.
 */

const DEFAULT_HEX = '#07c160';
const DEFAULT_RGB: [number, number, number] = [7, 193, 96];

function parseHex(hex: string): [number, number, number] | null {
	let h = (hex || '').trim().replace(/^#/, '');
	if (h.length === 3) h = h.split('').map((c) => c + c).join('');
	if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
	return [
		parseInt(h.slice(0, 2), 16),
		parseInt(h.slice(2, 4), 16),
		parseInt(h.slice(4, 6), 16),
	];
}

function toHex(r: number, g: number, b: number): string {
	const c = (n: number): string =>
		Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
	return '#' + c(r) + c(g) + c(b);
}

/** Hover state that always reads as "more intense": darken light accents,
 *  lighten dark ones, using perceived luminance so it works for any hue. */
function hoverFor([r, g, b]: [number, number, number]): string {
	const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	const f = lum > 0.5 ? 0.86 : 1.18;
	return toHex(r * f, g * f, b * f);
}

/** Publish the accent on <body>. Invalid hex falls back to the green. */
export function applyAccent(hex: string): void {
	const rgb = parseHex(hex) ?? DEFAULT_RGB;
	const good = parseHex(hex) ? hex : DEFAULT_HEX;
	const s = document.body.style;
	s.setProperty('--memos-accent', good);
	s.setProperty('--memos-accent-rgb', `${rgb[0]}, ${rgb[1]}, ${rgb[2]}`);
	s.setProperty('--memos-accent-hover', hoverFor(rgb));
}

/** Remove the accent vars (plugin unload) so a disabled plugin leaves no
 *  stray custom properties on <body>. */
export function clearAccent(): void {
	const s = document.body.style;
	s.removeProperty('--memos-accent');
	s.removeProperty('--memos-accent-rgb');
	s.removeProperty('--memos-accent-hover');
}
