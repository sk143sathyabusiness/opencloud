import { reactive, ref } from 'vue';

const MAX_SPREADSHEET_SHEETS = 8;
const MAX_SPREADSHEET_ROWS = 100;

async function fetchBytes(url) {
	const response = await fetch(url, { credentials: 'include' });
	if (!response.ok) {
		throw new Error(`Failed to load preview (${response.status})`);
	}
	return response.arrayBuffer();
}

function joinZipPath(baseDir, target) {
	const parts = baseDir.split('/');
	for (const segment of String(target).split('/')) {
		if (segment === '..') {
			parts.pop();
		} else if (segment && segment !== '.') {
			parts.push(segment);
		}
	}
	return parts.join('/');
}

function parseSlides(zip) {
	const slides = [];
	const slideNames = Object.keys(zip.files)
		.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
		.sort((a, b) => {
			const left = Number(a.match(/slide(\d+)/)[1]);
			const right = Number(b.match(/slide(\d+)/)[1]);
			return left - right;
		});

	return Promise.all(slideNames.map(async (name) => {
		const slideNumber = name.match(/slide(\d+)/)[1];
		const slideDoc = new DOMParser().parseFromString(await zip.file(name).async('string'), 'application/xml');

		const relsZipPath = `ppt/slides/_rels/slide${slideNumber}.xml.rels`;
		const relMap = {};
		const relsFile = zip.file(relsZipPath);
		if (relsFile) {
			const relsDoc = new DOMParser().parseFromString(await relsFile.async('string'), 'application/xml');
			const relationships = relsDoc.getElementsByTagName('Relationship');
			for (const relationship of relationships) {
				relMap[relationship.getAttribute('Id')] = relationship.getAttribute('Target');
			}
		}

		const images = [];
		const blips = slideDoc.getElementsByTagName('a:blip');
		for (const blip of blips) {
			const rid = blip.getAttribute('r:embed') || blip.getAttribute('embed');
			const target = relMap[rid];
			if (!rid || !target) continue;
			const resourcePath = joinZipPath('ppt/slides', target);
			const resource = zip.file(resourcePath) || zip.file(`${resourcePath}`.replace(/^\//, ''));
			if (resource) {
				images.push(URL.createObjectURL(await resource.async('blob')));
			}
		}

		const texts = [...slideDoc.getElementsByTagName('a:t')]
			.map((node) => node.textContent.replace(/\s+/g, ' ').trim())
			.filter(Boolean);

		return { number: Number(slideNumber), texts, images };
	}));
}

export function useOfficePreview() {
	const docxContainer = ref(null);
	const spreadsheet = reactive({ sheets: [], activeIndex: 0 });
	const presentation = ref([]);
	const officeError = ref('');

	const objectUrls = [];

	function cleanupObjectUrls() {
		objectUrls.splice(0).forEach((url) => URL.revokeObjectURL(url));
	}

	async function renderDocument(url) {
		if (!docxContainer.value) return;
		docxContainer.value.innerHTML = '';
		const { renderAsync } = await import('docx-preview');
		await renderAsync(await fetchBytes(url), docxContainer.value, undefined, {
			ignoreLastRenderedBreakElement: true,
		});
	}

	async function renderSpreadsheet(url) {
		const XLSX = await import('xlsx');
		const workbook = XLSX.read(new Uint8Array(await fetchBytes(url)), { type: 'array' });
		const sheets = workbook.SheetNames.slice(0, MAX_SPREADSHEET_SHEETS).map((name) => {
			const worksheet = workbook.Sheets[name];
			const matrix = XLSX.utils.sheet_to_json(worksheet, {
				header: 1,
				defval: '',
				raw: false,
			}).slice(0, MAX_SPREADSHEET_ROWS);
			return {
				name,
				rows: matrix.map((row) => row.map((cell) => String(cell == null ? '' : cell))),
			};
		});
		spreadsheet.sheets = sheets;
		spreadsheet.activeIndex = 0;
	}

	async function renderPresentation(url) {
		const JSZip = (await import('jszip')).default;
		const zip = await JSZip.loadAsync(await fetchBytes(url));
		const slides = await parseSlides(zip);
		slides.forEach((slide) => objectUrls.push(...slide.images));
		presentation.value = slides;
	}

	async function render(file) {
		officeError.value = '';
		cleanupObjectUrls();
		spreadsheet.sheets = [];
		spreadsheet.activeIndex = 0;
		presentation.value = [];

		const url = file?.previewUrl;
		if (!url) return;

		try {
			if (file.previewType === 'document') {
				if (!file.extension || file.extension.toLowerCase() === 'docx') {
					await renderDocument(url);
				} else {
					officeError.value = 'unsupported';
				}
			} else if (file.previewType === 'spreadsheet') {
				if (!file.extension || /^(xls|xlsx|ods)$/.test(file.extension.toLowerCase())) {
					await renderSpreadsheet(url);
				} else {
					officeError.value = 'unsupported';
				}
			} else if (file.previewType === 'presentation') {
				if (!file.extension || file.extension.toLowerCase() === 'pptx') {
					await renderPresentation(url);
				} else {
					officeError.value = 'unsupported';
				}
			}
		} catch (error) {
			officeError.value = error.message || 'failed';
		}
	}

	return {
		docxContainer,
		spreadsheet,
		presentation,
		officeError,
		setActiveSheet(index) {
			spreadsheet.activeIndex = index;
		},
		render,
		cleanup: cleanupObjectUrls,
	};
}