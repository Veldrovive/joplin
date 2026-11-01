import BaseApplication from './BaseApplication';
import { reg } from './registry';
import SearchEngine from './services/search/SearchEngine';
import { setupDatabaseAndSynchronizer, switchClient } from './testing/test-utils';
import Note from './models/Note';
import { cancelTimers as cancelRefreshFoldersTimers } from './folders-screen-utils';

class TestApplication extends BaseApplication {
	private longRunning_: boolean;

	public constructor(longRunning: boolean) {
		super();
		this.longRunning_ = longRunning;
	}

	protected override isLongRunning() {
		return this.longRunning_;
	}
}

describe('BaseApplication', () => {

	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
	});

	afterEach(async () => {
		await cancelRefreshFoldersTimers();
		jest.restoreAllMocks();
	});

	test.each([
		[true, 1],
		[false, 0],
	])('should schedule a sync and search indexing after a note change only if long-running (%s)', async (longRunning, expectedCalls) => {
		const note = await Note.save({ title: 'test' });
		const scheduleSync = jest.spyOn(reg, 'scheduleSync').mockResolvedValue(undefined);
		const scheduleSyncTables = jest.spyOn(SearchEngine.instance(), 'scheduleSyncTables').mockReturnValue(undefined);

		const app = new TestApplication(longRunning);
		app.initRedux();
		try {
			await app.dispatch({ type: 'NOTE_DELETE', id: note.id });
		} finally {
			app.deinitRedux();
		}

		expect(scheduleSync).toHaveBeenCalledTimes(expectedCalls);
		expect(scheduleSyncTables).toHaveBeenCalledTimes(expectedCalls);
	});

});
