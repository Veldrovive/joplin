import Note from '../../../../models/Note';
import Resource from '../../../../models/Resource';
import shim from '../../../../shim';
import { basename } from '@joplin/utils/path';
import { NoteEntity } from '../../../database/types';
import { ToolError } from '../types';

export type AttachmentPosition = 'append'|'prepend';

export interface AttachFileOptions {
	// Must be named after the attachment, since its type is detected from the file name
	filePath: string;
	title: string;
	noteId?: string;
	position?: AttachmentPosition;
}

// Used by the tools that create attachments (resources) and can link them from a note.

export const maxAttachmentSize = 100 * 1024 * 1024;

export const parsePosition = (position: unknown): AttachmentPosition => {
	if (position === undefined || position === null) return 'append';
	if (position !== 'append' && position !== 'prepend') {
		throw new ToolError(`Invalid position: ${JSON.stringify(position)}`);
	}
	return position;
};

// Drops any directory included in the name. basename() throws on an empty path.
export const fileNameOnly = (path: string) => {
	const trimmed = path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
	return trimmed ? basename(trimmed) : '';
};

// Call this before creating anything, so that a wrong id doesn't leave an orphaned attachment
// behind.
export const loadNoteToAttachTo = async (noteId: string|undefined|null): Promise<NoteEntity|null> => {
	if (!noteId) return null;
	if (typeof noteId !== 'string') throw new ToolError('"note_id" must be a string');
	const note = await Note.load(noteId);
	if (!note || note.is_conflict || (note.deleted_time && note.deleted_time > 0)) {
		throw new ToolError(`Note not found: ${noteId}`);
	}
	return note;
};

export const attachFile = async ({ filePath, title, noteId, position = 'append' }: AttachFileOptions) => {
	const note = await loadNoteToAttachTo(noteId);

	// Keep the file as it was provided: resizing would silently change what was uploaded
	const resource = await shim.createResourceFromPath(filePath, { title: title || basename(filePath) }, { resizeLargeImages: 'never' });
	const markdown = Resource.markupTag(resource, note?.markup_language);

	if (note) {
		const body = note.body ?? '';
		let newBody = markdown;
		if (body.trim()) {
			newBody = position === 'prepend' ? `${markdown}\n\n${body}` : `${body.replace(/\n+$/, '')}\n\n${markdown}`;
		}
		await Note.save({ id: note.id, body: newBody });
	}

	return {
		id: resource.id,
		title: resource.title,
		mime: resource.mime,
		size: resource.size,
		markdown,
		...(note ? { note_id: note.id } : {}),
	};
};
