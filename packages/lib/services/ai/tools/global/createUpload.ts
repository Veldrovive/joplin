import { _ } from '../../../../locale';
import buildTool from '../utils/buildTool';
import { ToolError, ToolInput } from '../types';
import { fileNameOnly, loadNoteToAttachTo, maxAttachmentSize, parsePosition } from '../utils/attachFile';
import PendingUploads from '../../../mcp/PendingUploads';

interface Input {
	filename?: string;
	note_id?: string;
	position?: string;
}

const tool = buildTool({
	id: 'create_upload',
	// The upload edits the body of the note, so a stale copy would cause a conflict
	readsNotes: true,
	userDescription: (input: ToolInput) => _('Prepared upload: %s', input.filename ?? _('(untitled)')),
	description: [
		'Prepare the upload of a local file as an attachment (resource), for files that are too large for upload_resource\'s "data_base64" and are not at a public URL. Requires a way to run commands, such as a shell.',
		'',
		'Returns a single-use "upload_url" that expires after a few minutes. Send the file to it as a multipart form with the file in the "data" field, for example with the returned "curl" command. The response of that request has the attachment id and its "markdown" link.',
		'',
		'With "note_id" the attachment is added to that note when the upload completes. Otherwise use the returned "markdown" in the body of create_note or update_note.',
	].join('\n'),
	inputSchema: {
		type: 'object',
		properties: {
			filename: { type: 'string', description: 'File name with its extension, e.g. "report.pdf". Used as the attachment title and to detect its type.' },
			note_id: { type: 'string', description: 'Optional id of a note to add the attachment to.' },
			position: {
				type: 'string',
				enum: ['append', 'prepend'],
				default: 'append',
				description: 'With "note_id": where to add the attachment in the note body.',
			},
		},
		required: ['filename'],
	},
	handler: async (input: Input) => {
		if (typeof input.filename !== 'string' || !fileNameOnly(input.filename)) {
			throw new ToolError('Missing or invalid "filename" parameter');
		}
		const position = parsePosition(input.position);
		const note = await loadNoteToAttachTo(input.note_id);

		const upload = PendingUploads.instance().create({
			filename: fileNameOnly(input.filename),
			noteId: note?.id,
			position,
		});
		const uploadUrl = PendingUploads.instance().uploadUrl(upload.id);

		return {
			upload_url: uploadUrl,
			curl: `curl -sS -F "data=@/path/to/file" "${uploadUrl}"`,
			expires_at: new Date(upload.expiresAt).toISOString(),
			max_size: maxAttachmentSize,
		};
	},
});

export default tool;
