import { defineStore } from 'pinia';
import { api } from '../services/api';

function buildBreadcrumbs(currentPath) {
	const normalized = currentPath === '/' ? '/' : String(currentPath).replace(/^\/+|\/+$/g, '');
	if (normalized === '/') return [{ label: 'Root', path: '/' }];

	const segments = normalized.split('/').filter(Boolean);
	const breadcrumbs = [{ label: 'Root', path: '/' }];
	let pathAccumulator = '';

	segments.forEach((segment) => {
		pathAccumulator += `/${segment}`;
		breadcrumbs.push({
			label: segment,
			path: `${pathAccumulator}/`,
		});
	});

	return breadcrumbs;
}

export const useFileTreeStore = defineStore('fileTree', {
	state: () => ({
		currentPath: '/',
		pendingPath: null,
		pendingHighlightId: null,
		files: [],
		filteredFiles: [],
		searchResults: [],
		breadcrumbs: [{ label: 'Root', path: '/' }],
		searchTerm: '',
		isLoading: false,
		isSearching: false,
		isSearchMode: false,
		error: null,
		searchError: null,
	}),
	actions: {
		async loadFiles(path = this.currentPath) {
			this.isLoading = true;
			this.error = null;
			try {
				const { data } = await api.listFiles(path);
				this.currentPath = path;
				this.files = Array.isArray(data) ? data : [];
				if (!this.isSearchMode) {
					this.filteredFiles = this.files;
				}
				this.breadcrumbs = buildBreadcrumbs(path);
			} catch (error) {
				this.error = error.message;
			} finally {
				this.isLoading = false;
			}
		},
		applySearch(term) {
			// Local folder-only filter (kept for backwards compatibility).
			// Global search goes through searchGlobal() below.
			this.searchTerm = term ?? '';
			if (this.isSearchMode) return;
			const lowered = this.searchTerm.trim().toLowerCase();
			this.filteredFiles = !lowered
				? this.files
				: this.files.filter((file) =>
					String(file.display_name || file.file_name || '').toLowerCase().includes(lowered),
				);
		},
		setSearchTerm(term) {
			this.searchTerm = term ?? '';
		},
		async searchGlobal(term, options = {}) {
			const query = String(term ?? '').trim();
			this.searchTerm = term ?? '';
			if (!query) {
				this.clearSearch();
				return [];
			}
			this.isSearchMode = true;
			this.isSearching = true;
			this.searchError = null;
			try {
				const { data } = await api.searchFiles(query, options);
				const results = Array.isArray(data) ? data : [];
				this.searchResults = results;
				// Expose results through filteredFiles so existing
				// useFileListView sorting / type / owner filters keep working.
				this.filteredFiles = results;
				this.breadcrumbs = [{ label: `Search: "${query}"`, path: '/search' }];
				return results;
			} catch (error) {
				this.searchError = error.message;
				this.searchResults = [];
				this.filteredFiles = [];
				throw error;
			} finally {
				this.isSearching = false;
			}
		},
		clearSearch() {
			this.searchTerm = '';
			this.searchResults = [];
			this.searchError = null;
			this.isSearchMode = false;
			this.filteredFiles = this.files;
			this.breadcrumbs = buildBreadcrumbs(this.currentPath);
		},
		navigate(path) {
			if (this.isSearchMode) {
				this.searchTerm = '';
				this.searchResults = [];
				this.isSearchMode = false;
			}
			return this.loadFiles(path);
		},
	},
});
