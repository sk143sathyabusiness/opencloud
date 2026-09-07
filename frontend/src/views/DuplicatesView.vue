<script setup>
import { ref, computed } from 'vue';
import { onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { useFileSelection } from '../composables/useFileSelection';
import DriveShell from '../components/DriveShell.vue';

const { t } = useI18n();
const groups = ref([]);
const loading = ref(true);
const errorRef = ref('');
const flatItems = computed(() => groups.value.flatMap((g) => g.items));
const { selectedFileIds, toggleSelection, clearSelection, selectedFiles } = useFileSelection({ sourceList: flatItems });
const isBusy = ref(false);

async function refresh() {
	loading.value = true;
	errorRef.value = '';
	try {
		const res = await api.duplicates();
		groups.value = res.data || [];
	} catch (error) {
		errorRef.value = error.message;
	} finally {
		loading.value = false;
	}
}

function keepOne(group) {
	clearSelection();
	const newest = group.items[0];
	group.items.forEach((item) => {
		if (item.id !== newest.id) toggleSelection(item);
	});
}

async function deleteSelected() {
	if (!selectedFiles.value.length) return;
	if (!window.confirm(t('duplicates.confirmDelete', { name: t('common.items') }))) return;
	isBusy.value = true;
	try {
		await api.deleteFiles(selectedFiles.value.map((f) => f.id));
		clearSelection();
		await refresh();
	} catch (error) {
		errorRef.value = error.message;
	} finally {
		isBusy.value = false;
	}
}

function formatSize(size) {
	if (!size) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
	return `${(size / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

onMounted(refresh);
</script>

<template>
	<DriveShell current-section="duplicates">
		<div class="mx-auto max-w-5xl px-4 py-6">
			<h1 class="text-2xl font-semibold">{{ t('duplicates.title') }}</h1>
			<p class="mt-1 text-sm text-[#5f6368] dark:text-slate-400">{{ t('duplicates.description') }}</p>

			<div v-if="selectedFiles.length" class="sticky top-20 z-30 mt-4 flex items-center gap-3 rounded-full bg-[#e8f0fe] px-4 py-2 dark:bg-sky-500/15">
				<span class="text-sm font-semibold">{{ selectedFiles.length }} {{ t('common.items') }}</span>
				<button type="button" class="ml-auto rounded-full bg-[#c5221f] px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50" :disabled="isBusy" @click="deleteSelected">Delete</button>
			</div>

			<div v-if="errorRef" class="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-200">{{ errorRef }}</div>

			<div v-if="loading" class="mt-8 text-center text-sm text-[#5f6368] dark:text-slate-400">{{ t('common.loading') }}</div>
			<div v-else-if="!groups.length" class="mt-16 text-center">
				<p class="text-sm font-medium">{{ t('duplicates.empty') }}</p>
				<p class="mt-1 text-xs text-[#5f6368] dark:text-slate-400">{{ t('duplicates.emptyState') }}</p>
			</div>
			<div v-else class="mt-6 space-y-4">
				<div v-for="group in groups" :key="group.key" class="rounded-2xl border border-[#e8f0fe] bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
					<div class="flex items-center justify-between gap-3">
						<div class="min-w-0">
							<div class="truncate text-sm font-semibold">{{ group.file_name }}</div>
							<div class="mt-0.5 text-xs text-[#5f6368] dark:text-slate-400">{{ group.count }} {{ t('duplicates.files') }} · {{ formatSize(group.size) }} × {{ group.count }} · {{ t('duplicates.wasted') }} {{ formatSize(group.totalBytes - group.size) }}</div>
						</div>
						<button type="button" class="shrink-0 rounded-full border border-[#1a73e8] px-3 py-1.5 text-xs font-semibold text-[#1a73e8] hover:bg-[#e8f0fe] dark:border-blue-400 dark:text-blue-300 dark:hover:bg-blue-500/15" @click="keepOne(group)">{{ t('duplicates.keepOne') }}</button>
					</div>
					<ul class="mt-3 space-y-1">
						<li v-for="item in group.items" :key="item.id" class="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[#f8fafd] dark:hover:bg-slate-700/40" @click="toggleSelection(item)">
							<input type="checkbox" :checked="selectedFileIds.has(item.id)" class="size-4 accent-[#1a73e8]" />
							<span class="truncate text-sm">{{ item.file_name }}</span>
							<span class="ml-auto shrink-0 text-xs text-[#5f6368] dark:text-slate-400">{{ item.provider }} · {{ item.virtual_path }}</span>
						</li>
					</ul>
				</div>
			</div>
		</div>
	</DriveShell>
</template>