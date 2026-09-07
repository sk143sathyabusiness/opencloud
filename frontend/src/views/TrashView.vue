<script setup>
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { IconRestore } from '@tabler/icons-vue';
import { api } from '../services/api';
import { useFileSelection } from '../composables/useFileSelection';
import { formatBytes, formatDate, providerLabel } from '../composables/useFormatFile.js';
import DriveShell from '../components/DriveShell.vue';
import FileListSelectionBar from '../components/FileListSelectionBar.vue';

const { t } = useI18n();
const items = ref([]);
const loading = ref(true);
const isBusy = ref(false);
const errorRef = ref('');

const {
	selectedFiles,
	selectedCount,
	isSelected,
	selectItem,
	clearSelection,
} = useFileSelection({ sourceList: items });

const canActOnSelection = computed(() => selectedCount.value > 0);

async function refresh() {
	loading.value = true;
	errorRef.value = '';
	try {
		const res = await api.listTrash();
		items.value = res.data || [];
	} catch (error) {
		errorRef.value = error.message;
	} finally {
		loading.value = false;
	}
}

async function run(then) {
	isBusy.value = true;
	try {
		await then();
		clearSelection();
		await refresh();
	} catch (error) {
		errorRef.value = error.message;
	} finally {
		isBusy.value = false;
	}
}

async function restoreSelected() {
	await run(() => api.restoreTrashFiles(selectedFiles.value.map((f) => f.id)));
}

async function deleteSelectedForever() {
	if (!selectedCount.value) return;
	if (!window.confirm(t('trash.confirmDeleteForever', { name: t('common.items') }))) {
		clearSelection();
		return;
	}
	await run(() => api.deleteTrashFiles(selectedFiles.value.map((f) => f.id)));
}

async function emptyTrash() {
	if (!items.value.length) return;
	if (!window.confirm(t('trash.confirmEmpty'))) {
		clearSelection();
		return;
	}
	await run(() => api.emptyTrash());
}

onMounted(refresh);
</script>

<template>
	<DriveShell current-section="trash">
		<div class="mx-auto max-w-6xl px-4 py-6">
			<div class="flex items-center justify-between gap-4">
				<div>
					<h1 class="text-2xl font-semibold">{{ t('trash.title') }}</h1>
					<p class="mt-1 text-sm text-[#5f6368] dark:text-slate-400">{{ t('trash.emptyState') }}</p>
				</div>
				<button
					v-if="items.length"
					type="button"
					class="rounded-full bg-[#c5221f] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
					:disabled="isBusy"
					@click="emptyTrash"
				>{{ t('trash.emptyTrash') }}</button>
			</div>

			<div class="relative min-h-[calc(100vh-84px)] rounded-[24px] bg-white px-4 py-[18px] pb-5 text-[#202124] shadow-sm dark:bg-slate-800 dark:text-slate-100 sm:px-6" @click="clearSelection">
				<div v-if="selectedCount" class="sticky top-20 z-30 mb-4 -ml-1">
					<FileListSelectionBar
						:selected-count="selectedCount"
						:can-delete="canActOnSelection"
						@clear="clearSelection"
						@delete="deleteSelectedForever"
					>
						<template #prefix>
							<button type="button" class="inline-flex size-9 items-center justify-center rounded-full transition hover:bg-[#d2e3fc] dark:hover:bg-sky-500/20" :title="t('trash.restore')" @click="restoreSelected">
								<IconRestore :size="18" :stroke="2" />
							</button>
						</template>
					</FileListSelectionBar>
				</div>

				<div v-if="errorRef" class="mb-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-200">{{ errorRef }}</div>

				<div v-if="loading" class="py-16 text-center text-sm text-[#5f6368] dark:text-slate-400">{{ t('common.loading') }}</div>
				<div v-else-if="!items.length" class="py-16 text-center">
					<p class="text-sm font-medium">{{ t('trash.empty') }}</p>
					<p class="mt-1 text-xs text-[#5f6368] dark:text-slate-400">{{ t('trash.emptyState') }}</p>
				</div>
				<div v-else class="divide-y divide-[#e8f0fe] overflow-hidden rounded-2xl border border-[#e8f0fe] bg-white dark:divide-slate-700 dark:border-slate-700 dark:bg-slate-800">
					<div
						v-for="item in items"
						:key="item.id"
						class="flex cursor-pointer items-center gap-3 px-4 py-3 transition hover:bg-[#f8fafd] dark:hover:bg-slate-700/40"
						:class="isSelected(item) ? 'bg-[#e8f0fe] dark:bg-blue-500/15' : ''"
						@click="(event) => selectItem(event, item)"
						@contextmenu="(event) => selectItem(event, item)"
					>
						<div class="grid size-9 shrink-0 place-items-center rounded-2xl bg-[#e8f0fe] text-[#1a73e8] dark:bg-blue-500/15 dark:text-blue-300">
							{{ providerLabel(item.provider) }}
						</div>
						<div class="min-w-0 flex-1">
							<div class="truncate text-sm font-medium">{{ item.file_name }}</div>
							<div class="truncate text-xs text-[#5f6368] dark:text-slate-400">{{ item.virtual_path }}</div>
						</div>
						<div class="shrink-0 text-xs text-[#5f6368] dark:text-slate-400">{{ item.is_folder ? t('common.folder') : formatBytes(item.size) }}</div>
						<div class="shrink-0 text-xs text-[#5f6368] dark:text-slate-400">{{ formatDate(item.deleted_at) }}</div>
					</div>
				</div>
			</div>
		</div>
	</DriveShell>
</template>