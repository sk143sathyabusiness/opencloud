<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { IconX, IconPlayerPlay, IconDownload } from '@tabler/icons-vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { useOfficePreview } from '../composables/useOfficePreview';

const props = defineProps({
	file: { type: Object, default: null },
	isOpen: { type: Boolean, default: false },
	isLoading: { type: Boolean, default: false },
});

const emit = defineEmits(['close', 'loaded', 'failed']);

const { t } = useI18n();

const {
	docxContainer,
	spreadsheet,
	presentation,
	officeError,
	setActiveSheet,
	render: renderOffice,
	cleanup: cleanupOffice,
} = useOfficePreview();

const TEXT_LIMIT = 2 * 1024 * 1024;
const MAX_TEXT_LINES = 8000;

const textContent = ref('');
const textTruncated = ref(false);

const displayName = computed(() => {
	if (!props.file) return '';
	return props.file.display_name || props.file.file_name || props.file.name || '';
});

const isVisible = computed(() => Boolean(props.isOpen && props.file));

const textLines = computed(() => textContent.value.split('\n').slice(0, MAX_TEXT_LINES));

const activePreviewSource = computed(() => (props.isOpen ? props.file : null));

watch(activePreviewSource, (file) => {
	if (!file) {
		textContent.value = '';
		textTruncated.value = false;
		officeError.value = '';
		cleanupOffice();
		if (docxContainer.value) docxContainer.value.innerHTML = '';
		return;
	}
	runPreview(file);
});

async function runPreview(file) {
	textContent.value = '';
	textTruncated.value = false;
	officeError.value = '';
	if (docxContainer.value) docxContainer.value.innerHTML = '';

	if (file.previewType === 'text') {
		try {
			const response = await fetch(file.previewUrl, { credentials: 'include' });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const raw = await response.text();
			textTruncated.value = raw.length > TEXT_LIMIT;
			textContent.value = raw.slice(0, TEXT_LIMIT);
			emit('loaded');
		} catch (error) {
			officeError.value = error.message || 'failed';
			emit('failed');
		}
		return;
	}

	if (['document', 'spreadsheet', 'presentation'].includes(file.previewType)) {
		await nextTick();
		await renderOffice(file);
		if (officeError.value) {
			emit('failed');
		} else {
			emit('loaded');
		}
	}
}

function onLoad() {
	emit('loaded');
}

function onError() {
	emit('failed');
}

function onBackdropClick() {
	emit('close');
}

function onClose() {
	emit('close');
}

function downloadFile() {
	if (!props.file) return;
	window.open(api.downloadUrl(props.file.id), '_blank', 'noopener');
}

onBeforeUnmount(() => {
	cleanupOffice();
});
</script>

