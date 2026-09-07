import {
	IconArchiveFilled,
	IconFileDescription,
	IconFileDescriptionFilled,
	IconFileMusicFilled,
	IconFileText,
	IconFileTextFilled,
	IconFileZip,
	IconFolder,
	IconFolderFilled,
	IconMusic,
	IconPhoto,
	IconPhotoFilled,
	IconVideo,
	IconVideoFilled,
} from '@tabler/icons-vue';

const ICON_FACTORY = {
	folder: { filled: IconFolderFilled, outline: IconFolder },
	image: { filled: IconPhotoFilled, outline: IconPhoto },
	video: { filled: IconVideoFilled, outline: IconVideo },
	audio: { filled: IconFileMusicFilled, outline: IconMusic },
	archive: { filled: IconArchiveFilled, outline: IconFileZip },
	document: { filled: IconFileTextFilled, outline: IconFileText },
	other: { filled: IconFileDescriptionFilled, outline: IconFileDescription },
	all: { filled: IconFileDescriptionFilled, outline: IconFileDescription },
};

function getFileExtension(file) {
	const source = file.display_name || file.file_name || '';
	const parts = source.toLowerCase().split('.');
	return parts.length > 1 ? parts.at(-1) : '';
}

export function getFileCategory(file) {
	if (file.is_folder) return 'folder';
	const mimeType = (file.mime_type || file.mimeType || '').toLowerCase();
	const extension = getFileExtension(file);

	if (mimeType.startsWith('image/')) return 'image';
	if (mimeType.startsWith('video/')) return 'video';
	if (mimeType.startsWith('audio/')) return 'audio';
	if (
		mimeType.includes('zip') ||
		mimeType.includes('rar') ||
		mimeType.includes('7z') ||
		mimeType.includes('tar') ||
		['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)
	) {
		return 'archive';
	}
	if (
		mimeType === 'application/pdf' ||
		mimeType.startsWith('text/') ||
		mimeType.includes('document') ||
		mimeType.includes('word') ||
		mimeType.includes('sheet') ||
		mimeType.includes('excel') ||
		mimeType.includes('presentation') ||
		mimeType.includes('powerpoint') ||
		mimeType === 'application/json'
	) {
		return 'document';
	}

	return 'other';
}

export function getFileIcon(file, filled = false) {
	const category = file.is_folder ? 'folder' : getFileCategory(file);
	const entry = ICON_FACTORY[category] || ICON_FACTORY.document;
	return filled ? entry.filled : entry.outline;
}

export function getTypeFilterIcon(value, filled = false) {
	const entry = ICON_FACTORY[value] || ICON_FACTORY.all;
	return filled ? entry.filled : entry.outline;
}

const OFFICE_EXTENSION_MAP = {
	doc: 'document', docx: 'document', odt: 'document', rtf: 'document',
	xls: 'spreadsheet', xlsx: 'spreadsheet', ods: 'spreadsheet',
	ppt: 'presentation', pptx: 'presentation', odp: 'presentation',
};

export function getPreviewType(file) {
	if (!file || file.is_folder) return null;
	const mimeType = (file.mime_type || file.mimeType || '').toLowerCase();

	if (mimeType.startsWith('image/')) return 'image';
	if (mimeType.startsWith('video/')) return 'video';
	if (mimeType.startsWith('audio/')) return 'audio';
	if (mimeType === 'application/pdf') return 'pdf';

	if (mimeType.includes('officedocument.wordprocessingml') || mimeType === 'application/msword') return 'document';
	if (mimeType.includes('officedocument.spreadsheetml') || mimeType === 'application/vnd.ms-excel') return 'spreadsheet';
	if (mimeType.includes('officedocument.presentationml') || mimeType === 'application/vnd.ms-powerpoint') return 'presentation';
	if (mimeType.includes('opendocument.text')) return 'document';
	if (mimeType.includes('opendocument.spreadsheet')) return 'spreadsheet';
	if (mimeType.includes('opendocument.presentation')) return 'presentation';
	if (mimeType === 'application/rtf') return 'document';

	if (mimeType === 'application/json' || mimeType.startsWith('text/')) return 'text';

	const previewType = OFFICE_EXTENSION_MAP[getFileExtension(file)];
	return previewType || null;
}
