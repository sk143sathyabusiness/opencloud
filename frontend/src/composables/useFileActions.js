import { computed, ref } from 'vue';
import { api } from '../services/api';
import { useContextMenu } from './useContextMenu';
import { useFileSelection } from './useFileSelection';
import { useFilePreviewModal } from './useFilePreviewModal';
import { useFileDetailsModal } from './useFileDetailsModal';

export function useFileActions({
	sourceList,
	errorRef,
	t,
	getFileCategory,
	uploadQueueStore,
	refresh,
	getPreviewType,
	previewUnsupportedMessage = 'Preview belum didukung untuk tipe file ini.',
	onProgress,
}) {
	if (!errorRef || typeof t !== 'function' || typeof getFileCategory !== 'function' || !uploadQueueStore || typeof refresh !== 'function') {
		throw new Error('useFileActions: required options missing');
	}

	const runWithProgress = (label, task) => (typeof onProgress === 'function'
		? onProgress(label, task)
		: task());

	const { contextMenu, contextMenuRef, closeContextMenu, openContextMenu: openContextMenuBase } = useContextMenu();

	const {
		previewFile,
		isPreviewOpen,
		isPreviewLoading,
		canPreview,
		openPreview,
		closePreview,
		handlePreviewLoaded,
		handlePreviewFailed,
	} = useFilePreviewModal({
		getFileCategory,
		buildPreviewUrl: (file) => api.previewUrl(file.id),
		getPreviewType,
		onUnsupported: () => {
			closeContextMenu();
			errorRef.value = previewUnsupportedMessage;
		},
	});

	const {
		detailsFile,
		isDetailsOpen,
		openDetails,
		closeDetails,
	} = useFileDetailsModal({
		fetchDetails: (file) => api.getFileDetails(file.id),
		onError: (error) => {
			errorRef.value = error.message;
		},
	});

	const {
		selectedFileIds,
		lastSelectedFileId,
		selectedFiles,
		selectedCount,
		primarySelectedFile,
		isSelected,
		replaceSelection,
		toggleSelection,
		selectRange,
		selectItem,
		clearSelection,
	} = useFileSelection({ sourceList, onBeforeSelect: closeContextMenu });

	const canDownloadSelection = computed(
		() => selectedFiles.value.some((file) => !file.is_folder),
	);
	const canBackupToTelegram = computed(
		() => selectedFiles.value.some((file) => !file.is_folder),
	);
	const canRenameSelection = computed(
		() => selectedCount.value === 1 && primarySelectedFile.value?.capabilities?.rename !== false,
	);
	const canToggleStarSelection = computed(() => {
		if (selectedCount.value !== 1) return false;
		const file = primarySelectedFile.value;
		return Boolean(file && file.capabilities?.starred);
	});
	const isPrimarySelectedStarred = computed(
		() => Boolean(primarySelectedFile.value?.is_starred),
	);
	const canOpenSelection = computed(
		() => selectedCount.value === 1 && Boolean(primarySelectedFile.value?.is_folder),
	);
	const canPreviewSelection = computed(
		() => selectedCount.value === 1 && canPreview(primarySelectedFile.value),
	);

	function getActionFiles(fallbackFile = contextMenu.value.file) {
		return selectedFiles.value.length
			? selectedFiles.value
			: (fallbackFile ? [fallbackFile] : []);
	}

	function openContextMenu(event, file) {
		if (!selectedFileIds.value.has(file.id)) replaceSelection(file);
		return openContextMenuBase(event, file);
	}

	function resolveFile() {
		return primarySelectedFile.value || contextMenu.value.file;
	}

	async function showSelectedFileDetails() {
		const file = resolveFile();
		if (!file) return;
		closeContextMenu();
		errorRef.value = '';
		await openDetails(file);
	}

	async function renameSelectedFile({ trackServerOperation } = {}) {
		const file = resolveFile();
		if (!file) return;
		const nextName = window.prompt(t('drive.newNamePrompt'), file.file_name);
		closeContextMenu();
		if (!nextName?.trim() || nextName.trim() === file.file_name) return;
		errorRef.value = '';
		try {
			const task = () => (typeof trackServerOperation === 'function'
				? trackServerOperation(file, nextName.trim())
				: api.renameFile(file.id, { name: nextName.trim() }));
			await runWithProgress(t('upload.renaming'), task);
			await refresh();
		} catch (error) {
			errorRef.value = error.message;
		}
	}

	async function deleteSelectedFile({ trackServerOperation } = {}) {
		const targets = getActionFiles();
		if (!targets.length) return;

		const message = targets.length === 1
			? t('drive.deleteConfirm', { name: targets[0].file_name })
			: t('drive.deleteConfirm', { name: `${targets.length} ${t('common.items')}` });

		const confirmed = window.confirm(message);
		closeContextMenu();
		if (!confirmed) return;
		errorRef.value = '';
		try {
			const task = () => {
				if (targets.length === 1) {
					const target = targets[0];
					if (typeof trackServerOperation === 'function') {
						return trackServerOperation(target);
					}
					return api.deleteFile(target.id);
				}
				if (typeof trackServerOperation === 'function') {
					return trackServerOperation(targets);
				}
				return api.deleteFiles(targets.map((file) => file.id));
			};
			await runWithProgress(t('upload.deleting'), task);
			clearSelection();
			await refresh();
		} catch (error) {
			errorRef.value = error.message;
		}
	}

	async function toggleSelectedFileStar() {
		const file = resolveFile();
		if (!file || !file.capabilities?.starred) return;
		const nextStarred = !Boolean(file.is_starred);
		const label = nextStarred ? t('drive.star') : t('drive.unstar');
		closeContextMenu();
		errorRef.value = '';
		try {
			const task = () => api.toggleStar(file.id, nextStarred);
			await runWithProgress(label, task);
			await refresh();
		} catch (error) {
			errorRef.value = error.message;
		}
	}

	function downloadSelection() {
		const downloadableFiles = getActionFiles().filter((file) => !file.is_folder);
		closeContextMenu();
		uploadQueueStore.downloadFiles(downloadableFiles).catch((error) => {
			errorRef.value = error.message;
		});
	}

	const canZipDownloadSelection = computed(
		() => selectedFiles.value.length > 0
			|| (contextMenu.value.file && contextMenu.value.file.is_folder),
	);

	async function downloadSelectionAsZip() {
		const targets = getActionFiles();
		if (!targets.length) return;
		closeContextMenu();
		errorRef.value = '';
		try {
			const response = await api.bulkDownload(targets.map((file) => file.id));
			if (!response.ok) {
				const payload = await response.json().catch(() => ({ error: 'ZIP download failed' }));
				throw new Error(payload.error || 'ZIP download failed');
			}
			const blob = await response.blob();
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement('a');
			anchor.href = url;
			anchor.download = 'omnicloud-download.zip';
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			URL.revokeObjectURL(url);
		} catch (error) {
			errorRef.value = error.message;
		}
	}

	function triggerDownload(file) {
		closeContextMenu();
		if (file?.is_folder) return;
		uploadQueueStore.downloadFile(file).catch((error) => {
			errorRef.value = error.message;
		});
	}

	async function backupSelectedFileToTelegram() {
		const targets = getActionFiles().filter((file) => !file.is_folder);
		if (!targets.length) return;
		closeContextMenu();
		errorRef.value = '';
		try {
			for (const file of targets) {
				await runWithProgress(t('telegram.backingUp'), () => api.backupFileToTelegram(file.id));
			}
		} catch (error) {
			errorRef.value = error.message;
		}
	}

	const canShareSelection = computed(
		() => selectedCount.value === 1 && Boolean(primarySelectedFile.value) && !primarySelectedFile.value.is_folder,
	);
	const shareLinkFile = ref(null);
	const isShareLinkOpen = ref(false);
	function openShareLinkModal() {
		const file = resolveFile();
		if (!file || file.is_folder) return;
		closeContextMenu();
		shareLinkFile.value = file;
		isShareLinkOpen.value = true;
	}
	function closeShareLinkModal() {
		isShareLinkOpen.value = false;
		shareLinkFile.value = null;
	}

	return {
		contextMenu,
		contextMenuRef,
		closeContextMenu,
		openContextMenu,
		selectedFileIds,
		lastSelectedFileId,
		selectedFiles,
		selectedCount,
		primarySelectedFile,
		isSelected,
		replaceSelection,
		toggleSelection,
		selectRange,
		selectItem,
		clearSelection,
		getActionFiles,
		previewFile,
		isPreviewOpen,
		isPreviewLoading,
		canPreview,
		openPreview,
		closePreview,
		handlePreviewLoaded,
		handlePreviewFailed,
		detailsFile,
		isDetailsOpen,
		openDetails,
		closeDetails,
		renameSelectedFile,
		deleteSelectedFile,
		downloadSelection,
		triggerDownload,
		canZipDownloadSelection,
		downloadSelectionAsZip,
		toggleSelectedFileStar,
		showSelectedFileDetails,
		canDownloadSelection,
		canRenameSelection,
		canBackupToTelegram,
		backupSelectedFileToTelegram,
		canToggleStarSelection,
		isPrimarySelectedStarred,
		canOpenSelection,
		canPreviewSelection,
		canShareSelection,
		shareLinkFile,
		isShareLinkOpen,
		openShareLinkModal,
		closeShareLinkModal,
	};
}
