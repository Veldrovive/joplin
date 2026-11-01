import EmbeddingIndexer from '@joplin/lib/services/ai/EmbeddingIndexer';
import { setupDatabaseAndSynchronizer, switchClient } from '@joplin/lib/testing/test-utils';
import app from './app';
import { setupApplication } from './utils/testUtils';

const applyEmbeddingIndexerState = () => (app() as unknown as { applyEmbeddingIndexerState: ()=> Promise<void> }).applyEmbeddingIndexerState();

describe('app', () => {

	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
		await setupApplication();
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	test.each([
		[false, 0],
		[true, 1],
	])('should only manage the embedding indexer when there is a GUI (hasGui: %s)', async (hasGui, expectedCalls) => {
		jest.spyOn(app(), 'hasGui').mockReturnValue(hasGui);
		const runInBackground = jest.spyOn(EmbeddingIndexer.instance(), 'runInBackground').mockResolvedValue();
		const stopRunInBackground = jest.spyOn(EmbeddingIndexer.instance(), 'stopRunInBackground').mockResolvedValue();

		await applyEmbeddingIndexerState();

		expect(runInBackground.mock.calls.length + stopRunInBackground.mock.calls.length).toBe(expectedCalls);
	});

});
