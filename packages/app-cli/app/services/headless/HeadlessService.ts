import { Store } from 'redux';
import { State } from '@joplin/lib/reducer';
import Setting from '@joplin/lib/models/Setting';
import SyncTargetRegistry from '@joplin/lib/SyncTargetRegistry';
import { reg } from '@joplin/lib/registry';
import shim from '@joplin/lib/shim';
import EmbeddingIndexer from '@joplin/lib/services/ai/EmbeddingIndexer';
import { embeddingAvailability } from '@joplin/lib/services/ai/availability';
import { ErrorBadRequest } from '@joplin/lib/services/rest/utils/errors';
import Logger from '@joplin/utils/Logger';
import { _ } from '@joplin/lib/locale';

const logger = Logger.create('HeadlessService');

export const minSyncInterval = 10;

export const parseSyncInterval = (value: number | string | undefined) => {
	if (value === undefined) return null;
	const interval = Number(value);
	if (!Number.isInteger(interval) || interval < minSyncInterval) {
		throw new Error(_('The sync interval must be a whole number of seconds, at least %d.', minSyncInterval));
	}
	return interval;
};

export interface SyncResult {
	startTime: number;
	endTime: number;
	errors: string[];
}

interface SyncActionArgs {
	wait?: boolean;
}

const errorMessages = (errors: (Error | string)[]) => {
	return (errors ?? []).map(error => (typeof error === 'string' ? error : error?.message ?? String(error)));
};

export default class HeadlessService {

	private store_: Store<State>;
	private syncInterval_: number|null;
	private startTime_ = Date.now();
	private currentSyncStartTime_: number|null = null;
	private lastSync_: SyncResult|null = null;
	private queuedSync_: Promise<void>|null = null;
	private unsubscribe_: ()=> void;

	public constructor(store: Store<State>, syncInterval: number|null) {
		this.store_ = store;
		this.syncInterval_ = syncInterval;
		this.unsubscribe_ = store.subscribe(this.onStateChange);
	}

	public destroy() {
		this.unsubscribe_();
	}

	private onStateChange = () => {
		const state = this.store_.getState();
		if (state.syncStarted && this.currentSyncStartTime_ === null) {
			this.currentSyncStartTime_ = Date.now();
		} else if (!state.syncStarted && this.currentSyncStartTime_ !== null) {
			// The synchronizer dispatches its final report, including errors, before SYNC_COMPLETED
			this.lastSync_ = {
				startTime: this.currentSyncStartTime_,
				endTime: Date.now(),
				errors: errorMessages(state.syncReport?.errors),
			};
			this.currentSyncStartTime_ = null;

			if (this.lastSync_.errors.length) {
				logger.warn(`Sync completed with ${this.lastSync_.errors.length} error(s)`);
			}

			// The indexer otherwise only checks for changes every few minutes. Syncs run after
			// local changes too, so this also covers notes created through the API.
			if (embeddingAvailability().available) void EmbeddingIndexer.instance().maintenance();
		}
	};

	public hasSyncTarget() {
		return !!Setting.value('sync.target');
	}

	public syncTargetName() {
		return this.hasSyncTarget() ? SyncTargetRegistry.idToName(Setting.value('sync.target')) : null;
	}

	// Runs a full sync once the sync in progress, if any, has finished, so that it includes all
	// changes made before the request. Requests made while one is already waiting share it.
	public requestSync(): Promise<void> {
		if (!this.queuedSync_) {
			this.queuedSync_ = (async () => {
				try {
					const synchronizer = await reg.syncTarget().synchronizer();
					await synchronizer.waitForSyncToFinish();
				} finally {
					this.queuedSync_ = null;
				}
				await reg.scheduleSync(0);
			})();
		}
		return this.queuedSync_;
	}

	public requestSyncInBackground() {
		void (async () => {
			try {
				await this.requestSync();
			} catch (error) {
				logger.error('Sync request failed:', error);
			}
		})();
	}

	public async status() {
		const state = this.store_.getState();

		return {
			version: shim.appVersion(),
			profileDir: Setting.value('profileDir'),
			uptimeSeconds: Math.round((Date.now() - this.startTime_) / 1000),
			mcpEnabled: !!Setting.value('mcp.enabled'),
			apiPort: Setting.value('api.port'),
			sync: {
				target: this.syncTargetName(),
				intervalSeconds: this.syncInterval_ ?? Setting.value('sync.interval'),
				inProgress: !!state.syncStarted,
				currentStartTime: this.currentSyncStartTime_,
				mustAuthenticate: !!state.mustAuthenticate,
				last: this.lastSync_,
			},
			embeddings: {
				...embeddingAvailability(),
				...(await EmbeddingIndexer.instance().getStatus()),
			},
		};
	}

	public actionApi() {
		return {
			headless: () => ({
				status: () => this.status(),
				sync: async (args: SyncActionArgs) => {
					if (!this.hasSyncTarget()) throw new ErrorBadRequest('No sync target is configured');

					if (!args?.wait) {
						this.requestSyncInBackground();
						return { started: true };
					}

					await this.requestSync();
					const state = this.store_.getState();
					return {
						completed: true,
						mustAuthenticate: !!state.mustAuthenticate,
						last: this.lastSync_,
					};
				},
			}),
		};
	}

}
