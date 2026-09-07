import { ref } from 'vue';

function defaultCanPreview(file, getFileCategory) {
	return Boolean(
		file
			&& !file.is_folder
			&& ['image', 'video', 'audio', 'document'].includes(getFileCategory(file)),
	);
}

export function useFilePreviewModal({
	getFileCategory,
	buildPreviewUrl,
	getPreviewType,
	onUnsupported,
} = {}) {
	if (typeof getFileCategory !== 'function') {
		throw new Error('useFilePreviewModal: getFileCategory is required');
	}
	if (typeof buildPreviewUrl !== 'function') {
		throw new Error('useFilePreviewModal: buildPreviewUrl is required');
	}

	const previewFile = ref(null);
	const isPreviewOpen = ref(false);
	const isPreviewLoading = ref(false);

	const previewTypeOf = typeof getPreviewType === 'function'
		? getPreviewType
		: (file) => getFileCategory(file);

	const canPreview = typeof getPreviewType === 'function'
		? (file) => Boolean(previewTypeOf(file))
		: (file) => defaultCanPreview(file, getFileCategory);

	function openPreview(file) {
		if (!canPreview(file)) {
			if (typeof onUnsupported === 'function') onUnsupported(file);
			return false;
		}
		isPreviewLoading.value = true;
		const sourceName = file.display_name || file.file_name || '';
		const nameParts = sourceName.split('.');
		previewFile.value = {
			...file,
			previewType: previewTypeOf(file),
			previewUrl: buildPreviewUrl(file),
			extension: nameParts.length > 1 ? nameParts.at(-1).toLowerCase() : '',
		};
		isPreviewOpen.value = true;
		return true;
	}

	function closePreview() {
		isPreviewOpen.value = false;
		previewFile.value = null;
		isPreviewLoading.value = false;
	}

	function handlePreviewLoaded() {
		isPreviewLoading.value = false;
	}

	function handlePreviewFailed() {
		isPreviewLoading.value = false;
	}

	return {
		previewFile,
		isPreviewOpen,
		isPreviewLoading,
		canPreview,
		openPreview,
		closePreview,
		handlePreviewLoaded,
		handlePreviewFailed,
	};
}
