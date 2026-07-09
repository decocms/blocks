/**
 * VTEX MasterData v2 API actions.
 * Generic CRUD operations on data entities.
 */
import { getVtexConfig, getVtexFetch, vtexFetch, vtexFetchResponse } from "../client";

function removeEmptyFields(obj: Record<string, any>): Record<string, any> {
	return Object.fromEntries(
		Object.entries(obj).filter(
			([_, value]) => value !== "" && value !== undefined && value !== null,
		),
	);
}

export interface CreateDocumentResult {
	DocumentId: string;
}

export interface CreateDocumentProps {
	entity: string;
	data: Record<string, any>;
}

export async function createDocument(props: CreateDocumentProps): Promise<CreateDocumentResult> {
	const { entity, data } = props;
	return vtexFetch<CreateDocumentResult>(`/api/dataentities/${entity}/documents`, {
		method: "POST",
		body: JSON.stringify(removeEmptyFields(data)),
	});
}

export interface GetDocumentProps {
	entity: string;
	documentId: string;
}

export async function getDocument<T = unknown>(props: GetDocumentProps): Promise<T> {
	const { entity, documentId } = props;
	return vtexFetch<T>(`/api/dataentities/${entity}/documents/${documentId}`);
}

export interface PatchDocumentProps {
	entity: string;
	documentId: string;
	data: Record<string, any>;
}

export async function patchDocument(props: PatchDocumentProps): Promise<void> {
	const { entity, documentId, data } = props;
	await vtexFetch<any>(`/api/dataentities/${entity}/documents/${documentId}`, {
		method: "PATCH",
		body: JSON.stringify(removeEmptyFields(data)),
	});
}

export interface MasterDataSearchResult {
	id: string;
	accountId: string;
	accountName: string;
	dataEntityId: string;
	[key: string]: any;
}

export interface SearchDocumentsProps {
	entity: string;
	filter: string;
}

/**
 * Simple search — kept for backward compat.
 */
export async function searchDocuments<T = MasterDataSearchResult>(
	props: SearchDocumentsProps,
): Promise<T[]> {
	const { entity, filter } = props;
	return vtexFetch<T[]>(`/api/dataentities/${entity}/search?_where=${encodeURIComponent(filter)}`);
}

/**
 * Full MasterData search with pagination, field selection, and sorting.
 * Ported from deco-cx/apps vtex/loaders/masterdata/searchDocuments.ts
 *
 * @see https://developers.vtex.com/docs/api-reference/masterdata-api#get-/api/dataentities/-acronym-/search
 */
export interface SearchDocumentsFullProps {
	acronym: string;
	fields?: string;
	where?: string;
	sort?: string;
	/** @default 10 (max 100) */
	take?: number;
	/** @default 0 */
	skip?: number;
}

export async function searchDocumentsFull<T = Record<string, unknown>>(
	props: SearchDocumentsFullProps,
): Promise<T[]> {
	const { acronym, fields, where, sort, skip = 0, take = 10 } = props;
	const from = Math.max(skip, 0);
	const to = from + Math.min(100, take);

	const params = new URLSearchParams();
	if (fields) params.set("_fields", fields);
	if (where) params.set("_where", where);
	if (sort) params.set("_sort", sort);

	const headers: Record<string, string> = {
		accept: "application/vnd.vtex.ds.v10+json",
		"content-type": "application/json",
		"REST-Range": `resources=${from}-${to}`,
	};

	return vtexFetchResponse(`/api/dataentities/${acronym}/search?${params}`, {
		headers,
	}).then((res) => res.json());
}

// ---------------------------------------------------------------------------
// Attachments (file upload)
// ---------------------------------------------------------------------------

export interface UploadAttachmentOpts {
	entity: string;
	documentId: string;
	field: string;
	fileName: string;
	/** Base64-encoded file content */
	fileBase64: string;
	contentType: string;
}

/**
 * Upload a file attachment to a MasterData document.
 * Uses the VTEX MasterData attachment API with appKey/appToken auth.
 */
export async function uploadAttachment(opts: UploadAttachmentOpts): Promise<{ ok: true }> {
	const { entity, documentId, field, fileName, fileBase64, contentType } = opts;
	const config = getVtexConfig();
	const url = `https://${config.account}.vtexcommercestable.${config.domain ?? "com.br"}/api/dataentities/${entity}/documents/${documentId}/${field}/attachments`;

	const binary = atob(fileBase64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

	const blob = new Blob([bytes], { type: contentType });
	const formData = new FormData();
	formData.append("file", blob, fileName);

	const headers: Record<string, string> = {};
	if (config.appKey && config.appToken) {
		headers["X-VTEX-API-AppKey"] = config.appKey;
		headers["X-VTEX-API-AppToken"] = config.appToken;
	}

	const response = await getVtexFetch()(url, {
		method: "POST",
		headers,
		body: formData,
		operation: "masterdata.attachment.upload",
	});

	if (!response.ok) {
		throw new Error(`VTEX attachment upload failed: ${response.status} ${response.statusText}`);
	}

	return { ok: true };
}
