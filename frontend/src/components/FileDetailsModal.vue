<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { IconX } from '@tabler/icons-vue';
import {
	formatBytes,
	formatDate,
	getCreatedTime,
	getModifiedTime,
	providerLabel as defaultProviderLabel,
} from '../composables/useFormatFile.js';
import { api } from '../services/api';

const props = defineProps({
	file: { type: Object, default: null },
	isOpen: { type: Boolean, default: false },
	isLoading: { type: Boolean, default: false },
	locationFallback: { type: String, default: '' },
	providerLabelFn: { type: Function, default: null },
	isFolder: { type: Boolean, default: false },
});

const emit = defineEmits(['close']);

const { t } = useI18n();

const isVisible = computed(() => Boolean(props.isOpen && props.file));
const providerLabel = computed(() => {
	const fn = typeof props.providerLabelFn === 'function' ? props.providerLabelFn : defaultProviderLabel;
	return fn(props.file?.provider) || props.file?.provider || '—';
});
const fileName = computed(() => props.file?.name || props.file?.file_name || '—');
const mimeType = computed(() => props.file?.mime_type || props.file?.mimeType || '—');
const owner = computed(() => props.file?.owner_email || props.file?.email || '—');
const remoteId = computed(() => props.file?.remote_file_id || props.file?.id || '—');
const location = computed(() => props.file?.virtual_path || props.locationFallback || '—');
const title = computed(() => (props.isFolder ? `${t('drive.details')} ${t('drive.folder')}` : t('drive.details')));

const liveLinks = ref([]);
async function loadLinks() {
	try {
		const { data } = await api.listShareLinks();
		liveLinks.value = (data || []).filter((link) => link.file_id === props.file?.id && !link.expired);
	} catch {
		liveLinks.value = [];
	}
}

watch(() => props.isOpen, (open) => {
	if (open) loadLinks();
});

function onBackdropClick() {
	emit('close');
}
</script>

<template>
	<div v-if="isVisible" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-4" @click="onBackdropClick">
		<div class="w-full max-w-lg rounded-[28px] bg-white p-6 text-[#202124] shadow-[0_24px_60px_rgba(32,33,36,0.28)] dark:bg-slate-800 dark:text-slate-100" @click.stop>
			<div class="flex items-start justify-between gap-4">
				<div>
					<h3 class="text-xl font-semibold">{{ title }}</h3>
					<p class="mt-1 text-sm text-[#5f6368] dark:text-slate-400">{{ t('drive.metadataDescription') }}</p>
				</div>
				<button type="button" class="grid size-9 place-items-center rounded-full text-[#5f6368] hover:bg-black/5 dark:text-slate-400 dark:hover:bg-white/8" :title="t('common.close')" @click="emit('close')">
					<IconX :size="18" :stroke="2" />
				</button>
			</div>

			<div v-if="liveLinks.length" class="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[#e8f0fe] px-3 py-1 text-xs font-medium text-[#1a73e8] dark:bg-sky-500/15 dark:text-blue-300">
				{{ t('share.hasLink') }} ({{ liveLinks.length }})
			</div>

			<div v-if="props.isLoading" class="mt-6 text-sm text-[#5f6368] dark:text-slate-400">
				{{ t('common.loading') }}
			</div>

			<dl v-else class="mt-6 grid grid-cols-[140px_1fr] gap-x-4 gap-y-3 text-sm">
				<dt class="text-[#5f6368] dark:text-slate-400">{{ t('common.name') }}</dt>
				<dd>{{ fileName }}</dd>
				<dt class="text-[#5f6368] dark:text-slate-400">{{ t('drive.type') }}</dt>
				<dd>{{ mimeType }}</dd>
				<dt class="text-[#5f6368] dark:text-slate-400">{{ t('drive.size') }}</dt>
				<dd>
					<span v-if="props.isFolder">—</span>
					<span v-else>{{ formatBytes(props.file?.size) }}</span>
				</dd>
				<dt class="text-[#5f6368] dark:text-slate-400">{{ t('drive.owner') }}</dt>
				<dd>{{ owner }}</dd>
				<dt class="text-[#5f6368] dark:text-slate-400">{{ t('drive.provider') || 'Provider' }}</dt>
				<dd>{{ providerLabel }}</dd>
				<dt class="text-[#5f6368] dark:text-slate-400">{{ t('drive.created') }}</dt>
				<dd>{{ formatDate(getCreatedTime(props.file)) }}</dd>
				<dt class="text-[#5f6368] dark:text-slate-400">{{ t('drive.modified') }}</dt>
				<dd>{{ formatDate(getModifiedTime(props.file)) }}</dd>
				<dt class="text-[#5f6368] dark:text-slate-400">{{ t('drive.location') }}</dt>
				<dd class="break-all">{{ location }}</dd>
				<dt class="text-[#5f6368] dark:text-slate-400">{{ t('drive.remoteId') || 'Remote ID' }}</dt>
				<dd class="break-all">{{ remoteId }}</dd>
			</dl>
		</div>
	</div>
</template>
