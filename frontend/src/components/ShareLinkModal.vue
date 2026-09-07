<script setup>
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { IconX, IconCopy, IconCheck, IconLink } from '@tabler/icons-vue';
import { api } from '../services/api';

const props = defineProps({ open: { type: Boolean, default: false }, file: { type: Object, default: null } });
const emit = defineEmits(['close']);

const { t } = useI18n();
const token = ref('');
const url = ref('');
const expiresAt = ref(null);
const expiryDays = ref(7);
const password = ref('');
const errorRef = ref('');
const copied = ref(false);
const revoking = ref(false);
const creating = ref(false);

watch(() => props.open, (open) => {
	if (!open) return;
	token.value = '';
	url.value = '';
	expiresAt.value = null;
	errorRef.value = '';
	copied.value = false;
	password.value = '';
	expiryDays.value = 7;
});

async function create() {
	creating.value = true;
	errorRef.value = '';
	try {
		const { data } = await api.createShareLink({
			fileId: props.file.id,
			expiresInDays: expiryDays.value,
			password: password.value || undefined,
		});
		token.value = data.token;
		url.value = data.url;
		expiresAt.value = data.expiresAt;
	} catch (error) {
		errorRef.value = error.message;
	} finally {
		creating.value = false;
	}
}

async function copyUrl() {
	try {
		await navigator.clipboard.writeText(url.value);
		copied.value = true;
		setTimeout(() => { copied.value = false; }, 1500);
	} catch {
		// clipboard blocked — fall back to prompt-less select
	}
}

async function revoke() {
	revoking.value = true;
	try {
		await api.revokeShareLink(token.value);
		token.value = '';
		url.value = '';
	} catch (error) {
		errorRef.value = error.message;
	} finally {
		revoking.value = false;
	}
}
</script>

<template>
	<div v-if="open" class="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" @click.self="emit('close')">
		<div class="w-full max-w-md rounded-3xl bg-white p-6 shadow-xl dark:bg-slate-800">
			<div class="flex items-center justify-between">
				<h2 class="text-lg font-semibold">{{ t('share.title') }}</h2>
				<button type="button" class="grid size-9 place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/10" @click="emit('close')"><IconX :size="18" /></button>
			</div>

			<div v-if="errorRef" class="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-200">{{ errorRef }}</div>

			<div v-if="!token" class="mt-4 space-y-3">
				<label class="block text-sm font-medium">{{ t('share.expiry') }}</label>
				<select v-model="expiryDays" class="w-full rounded-xl border border-[#dfe6f1] bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900">
					<option :value="7">7 {{ t('common.days') }}</option>
					<option :value="30">30 {{ t('common.days') }}</option>
					<option :value="0">{{ t('share.noExpiry') }}</option>
				</select>
				<label class="block text-sm font-medium">{{ t('share.password') }} <span class="font-normal text-[#5f6368] dark:text-slate-400">({{ t('share.optional') }})</span></label>
				<input v-model="password" type="password" class="w-full rounded-xl border border-[#dfe6f1] px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900" />
				<button type="button" class="mt-2 w-full rounded-full bg-[#1a73e8] py-2.5 text-sm font-semibold text-white disabled:opacity-50" :disabled="creating" @click="create">{{ t('share.create') }}</button>
			</div>

			<div v-else class="mt-4 space-y-3">
				<div class="flex items-center gap-2 rounded-xl bg-[#e8f0fe] px-3 py-2 dark:bg-sky-500/15">
					<IconLink :size="18" class="shrink-0 text-[#1a73e8] dark:text-blue-300" />
					<input :value="url" readonly class="min-w-0 flex-1 bg-transparent text-sm outline-none" />
					<button type="button" class="grid size-8 shrink-0 place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/10" :title="t('share.copy')" @click="copyUrl">
						<IconCheck v-if="copied" :size="16" class="text-green-600" />
						<IconCopy v-else :size="16" />
					</button>
				</div>
				<p class="text-xs text-[#5f6368] dark:text-slate-400">{{ expiresAt ? `${t('share.expires')}: ${new Date(expiresAt).toLocaleString()}` : t('share.noExpiry') }}</p>
				<button type="button" class="w-full rounded-full border border-[#c5221f] py-2 text-sm font-semibold text-[#c5221f] disabled:opacity-50" :disabled="revoking" @click="revoke">{{ t('share.revoke') }}</button>
			</div>
		</div>
	</div>
</template>