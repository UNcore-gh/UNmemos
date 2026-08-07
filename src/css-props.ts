/** Dynamic CSS writes go through this helper.
 *
 * Obsidian's `Element.setCssProps` is the sanctioned API on recent app
 * versions, but it does not exist all the way back to our minAppVersion —
 * fall back to raw style writes on older installs instead of crashing. */
export function cssProps(el: Element, props: Record<string, string>): void {
	const native = (
		el as Element & { setCssProps?: (p: Record<string, string>) => void }
	).setCssProps;
	if (typeof native === 'function') {
		native.call(el, props);
		return;
	}
	const style = (el as HTMLElement).style;
	if (!style) return;
	for (const [key, value] of Object.entries(props)) {
		const cssName = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
		style.setProperty(cssName, value);
	}
}
