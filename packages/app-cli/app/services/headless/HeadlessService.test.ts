import Setting from '@joplin/lib/models/Setting';
import { reg } from '@joplin/lib/registry';
import { setupDatabaseAndSynchronizer, switchClient } from '@joplin/lib/testing/test-utils';
import app from '../../app';
import { setupApplication } from '../../utils/testUtils';
import HeadlessService, { parseSyncInterval } from './HeadlessService';

let service: HeadlessService = null;

const createService = (syncInterval: number|null = null) => {
	service = new HeadlessService(app().store(), syncInterval);
	return service;
};

describe('HeadlessService', () => {

	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
		await setupApplication();
	});

	afterEach(() => {
		service?.destroy();
		service = null;
		jest.restoreAllMocks();
	});

	test.each([
		[undefined, null],
		[10, 10],
		['60', 60],
		[5, 'error'],
		[12.5, 'error'],
		['abc', 'error'],
	])('should parse the sync interval %s', (value, expected) => {
		if (expected === 'error') {
			expect(() => parseSyncInterval(value)).toThrow();
		} else {
			expect(parseSyncInterval(value)).toBe(expected);
		}
	});

	test('should report the result of the last sync', async () => {
		const store = app().store();
		createService(30);

		store.dispatch({ type: 'SYNC_STARTED' });
		expect((await service.status()).sync.inProgress).toBe(true);

		store.dispatch({ type: 'SYNC_REPORT_UPDATE', report: { errors: [new Error('Network error'), 'Other error'] } });
		store.dispatch({ type: 'SYNC_COMPLETED', isFullSync: true });

		const { sync } = await service.status();
		expect(sync.inProgress).toBe(false);
		expect(sync.intervalSeconds).toBe(30);
		expect(sync.last.errors).toEqual(['Network error', 'Other error']);
		expect(sync.last.endTime).toBeGreaterThanOrEqual(sync.last.startTime);
	});

	test('should share a sync request with the requests made while it is waiting', async () => {
		const scheduleSync = jest.spyOn(reg, 'scheduleSync').mockResolvedValue(undefined);
		createService();

		await Promise.all([service.requestSync(), service.requestSync()]);
		expect(scheduleSync).toHaveBeenCalledTimes(1);

		await service.requestSync();
		expect(scheduleSync).toHaveBeenCalledTimes(2);
	});

	test('should reject sync requests when there is no sync target', async () => {
		Setting.setValue('sync.target', 0);
		const api = createService().actionApi().headless();
		await expect(api.sync({ wait: true })).rejects.toThrow('No sync target');
	});

});