<template>
	<div v-if="isVisible" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 px-4 py-8" @click="onBackdropClick">
		<div class="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-[28px] bg-white text-[#202124] shadow-[0_24px_60px_rgba(32,33,36,0.28)] dark:bg-slate-900 dark:text-slate-100" @click.stop>
			<div class="flex items-center justify-between gap-4 border-b border-[#e8eaed] px-5 py-4 dark:border-slate-800">
				<div class="min-w-0">
					<p class="truncate text-base font-semibold">{{ displayName }}</p>
				</div>
				<div class="flex items-center gap-2">
					<button v-if="props.file" type="button" class="grid size-10 place-items-center rounded-full text-[#5f6368] hover:bg-black/5 dark:text-slate-400 dark:hover:bg-white/8" :title="t('fileExplorer.download')" @click="downloadFile">
						<IconDownload :size="18" :stroke="2" />
					</button>
					<button type="button" class="grid size-10 place-items-center rounded-full text-[#5f6368] hover:bg-black/5 dark:text-slate-400 dark:hover:bg-white/8" @click="onClose">
						<IconX :size="18" :stroke="2" />
					</button>
				</div>
			</div>
			<div class="relative min-h-[420px] flex-1 bg-[#f8fafd] dark:bg-slate-950">
				<div v-if="props.isLoading" class="absolute inset-0 z-10 grid place-items-center text-sm text-[#5f6368] dark:text-slate-400">
					{{ t('preview.loading') }}
				</div>

				<img v-if="props.file?.previewType === 'image'" :src="props.file?.previewUrl" class="max-h-[75vh] w-full object-contain" alt="Preview file" @load="onLoad" @error="onError" />
				<video v-else-if="props.file?.previewType === 'video'" class="max-h-[75vh] w-full bg-black" controls playsinline @loadeddata="onLoad" @error="onError">
					<source :src="props.file?.previewUrl" :type="props.file?.mime_type || 'video/mp4'" />
				</video>
				<audio v-else-if="props.file?.previewType === 'audio'" class="w-full px-6 py-16" controls preload="metadata" @loadeddata="onLoad" @error="onError">
					<source :src="props.file?.previewUrl" :type="props.file?.mime_type || 'audio/mpeg'" />
				</audio>
				<iframe v-else-if="props.file?.previewType === 'pdf'" :src="props.file?.previewUrl" class="h-[75vh] w-full border-0" :title="t('preview.document')" @load="onLoad" />

				<template v-else-if="props.file?.previewType === 'text'">
					<div v-if="officeError" class="grid h-[75vh] place-items-center px-6">
						<div class="text-center">
							<div class="mx-auto grid size-16 place-items-center rounded-full bg-[#fce8e6] text-[#c5221f] dark:bg-slate-800 dark:text-red-300">
								<IconPlayerPlay :size="28" :stroke="1.8" />
							</div>
							<p class="mt-4 text-sm text-[#5f6368] dark:text-slate-400">{{ t('preview.notRendered') }}</p>
							<button type="button" class="mt-4 inline-flex items-center gap-2 rounded-full bg-[#1a73e8] px-4 py-2 text-sm text-white" @click="downloadFile">
								<IconDownload :size="16" :stroke="2" />
								{{ t('fileExplorer.download') }}
							</button>
						</div>
					</div>
					<div v-else class="h-[75vh] overflow-auto bg-white dark:bg-slate-900">
						<div v-if="textTruncated" class="sticky top-0 z-10 border-b border-[#e8eaed] bg-[#fef7e0] px-4 py-2 text-xs text-[#7a5c00] dark:border-slate-800 dark:bg-slate-800 dark:text-yellow-200">
							{{ t('preview.truncated', { limit: '2 MB' }) }}
						</div>
						<pre class="min-w-max p-4 font-mono text-[12.5px] leading-5 text-[#202124] dark:text-slate-100"><template v-for="(line, index) in textLines" :key="index"><span class="inline-block w-12 select-none pr-4 text-right text-[#9aa0a6] dark:text-slate-500">{{ index + 1 }}</span><span class="whitespace-pre-wrap break-all pr-8">{{ line }}</span>
