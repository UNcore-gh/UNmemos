/**
 * Write-guard: suppress vault "modify" events caused by our own writes
 * so we don't reload mid-write.
 */
export class WriteGuard {
	private writing = false;
	private writeTimestamps = new Map<string, number>();

	setWriting(value: boolean): void {
		this.writing = value;
	}

	recordWrite(path: string): void {
		this.writeTimestamps.set(path, Date.now());
		window.setTimeout(() => this.writeTimestamps.delete(path), 2000);
	}

	isOwnWrite(path: string): boolean {
		if (this.writing) return true;
		const ts = this.writeTimestamps.get(path);
		return ts !== undefined && Date.now() - ts < 500;
	}

	destroy(): void {
		this.writing = false;
		this.writeTimestamps.clear();
	}
}
