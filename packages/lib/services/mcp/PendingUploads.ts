import uuid from '../../uuid';
import Setting from '../../models/Setting';
import { AttachmentPosition } from '../ai/tools/utils/attachFile';

export interface PendingUpload {
	id: string;
	filename: string;
	noteId?: string;
	position: AttachmentPosition;
	expiresAt: number;
}

export const uploadPath = 'mcp/upload';
export const uploadPathRegex = /^mcp\/upload\/[0-9a-f]{64}$/;
export const uploadTtl = 15 * 60 * 1000;
const maxPendingUploads = 50;

// Uploads that an MCP client announced with the create_upload tool and has yet to send. The id is
// the only credential needed to upload, so it is long, random, short-lived and valid once.
export default class PendingUploads {

	private static instance_: PendingUploads;
	private uploads_ = new Map<string, PendingUpload>();
	private publicUrl_: string|null = null;

	public static instance() {
		if (!this.instance_) this.instance_ = new PendingUploads();
		return this.instance_;
	}

	// The address of the API server as clients see it, for when it is behind a reverse proxy or
	// tunnel. By default, upload URLs point to this computer.
	public setPublicUrl(url: string|null) {
		this.publicUrl_ = url ? url.replace(/\/+$/, '') : null;
	}

	public uploadUrl(id: string) {
		const baseUrl = this.publicUrl_ ?? `http://127.0.0.1:${Setting.value('api.port') || 41184}`;
		return `${baseUrl}/${uploadPath}/${id}`;
	}

	private deleteExpired() {
		const now = Date.now();
		for (const [id, upload] of this.uploads_) {
			if (upload.expiresAt <= now) this.uploads_.delete(id);
		}
	}

	public create(props: Omit<PendingUpload, 'id'|'expiresAt'>): PendingUpload {
		this.deleteExpired();
		// Map keeps insertion order, so this drops the oldest ones
		while (this.uploads_.size >= maxPendingUploads) {
			this.uploads_.delete(this.uploads_.keys().next().value);
		}

		// Two v4 UUIDs: 244 random bits
		const id = `${uuid.create()}${uuid.create()}`;
		const upload = { ...props, id, expiresAt: Date.now() + uploadTtl };
		this.uploads_.set(id, upload);
		return upload;
	}

	// Returns the upload and forgets it, so that an id can't be used twice
	public take(id: string): PendingUpload|null {
		this.deleteExpired();
		const upload = this.uploads_.get(id);
		if (!upload) return null;
		this.uploads_.delete(id);
		return upload;
	}

	public clear() {
		this.uploads_.clear();
	}
}