</template></pre>
					</div>
				</template>

				<template v-else-if="props.file?.previewType === 'document'">
					<div v-if="officeError" class="grid h-[75vh] place-items-center px-6">
						<div class="text-center">
							<div class="mx-auto grid size-16 place-items-center rounded-full bg-[#fce8e6] text-[#c5221f] dark:bg-slate-800 dark:text-red-300">
								<IconPlayerPlay :size="28" :stroke="1.8" />
							</div>
							<p class="mt-4 text-sm text-[#5f6368] dark:text-slate-400">{{ t('preview.notRendered') }}</p>
							<button type="button" class="mt-4 inline-flex items-center gap-2 rounded-full bg-[#1a73e8] px-4 py-2 text-sm text-white" @click="downloadFile">
								<IconDownload :size="16" :stroke="2" />
								{{ t('fileExplorer.download') }}
							</button>
						</div>
					</div>
					<div v-else ref="docxContainer" class="h-[75vh] overflow-auto bg-[#e8eaed] p-6 dark:bg-slate-800"></div>
				</template>

				<template v-else-if="props.file?.previewType === 'spreadsheet'">
					<div v-if="officeError" class="grid h-[75vh] place-items-center px-6">
						<div class="text-center">
							<div class="mx-auto grid size-16 place-items-center rounded-full bg-[#fce8e6] text-[#c5221f] dark:bg-slate-800 dark:text-red-300">
								<IconPlayerPlay :size="28" :stroke="1.8" />
							</div>
							<p class="mt-4 text-sm text-[#5f6368] dark:text-slate-400">{{ t('preview.notRendered') }}</p>
							<button type="button" class="mt-4 inline-flex items-center gap-2 rounded-full bg-[#1a73e8] px-4 py-2 text-sm text-white" @click="downloadFile">
								<IconDownload :size="16" :stroke="2" />
								{{ t('fileExplorer.download') }}
							</button>
						</div>
					</div>
					<div v-else class="h-[75vh] overflow-auto p-4">
						<div v-if="spreadsheet.sheets.length > 1" class="mb-3 flex flex-wrap gap-2">
							<button v-for="(sheet, index) in spreadsheet.sheets" :key="sheet.name" type="button" class="rounded-full px-3 py-1 text-xs font-medium" :class="index === spreadsheet.activeIndex ? 'bg-[#1a73e8] text-white' : 'bg-black/5 text-[#5f6368] hover:bg-black/10 dark:bg-white/10 dark:text-slate-300'" @click="setActiveSheet(index)">
								{{ sheet.name }}
							</button>
						</div>
						<div class="overflow-auto">
							<table class="border-collapse bg-white font-mono text-[12px] text-[#202124] dark:bg-slate-900 dark:text-slate-100">
								<tbody>
									<template v-for="(row, rowIndex) in spreadsheet.sheets[spreadsheet.activeIndex]?.rows || []" :key="rowIndex">
										<tr :class="rowIndex === 0 ? 'bg-[#f1f3f4] font-semibold dark:bg-slate-800' : rowIndex % 2 === 0 ? 'bg-white dark:bg-slate-900' : 'bg-[#fafbfc] dark:bg-slate-800'">
											<td v-for="(cell, cellIndex) in row" :key="cellIndex" class="max-w-[320px] border border-[#e8eaed] px-2 py-1 dark:border-slate-700">
												<span class="line-clamp-2 whitespace-pre-wrap break-words">{{ cell }}</span>
											</td>
										</tr>
									</template>
								</tbody>
							</table>
						</div>
					</div>
				</template>

				<template v-else-if="props.file?.previewType === 'presentation'">
					<div v-if="officeError" class="grid h-[75vh] place-items-center px-6">
						<div class="text-center">
							<div class="mx-auto grid size-16 place-items-center rounded-full bg-[#fce8e6] text-[#c5221f] dark:bg-slate-800 dark:text-red-300">
								<IconPlayerPlay :size="28" :stroke="1.8" />
							</div>
							<p class="mt-4 text-sm text-[#5f6368] dark:text-slate-400">{{ t('preview.notRendered') }}</p>
							<button type="button" class="mt-4 inline-flex items-center gap-2 rounded-full bg-[#1a73e8] px-4 py-2 text-sm text-white" @click="downloadFile">
								<IconDownload :size="16" :stroke="2" />
								{{ t('fileExplorer.download') }}
							</button>
						</div>
					</div>
					<div v-else class="h-[75vh] space-y-6 overflow-auto p-6">
						<section v-for="slide in presentation" :key="slide.number" class="rounded-2xl border border-[#e8eaed] bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
							<h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-[#5f6368] dark:text-slate-400">
								{{ t('preview.slide', { n: slide.number }) }}
							</h3>
							<div v-if="slide.images.length" class="mb-3 flex flex-wrap gap-3">
								<img v-for="(image, imageIndex) in slide.images" :key="imageIndex" :src="image" class="max-h-56 max-w-full rounded-lg border border-[#e8eaed] object-contain dark:border-slate-700" alt="" />
							</div>
							<div v-if="slide.texts.length" class="space-y-1 text-sm leading-relaxed">
								<p v-for="(line, lineIndex) in slide.texts" :key="lineIndex">{{ line }}</p>
							</div>
							<p v-else-if="!slide.images.length" class="text-sm text-[#5f6368] dark:text-slate-400">{{ t('preview.noContent') }}</p>
						</section>
					</div>
				</template>

				<div v-else class="grid min-h-[420px] place-items-center px-6 text-center text-sm text-[#5f6368] dark:text-slate-400">
					<div>
						<div class="mx-auto grid size-16 place-items-center rounded-full bg-[#e8f0fe] text-[#1a73e8] dark:bg-slate-800">
							<IconPlayerPlay :size="28" :stroke="1.8" />
						</div>
						<p class="mt-4">{{ t('preview.notAvailable') }}</p>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>