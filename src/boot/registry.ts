/**
 * Every app that is up right now, root or scratch. A signal handler stops them all, since
 * `finally` blocks do not run when the process exits from a signal.
 */
export interface Stoppable {
	stop: () => Promise<void>;
}

const live = new Set<Stoppable>();

/** Registers an app. Returns the function that unregisters it. */
export function trackBooted(app: Stoppable): () => void {
	live.add(app);
	return () => {
		live.delete(app);
	};
}

/** Stops every registered app. Failures are ignored so one stuck app does not block the rest. */
export async function stopAllBooted(): Promise<void> {
	await Promise.all(
		[...live].map((app) => app.stop().catch(() => undefined)),
	);
}
