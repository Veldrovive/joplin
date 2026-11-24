import Setting from '../../../models/Setting';
import { setupDatabaseAndSynchronizer, supportDir, switchClient, tempFilePath } from '../../../testing/test-utils';
import Api, { Request, RequestMethod } from '../Api';
import ApiResponse from '../ApiResponse';
import route_mcp from './mcp';
import PendingUploads, { uploadTtl } from '../../mcp/PendingUploads';
import Note from '../../../models/Note';
import Folder from '../../../models/Folder';
import Resource from '../../../models/Resource';
import { copy, pathExists, readFile } from 'fs-extra';
import { join } from 'path';

const makeRequest = (body: unknown) => {
	return {
		method: RequestMethod.POST,
		body: JSON.stringify(body),
	} as Request;
};

describe('routes/mcp', () => {

	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
		Setting.setValue('mcp.enabled', true);
	});

	test.each([
		['single notification', { jsonrpc: '2.0', method: 'notifications/initialized' }],
		['batch of notifications', [{ jsonrpc: '2.0', method: 'notifications/initialized' }]],
	])('should acknowledge %s with an empty 202', async (_description, payload) => {
		const response = await route_mcp(makeRequest(payload));

		// Strict MCP clients close the transport if this is a 200.
		expect(response).toBeInstanceOf(ApiResponse);
		expect((response as ApiResponse).status).toBe(202);
		expect((response as ApiResponse).body).toBe('');
	});

	test('should return the response body for regular requests', async () => {
		const response = await route_mcp(makeRequest({
			jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
		}));

		expect(response).not.toBeInstanceOf(ApiResponse);
		expect((response as { id: number }).id).toBe(1);
	});

	describe('upload', () => {
		const api = new Api('test-token');

		// Stands for the temporary file that the HTTP server writes for a multipart form
		const uploadedFile = async () => {
			const path = tempFilePath('jpg');
			await copy(join(supportDir, 'photo.jpg'), path);
			return path;
		};

		const expectHttpError = async (promise: Promise<unknown>, httpCode: number) => {
			await expect(promise).rejects.toMatchObject({ httpCode });
		};

		afterEach(() => {
			PendingUploads.instance().clear();
			jest.useRealTimers();
		});

		test('should create the attachment and add it to the note, without the API token', async () => {
			const folder = await Folder.save({ title: 'Folder' });
			const note = await Note.save({ title: 'Test', body: 'Existing text', parent_id: folder.id });
			const upload = PendingUploads.instance().create({ filename: 'holiday.jpg', noteId: note.id, position: 'append' });
			const path = await uploadedFile();

			const output = await api.route(RequestMethod.POST, `mcp/upload/${upload.id}`, {}, '', [{ path }]);

			const resource = await Resource.load(output.id);
			expect(resource.title).toBe('holiday.jpg');
			expect(resource.mime).toBe('image/jpeg');
			expect((await readFile(Resource.fullPath(resource))).equals(await readFile(join(supportDir, 'photo.jpg')))).toBe(true);
			expect(output).toMatchObject({ title: 'holiday.jpg', note_id: note.id, markdown: `![holiday.jpg](:/${resource.id})` });
			expect((await Note.load(note.id)).body).toBe(`Existing text\n\n![holiday.jpg](:/${resource.id})`);
			expect(await pathExists(path)).toBe(false);

			// The URL only works once
			await expectHttpError(api.route(RequestMethod.POST, `mcp/upload/${upload.id}`, {}, '', [{ path: await uploadedFile() }]), 404);
			expect(await Resource.all()).toHaveLength(1);
		});

		test('should reject unknown and expired upload ids', async () => {
			const path = await uploadedFile();
			await expectHttpError(api.route(RequestMethod.POST, `mcp/upload/${'0'.repeat(64)}`, {}, '', [{ path }]), 404);
			expect(await pathExists(path)).toBe(false);

			const upload = PendingUploads.instance().create({ filename: 'a.jpg', position: 'append' });
			jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval'], now: Date.now() + uploadTtl + 1000 });
			await expectHttpError(api.route(RequestMethod.POST, `mcp/upload/${upload.id}`, {}, '', [{ path: await uploadedFile() }]), 404);
			expect(await Resource.all()).toHaveLength(0);
		});

		test('should still require the API token for everything else under /mcp', async () => {
			const upload = PendingUploads.instance().create({ filename: 'a.jpg', position: 'append' });
			await expectHttpError(api.route(RequestMethod.POST, 'mcp', {}, '{}'), 403);
			await expectHttpError(api.route(RequestMethod.POST, 'mcp/upload', {}, ''), 403);
			await expectHttpError(api.route(RequestMethod.POST, 'mcp/upload/short', {}, ''), 403);
			await expectHttpError(api.route(RequestMethod.POST, `mcp/upload/${upload.id}/more`, {}, ''), 403);
			await expectHttpError(api.route(RequestMethod.GET, `mcp/upload/${upload.id}`, {}, ''), 403);
			// None of these used up the upload
			expect(PendingUploads.instance().take(upload.id)).toBeTruthy();
		});

		test('should require a file, and use up the upload when there is none', async () => {
			const upload = PendingUploads.instance().create({ filename: 'a.jpg', position: 'append' });
			await expectHttpError(api.route(RequestMethod.POST, `mcp/upload/${upload.id}`, {}, 'raw body'), 400);
			expect(PendingUploads.instance().take(upload.id)).toBe(null);
		});

		test('should fail without creating an attachment when the note was deleted in the meantime', async () => {
			const folder = await Folder.save({ title: 'Folder' });
			const note = await Note.save({ title: 'Test', body: '', parent_id: folder.id });
			const upload = PendingUploads.instance().create({ filename: 'a.jpg', noteId: note.id, position: 'append' });
			await Note.delete(note.id, { toTrash: true });

			await expectHttpError(api.route(RequestMethod.POST, `mcp/upload/${upload.id}`, {}, '', [{ path: await uploadedFile() }]), 400);
			expect(await Resource.all()).toHaveLength(0);
		});
	});
});
