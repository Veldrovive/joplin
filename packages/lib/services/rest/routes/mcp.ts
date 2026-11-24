import { Request, RequestMethod } from '../Api';
import { ErrorBadRequest, ErrorForbidden, ErrorMethodNotAllowed, ErrorNotFound, ErrorPayloadTooLarge } from '../utils/errors';
import Setting from '../../../models/Setting';
import McpServer from '../../mcp/McpServer';
import { JsonRpcRequest, JsonRpcResponse } from '../../mcp/types';
import ApiResponse from '../ApiResponse';
import PendingUploads from '../../mcp/PendingUploads';
import { attachFile, maxAttachmentSize } from '../../ai/tools/utils/attachFile';
import { ToolError } from '../../ai/tools/types';
import shim from '../../../shim';
import uuid from '../../../uuid';
import { safeFilename } from '@joplin/utils/path';

// The MCP spec requires notifications to be acknowledged with an empty 202.
// Strict clients such as Codex close the transport if they get a 200 instead.
const acceptedResponse = () => {
	const response = new ApiResponse();
	response.status = 202;
	response.body = '';
	return response;
};

const removeFiles = async (paths: string[]) => {
	for (const path of paths) {
		try {
			await shim.fsDriver().remove(path);
		} catch (error) {
			// Not worth failing the request for a temporary file
		}
	}
};

// POST /mcp/upload/<id>: receives the file for an upload announced with the create_upload tool, as
// the "data" field of a multipart form. The id is the credential, so no API token is needed.
const handleUpload = async (request: Request, uploadId: string|null) => {
	const uploadedPaths = request.files.map(file => file.path);
	try {
		if (request.params.length) throw new ErrorNotFound();
		const upload = uploadId ? PendingUploads.instance().take(uploadId) : null;
		if (!upload) throw new ErrorNotFound('Unknown, expired or already used upload URL. Call create_upload again.');

		if (uploadedPaths.length !== 1) {
			throw new ErrorBadRequest('Send the file as a multipart form, in a single "data" field (curl -F "data=@file" <url>). Call create_upload again for a new URL.');
		}
		const stat = await shim.fsDriver().stat(uploadedPaths[0]);
		if (stat.size > maxAttachmentSize) {
			throw new ErrorPayloadTooLarge(`The file is larger than the ${maxAttachmentSize / 1024 / 1024} MB limit`);
		}

		// The attachment type is detected from the name of the file, so give it the announced one
		const tempDir = `${Setting.value('tempDir')}/mcp-upload-${uuid.createNano()}`;
		await shim.fsDriver().mkdir(tempDir);
		try {
			const filePath = `${tempDir}/${safeFilename(upload.filename, 128) || 'attachment'}`;
			await shim.fsDriver().move(uploadedPaths[0], filePath);
			if (upload.noteId) await McpServer.instance().syncBeforeEditingNote();
			return await attachFile({ filePath, title: upload.filename, noteId: upload.noteId, position: upload.position });
		} catch (error) {
			// For example when the note was deleted since create_upload was called
			if (error instanceof ToolError) throw new ErrorBadRequest(error.message);
			throw error;
		} finally {
			await shim.fsDriver().remove(tempDir);
		}
	} finally {
		await removeFiles(uploadedPaths);
	}
};

// Single-endpoint JSON-RPC transport. v1 only handles client-initiated
// requests so plain POST/response is enough; streamable HTTP can come later
// if we ever need server-initiated messages.
export default async function(request: Request, id: string|null = null, link: string|null = null) {
	if (request.method !== RequestMethod.POST) throw new ErrorMethodNotAllowed();

	if (!(Setting.value('mcp.enabled') as boolean)) {
		throw new ErrorForbidden('MCP server is disabled');
	}

	if (id === 'upload') return handleUpload(request, link);
	if (id) throw new ErrorNotFound();

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON-RPC envelope is dynamically shaped
	let payload: any;
	try {
		payload = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
	} catch (error) {
		throw new ErrorBadRequest('Invalid JSON body');
	}

	const server = McpServer.instance();

	// JSON-RPC batch: spec allows an array of requests. If every item is a
	// notification, the server must return nothing (empty body), same as the
	// single-notification case.
	if (Array.isArray(payload)) {
		const responses: JsonRpcResponse[] = [];
		for (const item of payload) {
			const r = await server.handleRequest(item as JsonRpcRequest);
			if (r) responses.push(r);
		}
		if (!responses.length) return acceptedResponse();
		return responses;
	}

	const response = await server.handleRequest(payload as JsonRpcRequest);
	// Notifications get no body per JSON-RPC spec.
	if (!response) return acceptedResponse();
	return response;
}
