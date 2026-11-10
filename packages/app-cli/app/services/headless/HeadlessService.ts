import { Store } from 'redux';
import { State } from '@joplin/lib/reducer';
import Setting from '@joplin/lib/models/Setting';
import SyncTargetRegistry from '@joplin/lib/SyncTargetRegistry';
import { reg } from '@joplin/lib/registry';
import shim from '@joplin/lib/shim';
import EmbeddingIndexer from '@joplin/lib/services/ai/EmbeddingIndexer';
import { embeddingAvailability } from '@joplin/lib/services/ai/availability';
import { ErrorBadRequest } from '@joplin/lib/services/rest/utils/errors';
import McpServer, { PreReadSyncResult } from '@joplin/lib/services/mcp/McpServer';
import SearchEngine from '@joplin/lib/services/search/SearchEngine';
import AiService from '@joplin/lib/services/ai/AiService';
import ItemChange from '@joplin/lib/models/ItemChange';
import { ModelType } from '@joplin/lib/BaseModel';
import { msleep } from '@joplin/utils/time';
import Logger from '@joplin/utils/Logger';
import { _ } from '@joplin/lib/locale';

const logger = Logger.create('HeadlessService');

export const minSyncInterval = 10;

// MCP clients typically give up on a tool call after a minute or so, so a read waits at most this
// long for the sync and indexing before it uses the local data.
export const preReadSyncTimeout = 30 * 1000;

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

const resolvesWithin = async (promise: Promise<unknown>, timeout: number) => {
	let timeoutId: ReturnType<typeof shim.setTimeout>;
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise<boolean>(resolve => { timeoutId = shim.setTimeout(() => resolve(false), timeout); }),
		]);
	} finally {
		shim.clearTimeout(timeoutId);
	}
};

// The search indexes record the last change they processed, so they are up to date with a sync once
// they reach the last change it made. Their update functions return immediately if a run is already
// in progress, hence the polling.
const waitForIndex = async (cursorKey: string, lastChangeId: number, update: ()=> Promise<void>, deadline: number) => {
	const isUpToDate = () => (Setting.value(cursorKey) as number) >= lastChangeId;
	while (!isUpToDate()) {
		if (Date.now() >= deadline) return false;
		await update();
		if (!isUpToDate()) await msleep(200);
	}
	return true;
};

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
		McpServer.instance().setPreReadSync(this.preReadSync);
	}

	public destroy() {
		this.unsubscribe_();
		McpServer.instance().setPreReadSync(null);
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

	// Lets agents read changes made on other devices without waiting for the next scheduled sync
	public preReadSync = async (toolId: string): Promise<PreReadSyncResult> => {
		if (!this.hasSyncTarget()) return {};
		const deadline = Date.now() + preReadSyncTimeout;

		if (!await resolvesWithin(this.requestSync(), preReadSyncTimeout)) {
			return { warning: `The sync was still running after ${preReadSyncTimeout / 1000} seconds, so the results may not include recent changes from other devices. It continues in the background, so try again shortly.` };
		}

		const warnings: string[] = [];
		if (this.store_.getState().mustAuthenticate) {
			warnings.push('Could not sync because the sync target needs to be authenticated again, so the results may not include recent changes from other devices.');
		} else if (this.lastSync_?.errors.length) {
			warnings.push(`The sync completed with errors, so the results may not include all recent changes from other devices: ${this.lastSync_.errors.join('; ')}`);
		}

		let indexed = true;
		if (toolId === 'search_notes') {
			indexed = await waitForIndex('searchEngine.lastProcessedChangeId', await ItemChange.lastChangeId(ModelType.Note), () => SearchEngine.instance().syncTables(), deadline);
		} else if (toolId === 'semantic_search_notes' && AiService.instance().getActiveEmbeddingProvider() && Setting.value('ai.embedding.initialScanDone')) {
			indexed = await waitForIndex('ai.embedding.lastProcessedChangeId', await ItemChange.lastChangeId(), () => EmbeddingIndexer.instance().maintenance(), deadline);
		}
		if (!indexed) warnings.push('The search index was still being updated after the sync, so search results may not include the most recent changes. Try again shortly.');

		return warnings.length ? { warning: warnings.join(' ') } : {};
	};

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
