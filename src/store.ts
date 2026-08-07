import type { Memo } from './types';

type Listener = (state: MemosData) => void;

/** The shared, plugin-wide memo DATA. Navigation/UI state (active tab,
 * tag / date / keyword / structured filter, collapsed dates) is deliberately
 * NOT here — it lives per-view in ViewStore, so several open Memos views can
 * browse independently while all reflecting this one memo set. */
export interface MemosData {
	memos: Memo[];
	isLoading: boolean;
}

export class MemosStore {
	private state: MemosData = { memos: [], isLoading: true };
	private listeners = new Set<Listener>();

	get(): MemosData {
		return this.state;
	}

	update(partial: Partial<MemosData>): void {
		this.state = { ...this.state, ...partial };
		this.notify();
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	destroy(): void {
		this.listeners.clear();
	}

	private notify(): void {
		for (const listener of this.listeners) listener(this.state);
	}
}
