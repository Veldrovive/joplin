import Setting from '../../../../models/Setting';
import shim from '../../../../shim';
import uuid from '../../../../uuid';
import * as mimeUtils from '../../../../mime-utils';
import { _ } from '../../../../locale';
import { basename, fileExtension, safeFilename } from '@joplin/utils/path';
import { DownloadHandler } from '../../../../types';
import buildTool from '../utils/buildTool';
import { ToolError, ToolInput } from '../types';
import { attachFile, fileNameOnly, loadNoteToAttachTo, maxAttachmentSize, parsePosition } from '../utils/attachFile';

interface Input {
	filename?: string;
	data_base64?: string;
	text?: string;
	url?: string;
	note_id?: string;
	position?: string;
}

export const maxDownloadSize = maxAttachmentSize;
const downloadTimeout = 60 * 1000;
const sourceParameters = ['data_base64', 'text', 'url'] as const;

// Aborts the download once it goes over the limit
const makeDownloadLimiter = (maxBytes: number) => {
	let totalBytes = 0;
	let exceeded = false;
	const handler: DownloadHandler = {
		handleChunk: request => chunk => {
			totalBytes += chunk.length;
			if (totalBytes > maxBytes && !exceeded) {
				exceeded = true;
				request.destroy(new Error('Download size limit exceeded'));
			}
		},
	};
	return { handler, exceeded: () => exceeded };
};

const decodeBase64 = (data: string) => {
	// Models sometimes pass a full data URL. Handle this gracefully:
	const normalised = data.replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, '');
	if (!normalised || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(normalised)) {
		throw new ToolError('"data_base64" is not valid base64');
	}
	return Buffer.from(normalised, 'base64');
};

const filenameFromUrl = (url: URL) => {
	try {
		return fileNameOnly(decodeURIComponent(url.pathname));
	} catch (error) {
		// Malformed percent-encoding
		return fileNameOnly(url.pathname);
	}
};

const downloadToFile = async (url: URL, targetPath: string) => {
	const limiter = makeDownloadLimiter(maxDownloadSize);
	let response;
	try {
		response = await shim.fetchBlob(url.toString(), {
			path: targetPath,
			// The URL comes from the model, so it must not be able to reach services on the local
			// network.
			publicNetworkOnly: true,
			timeout: downloadTimeout,
			maxRetry: 0,
			downloadController: limiter.handler,
		});
	} catch (error) {
		if (limiter.exceeded()) throw new ToolError(`The file is larger than the ${maxDownloadSize / 1024 / 1024} MB limit`);
		throw new ToolError(`Could not download ${url}: ${error.message}`);
	}
	if (!response.ok) throw new ToolError(`Could not download ${url}: HTTP ${response.status}`);

	const contentType: string = response.headers?.get?.('content-type') ?? '';
	return contentType.split(';')[0].trim();
};

const tool = buildTool({
	id: 'upload_resource',
	// Attaching to a note edits its body, so a stale copy would cause a conflict
	readsNotes: true,
	userDescription: (input: ToolInput, output: { title?: string }) => {
		return _('Uploaded attachment: %s', output?.title ?? input.filename ?? _('(untitled)'));
	},
	description: [
		'Upload a file as an attachment (resource), and optionally add it to a note.',
		'',
		'Pass the content in exactly one of:',
		'  data_base64  — the file content, base64-encoded. Only practical for small files.',
		'  text         — the content of a text file (Markdown, CSV, SVG, source code…), as is.',
		'  url          — a public http(s) URL to download the file from. Best for images and other large or binary files.',
		'',
		'With "note_id" a link to the attachment (an embedded image for images) is added to that note.',
		'Otherwise use the returned "markdown" in the body of create_note or update_note to place it yourself. An attachment that no note links to is eventually deleted.',
	].join('\n'),
	inputSchema: {
		type: 'object',
		properties: {
			filename: { type: 'string', description: 'File name with its extension, e.g. "diagram.png". Used as the attachment title and to detect its type. Required with "data_base64" and "text"; with "url" it defaults to the name in the URL.' },
			data_base64: { type: 'string', description: 'Base64-encoded file content.' },
			text: { type: 'string', description: 'Text file content (stored as UTF-8).' },
			url: { type: 'string', description: 'Public http(s) URL to download the file from.' },
			note_id: { type: 'string', description: 'Optional id of a note to add the attachment to.' },
			position: {
				type: 'string',
				enum: ['append', 'prepend'],
				default: 'append',
				description: 'With "note_id": where to add the attachment in the note body.',
			},
		},
	},
	handler: async (input: Input) => {
		const sources = sourceParameters.filter(name => input[name] !== undefined && input[name] !== null);
		if (sources.length !== 1) {
			throw new ToolError('Pass exactly one of "data_base64", "text" or "url"');
		}
		const source = sources[0];
		if (typeof input[source] !== 'string' || (source !== 'text' && !input[source].trim())) {
			throw new ToolError(`"${source}" must be a non-empty string`);
		}
		if (input.filename !== undefined && typeof input.filename !== 'string') {
			throw new ToolError('"filename" must be a string');
		}

		const position = parsePosition(input.position);

		let url: URL|null = null;
		if (source === 'url') {
			try {
				url = new URL(input.url.trim());
			} catch (error) {
				throw new ToolError(`Invalid URL: ${input.url}`);
			}
			if (!['http:', 'https:'].includes(url.protocol)) {
				throw new ToolError('Only http and https URLs are supported');
			}
		}

		let title = fileNameOnly(input.filename ?? '');
		if (!title && url) title = filenameFromUrl(url);
		if (!title && source !== 'url') throw new ToolError('Missing "filename" parameter');

		await loadNoteToAttachTo(input.note_id);

		const tempDir = `${Setting.value('tempDir')}/mcp-upload-${uuid.createNano()}`;
		await shim.fsDriver().mkdir(tempDir);
		try {
			let filePath = `${tempDir}/${safeFilename(title, 128) || 'attachment'}`;

			if (source === 'data_base64') {
				await shim.fsDriver().writeFile(filePath, decodeBase64(input.data_base64).toString('base64'), 'base64');
			} else if (source === 'text') {
				await shim.fsDriver().writeFile(filePath, input.text, 'utf8');
			} else {
				const contentType = await downloadToFile(url, filePath);
				// Without an extension the type would have to be guessed from the content, which
				// fails for text formats such as SVG.
				const extension = !fileExtension(basename(filePath)) && contentType ? mimeUtils.toFileExtension(contentType) : null;
				if (extension) {
					const newPath = `${filePath}.${extension}`;
					await shim.fsDriver().move(filePath, newPath);
					filePath = newPath;
					if (title) title = `${title}.${extension}`;
				}
			}

			return await attachFile({ filePath, title, noteId: input.note_id, position });
		} finally {
			await shim.fsDriver().remove(tempDir);
		}
	},
});

export default tool;
