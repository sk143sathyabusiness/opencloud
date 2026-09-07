const EXTENSION_MIME_MAP = {
	png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
	webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
	heic: 'image/heic', heif: 'image/heif', tiff: 'image/tiff', tif: 'image/tiff',
	avif: 'image/avif',

	mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
	mkv: 'video/x-matroska', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv',
	flv: 'video/x-flv', '3gp': 'video/3gpp',

	mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg',
	oga: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', opus: 'audio/opus',
	wma: 'audio/x-ms-wma',

	pdf: 'application/pdf',
	doc: 'application/msword', dot: 'application/msword',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	odt: 'application/vnd.oasis.opendocument.text',
	ods: 'application/vnd.oasis.opendocument.spreadsheet',
	odp: 'application/vnd.oasis.opendocument.presentation',
	rtf: 'application/rtf',

	txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', log: 'text/plain',
	json: 'application/json', xml: 'text/xml', yaml: 'text/x-yaml', yml: 'text/x-yaml',
	env: 'text/plain', ini: 'text/plain', cfg: 'text/plain', conf: 'text/plain', toml: 'text/x-toml',
	html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',

	py: 'text/x-python', ipynb: 'application/json', ts: 'text/x-typescript', tsx: 'text/x-jsx',
	jsx: 'text/x-jsx', vue: 'text/x-vue', svelte: 'text/x-svelte',
	go: 'text/x-go', java: 'text/x-java-source', kt: 'text/x-kotlin', kts: 'text/x-kotlin',
	c: 'text/x-csrc', h: 'text/x-chdr', cpp: 'text/x-c++src', cc: 'text/x-c++src',
	cxx: 'text/x-c++src', hpp: 'text/x-c++hdr',
	rb: 'text/x-ruby', php: 'text/x-php', rs: 'text/x-rust', swift: 'text/x-swift',
	cs: 'text/x-csharp', scala: 'text/x-scala', lua: 'text/x-lua', pl: 'text/x-perl',
	r: 'text/x-r-source', dart: 'text/x-dart', sh: 'text/x-sh', bash: 'text/x-sh', zsh: 'text/x-sh',
	asm: 'text/x-asm', proto: 'text/x-protobuf', graphql: 'text/x-graphql', gql: 'text/x-graphql',
	sql: 'text/sql', bat: 'text/x-bat', ps1: 'text/x-powershell',

	zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
	tar: 'application/x-tar', gz: 'application/gzip', bz2: 'application/x-bzip2', xz: 'application/x-xz',
	iso: 'application/x-iso9660-image',

	exe: 'application/x-msdownload', msi: 'application/x-msdownload',
	apk: 'application/vnd.android.package-archive', dmg: 'application/x-apple-diskimage',
	ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
};

export function guessMimeType(fileName) {
	if (!fileName) return 'application/octet-stream';
	const extension = String(fileName).toLowerCase().split('.').pop();
	return EXTENSION_MIME_MAP[extension] || 'application/octet-stream';
}

export function resolveMimeType(record) {
	const provided = record?.mime_type;
	if (provided && provided !== 'application/octet-stream') {
		return provided;
	}
	return guessMimeType(record?.file_name);
}

const PREVIEWABLE_OFFICE_MIMES = [
	'application/pdf',
	'application/json',
	'application/msword',
	'application/vnd.ms-excel',
	'application/vnd.ms-powerpoint',
	'application/rtf',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	'application/vnd.openxmlformats-officedocument.presentationml.template',
	'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
	'application/vnd.oasis.opendocument.text',
	'application/vnd.oasis.opendocument.spreadsheet',
	'application/vnd.oasis.opendocument.presentation',
];

const PREVIEWABLE_EXTENSIONS = new Set([
	'txt', 'md', 'csv', 'log', 'json', 'xml', 'yaml', 'yml', 'env', 'ini', 'cfg', 'conf', 'toml',
	'html', 'htm', 'css', 'js', 'mjs', 'py', 'ipynb', 'ts', 'tsx', 'jsx', 'vue', 'svelte',
	'go', 'java', 'kt', 'kts', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'rb', 'php', 'rs',
	'swift', 'cs', 'scala', 'lua', 'pl', 'r', 'dart', 'sh', 'bash', 'zsh', 'asm', 'proto',
	'graphql', 'gql', 'sql', 'bat', 'ps1', 'doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods',
	'ppt', 'pptx', 'odp',
]);

function getExtension(fileName) {
	if (!fileName) return '';
	const parts = String(fileName).toLowerCase().split('.');
	return parts.length > 1 ? parts.at(-1) : '';
}

export function isPreviewableMime(mimeType, fileName) {
	if (/^(image|video|audio|text)\//.test(mimeType)) {
		return true;
	}
	if (PREVIEWABLE_OFFICE_MIMES.includes(mimeType)) {
		return true;
	}
	return PREVIEWABLE_EXTENSIONS.has(getExtension(fileName));
}
