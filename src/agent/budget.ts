export class BudgetExceeded extends Error {
	override name = "BudgetExceeded";

	constructor(
		message: string,
		readonly spentUsd = 0,
		readonly limitUsd = 0,
	) {
		super(message);
	}
}

/**
 * Per-run spend cap. The check runs before each request, so a single request can overshoot
 * the cap by its own cost, and no further request starts once the cap is reached.
 */
export class BudgetTracker {
	private spent = 0;

	constructor(readonly limitUsd: number) {}

	get spentUsd(): number {
		return this.spent;
	}

	record(usd: number): void {
		this.spent += usd;
	}

	assertCanSpend(): void {
		if (this.spent >= this.limitUsd) {
			throw new BudgetExceeded(
				`run budget of $${this.limitUsd.toFixed(2)} reached (spent $${this.spent.toFixed(4)})`,
				this.spent,
				this.limitUsd,
			);
		}
	}
}
